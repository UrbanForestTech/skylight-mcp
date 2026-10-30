import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getCategories } from "../api/endpoints/categories.js";
import {
  eventCategoryIds,
  getCalendarEventsWithAssignees,
  getSourceCalendars,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "../api/endpoints/calendar.js";
import { getHouseholdTimezone } from "../api/endpoints/frames.js";
import type { CalendarEventResource } from "../api/types.js";
import { getTodayDate, parseDate, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import {
  describeEventTimes,
  isDateOnly,
  resolveAllDayEnd,
  resolveEventTime,
  type EventTime,
} from "../utils/event-times.js";

/**
 * "Saved: <when>" from the event Skylight returned (the truth), falling back
 * to what we sent, plus any notes about how the input was read.
 */
function savedLine(
  event: CalendarEventResource | undefined,
  sent: { start?: EventTime; end?: EventTime; allDay?: boolean },
  tz: string,
  notes: string[]
): string {
  const attrs = (event?.attributes ?? {}) as Record<string, unknown>;
  const parsed = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);
  const start = Number.isNaN(parsed(attrs.starts_at)) ? sent.start?.epoch : parsed(attrs.starts_at);
  const end = Number.isNaN(parsed(attrs.ends_at)) ? sent.end?.epoch : parsed(attrs.ends_at);
  const allDay = typeof attrs.all_day === "boolean" ? attrs.all_day : (sent.allDay ?? false);
  const lines: string[] = [];
  if (start !== undefined) {
    lines.push(`Saved: ${describeEventTimes(start, end ?? start, allDay, tz)} (${tz})`);
  }
  for (const note of notes) lines.push(`Note: ${note}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

export function registerCalendarTools(server: McpServer): void {
  // get_calendar_events tool
  server.tool(
    "get_calendar_events",
    `Get calendar events from Skylight.

Use this to answer questions like:
- "What's on my calendar today?"
- "What do we have scheduled this weekend?"
- "Are there any events on Friday?"

Returns a list of events with their titles, times, and details, including
assigned_to: the family members the event is assigned to on the frame (name
and category ID), which can differ from whose calendar it came from. Calendar
or group categories that are not people are listed as other_categories.`,
    {
      date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD or 'today', 'tomorrow', day name). Defaults to today."),
      dateEnd: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD). Defaults to same as start date."),
    },
    async ({ date, dateEnd }) => {
      try {
        const tz = await getHouseholdTimezone();
        const startDate = date ? parseDate(date, tz) : getTodayDate(tz);
        const endDate = dateEnd ? parseDate(dateEnd, tz) : startDate;

        const { events, categories: included } = await getCalendarEventsWithAssignees({
          dateMin: startDate,
          dateMax: endDate,
          timezone: tz,
        });
        const assigneeIds = new Map(events.map((e) => [e.id, eventCategoryIds(e)]));
        // Name the assignees from what Skylight included, else the family list.
        const needsNames = [...assigneeIds.values()].some((ids) => ids?.length);
        const categories = included.length > 0 || !needsNames ? included : await getCategories().catch(() => []);
        const byId = new Map(categories.map((c) => [c.id, c]));
        const label = (id: string) => `${byId.get(id)?.attributes.label ?? "Unknown"} (category ID: ${id})`;
        // Family members are profile-linked categories; the rest are calendar or group tags.
        const isPerson = (id: string) => byId.get(id)?.attributes.linked_to_profile !== false;

        if (events.length === 0) {
          const dateRange =
            startDate === endDate
              ? formatDateForDisplay(startDate)
              : `${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `No calendar events found for ${dateRange}.`,
              },
            ],
          };
        }

        // Format events for display
        const eventList = events
          .map((event) => {
            const attrs = event.attributes;
            const parts: string[] = [];

            // Add all available attributes
            for (const [key, value] of Object.entries(attrs)) {
              if (value !== null && value !== undefined) {
                parts.push(`  ${key}: ${value}`);
              }
            }

            // Who the event is assigned to on the frame (not whose calendar it came from)
            const ids = assigneeIds.get(event.id);
            if (ids === null || ids === undefined) {
              parts.push(`  assigned_to: unknown (Skylight sent no assignment)`);
            } else {
              const people = ids.filter(isPerson);
              const tags = ids.filter((id) => !isPerson(id));
              parts.push(`  assigned_to: ${people.length ? people.map(label).join(", ") : "nobody"}`);
              if (tags.length) parts.push(`  other_categories: ${tags.map(label).join(", ")}`);
            }

            return `- Event (ID: ${event.id})\n${parts.join("\n")}`;
          })
          .join("\n\n");

        const dateRange =
          startDate === endDate
            ? formatDateForDisplay(startDate)
            : `${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Calendar events for ${dateRange}:\n\n${eventList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_source_calendars tool
  server.tool(
    "get_source_calendars",
    `Get connected calendar sources synced to Skylight.

Use this to answer:
- "Which calendars are synced to Skylight?"
- "What calendar accounts are connected?"

Returns a list of connected calendar sources (Google, iCloud, etc.).`,
    {},
    async () => {
      try {
        const calendars = await getSourceCalendars();

        if (calendars.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No calendar sources are connected to Skylight.",
              },
            ],
          };
        }

        const calendarList = calendars
          .map((cal) => {
            const attrs = cal.attributes;
            const parts: string[] = [`- Calendar (ID: ${cal.id})`];

            for (const [key, value] of Object.entries(attrs)) {
              if (value !== null && value !== undefined) {
                parts.push(`  ${key}: ${value}`);
              }
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Connected calendar sources:\n\n${calendarList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // create_calendar_event tool
  server.tool(
    "create_calendar_event",
    `Create a new calendar event in Skylight.

Use this when:
- Scheduling a new event: "Add a dentist appointment on Friday at 2pm"
- Creating family activities: "Schedule soccer practice every Saturday at 10am"
- Adding reminders: "Put Mom's birthday on the calendar"

Times are household local time: send "2026-10-31T06:00" with no offset and
the connector applies the household timezone, including daylight-saving
changes. An explicit offset or "Z" is honoured as given.

Parameters:
- summary (required): Event title (e.g., "Dentist Appointment")
- startsAt (required): Start, YYYY-MM-DDTHH:MM household time (YYYY-MM-DD if allDay)
- endsAt (required): End, same format. For all-day events, the day after the
  last day, or the start date again for a one-day event
- allDay: Set to true for all-day events
- description: Additional notes for the event
- location: Where the event takes place
- categoryIds: Family member IDs to associate with the event

Returns: The event ID and the saved time read back in household time. Check
the readback before telling the user the event is booked.

Related: Use get_family_members to get category IDs for assignments.`,
    {
      summary: z.string().describe("Event title (e.g., 'Dentist Appointment')"),
      startsAt: z.string().describe("Start in household time, e.g. '2026-01-15T14:00' (no offset needed)"),
      endsAt: z.string().describe("End in household time, e.g. '2026-01-15T15:00'"),
      allDay: z.boolean().optional().default(false).describe("True for all-day events"),
      description: z.string().optional().describe("Additional notes for the event"),
      location: z.string().optional().describe("Event location"),
      categoryIds: z.array(z.string()).optional().describe("Family member IDs to assign"),
    },
    async ({ summary, startsAt, endsAt, allDay, description, location, categoryIds }) => {
      try {
        const tz = await getHouseholdTimezone();
        const start = resolveEventTime(startsAt, tz, allDay);
        const end = allDay ? resolveAllDayEnd(start, endsAt, tz) : resolveEventTime(endsAt, tz, false);
        if (!allDay && end.epoch <= start.epoch) {
          throw new Error(`End (${endsAt}) is not after start (${startsAt}).`);
        }
        const notes = [start.note, end.note].filter((n): n is string => Boolean(n));

        const event = await createCalendarEvent({
          summary,
          starts_at: start.iso,
          ends_at: end.iso,
          all_day: allDay,
          description,
          location,
          category_ids: categoryIds,
          timezone: tz,
          kind: "standard",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Created calendar event "${summary}" (ID: ${event.id})${savedLine(event, { start, end, allDay }, tz, notes)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // update_calendar_event tool
  server.tool(
    "update_calendar_event",
    `Update an existing calendar event.

Use this when:
- Changing event time: "Move the dentist appointment to 3pm"
- Updating event details: "Add location to the meeting"
- Renaming an event: "Change 'Doctor' to 'Dr. Smith checkup'"

Parameters:
- eventId (required): ID of the event to update (from get_calendar_events)
- summary: New title for the event
- startsAt: New start, YYYY-MM-DDTHH:MM household time (YYYY-MM-DD for all-day)
- endsAt: New end, same format
- description: Updated notes
- location: Updated location
- categoryIds: Updated family member assignments

Times are household local time, as in create_calendar_event; no offset needed.

Returns: The event ID and the saved time read back in household time.`,
    {
      eventId: z.string().describe("ID of the event to update"),
      summary: z.string().optional().describe("New event title"),
      startsAt: z.string().optional().describe("New start in household time, e.g. '2026-01-15T14:00'"),
      endsAt: z.string().optional().describe("New end in household time, e.g. '2026-01-15T15:00'"),
      allDay: z.boolean().optional().describe("Change to all-day event"),
      description: z.string().optional().describe("Updated notes"),
      location: z.string().optional().describe("Updated location"),
      categoryIds: z.array(z.string()).optional().describe("Updated family member assignments"),
    },
    async ({ eventId, summary, startsAt, endsAt, allDay, description, location, categoryIds }) => {
      try {
        const updates: Record<string, unknown> = {};
        if (summary !== undefined) updates.summary = summary;
        if (allDay !== undefined) updates.all_day = allDay;
        if (description !== undefined) updates.description = description;
        if (location !== undefined) updates.location = location;
        if (categoryIds !== undefined) updates.category_ids = categoryIds;

        // Convert times like create does. Without allDay, a bare date means all-day.
        const sent: { start?: EventTime; end?: EventTime; allDay?: boolean } = { allDay };
        const notes: string[] = [];
        let tz: string | undefined;
        if (startsAt !== undefined || endsAt !== undefined) {
          tz = await getHouseholdTimezone();
          const zone = tz;
          const dayMode = (input: string) => allDay ?? isDateOnly(input);
          if (startsAt !== undefined) sent.start = resolveEventTime(startsAt, zone, dayMode(startsAt));
          if (endsAt !== undefined) {
            sent.end =
              dayMode(endsAt) && sent.start
                ? resolveAllDayEnd(sent.start, endsAt, zone)
                : resolveEventTime(endsAt, zone, dayMode(endsAt));
          }
          if (sent.start && sent.end && sent.end.epoch <= sent.start.epoch) {
            throw new Error(`End (${endsAt}) is not after start (${startsAt}).`);
          }
          if (sent.start) updates.starts_at = sent.start.iso;
          if (sent.end) updates.ends_at = sent.end.iso;
          updates.timezone = zone;
          for (const t of [sent.start, sent.end]) if (t?.note) notes.push(t.note);
        }

        const event = await updateCalendarEvent(eventId, updates);
        const readback = savedLine(event, sent, tz ?? (await getHouseholdTimezone()), notes);

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated calendar event (ID: ${event.id})${readback}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_calendar_event tool
  server.tool(
    "delete_calendar_event",
    `Delete a calendar event from Skylight.

Use this when:
- Canceling an event: "Remove the dentist appointment"
- Deleting old events: "Delete the meeting from yesterday"

Parameters:
- eventId (required): ID of the event to delete (from get_calendar_events)

Note: This permanently removes the event. For recurring events, this may only delete one instance.`,
    {
      eventId: z.string().describe("ID of the event to delete"),
    },
    async ({ eventId }) => {
      try {
        await deleteCalendarEvent(eventId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted calendar event (ID: ${eventId})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );
}
