import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getChores, createChore, updateChore, completeChore, deleteChore } from "../api/endpoints/chores.js";
import { getCategories, resolveCategory } from "../api/endpoints/categories.js";
import { getTodayDate, getDateOffset, parseDate, parseTime, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { getHouseholdTimezone } from "../api/endpoints/frames.js";

export function registerChoreTools(server: McpServer): void {
  // get_chores tool
  server.tool(
    "get_chores",
    `Get chores from Skylight.

Use this to answer:
- "What chores do I need to do today?"
- "Show me this week's chores"
- "What's on the chore chart?"
- "What chores does [name] have?"

Returns chores with their assignees, due dates, and completion status.`,
    {
      date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD or 'today'). Defaults to today."),
      dateEnd: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD). Defaults to 7 days from start."),
      includeLate: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include overdue chores from past dates"),
      assignee: z
        .string()
        .optional()
        .describe("Filter by family member name (e.g., 'Dad', 'Mom')"),
      status: z
        .enum(["pending", "completed", "all"])
        .optional()
        .default("pending")
        .describe("Filter by completion status"),
    },
    async ({ date, dateEnd, includeLate, assignee, status }) => {
      try {
        const tz = await getHouseholdTimezone();
        const startDate = date ? parseDate(date, tz) : getTodayDate(tz);
        const endDate = dateEnd ? parseDate(dateEnd, tz) : getDateOffset(7, tz);

        const result = await getChores({
          after: startDate,
          before: endDate,
          includeLate: includeLate ?? true,
        });

        let chores = result.chores;

        // Filter by status
        if (status !== "all") {
          // Skylight reports a done chore as "complete"; accept either spelling.
          const done = (s: string) => s === "complete" || s === "completed";
          chores = chores.filter((chore) => (status === "completed" ? done(chore.attributes.status) : !done(chore.attributes.status)));
        }

        // Build category lookup for assignee names. Chores come back without
        // their categories included, so fall back to the family list.
        const categories = result.categories.length > 0 ? result.categories : await getCategories().catch(() => []);
        const categoryMap = new Map(categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));

        // Filter by assignee if specified
        if (assignee) {
          const lowerAssignee = assignee.toLowerCase();
          chores = chores.filter((chore) => {
            const categoryId = chore.relationships?.category?.data?.id;
            if (!categoryId) return false;
            const categoryName = categoryMap.get(categoryId)?.toLowerCase();
            return categoryName && categoryName.includes(lowerAssignee);
          });
        }

        if (chores.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${status === "all" ? "" : status + " "}chores found${assignee ? ` for ${assignee}` : ""}.`,
              },
            ],
          };
        }

        // Format chores for display
        const choreList = chores
          .map((chore) => {
            const attrs = chore.attributes;
            const categoryId = chore.relationships?.category?.data?.id;
            const assigneeName = categoryId ? categoryMap.get(categoryId) : null;

            const parts = [
              `- ${attrs.summary} (ID: ${chore.id})`,
              `  Date: ${formatDateForDisplay(attrs.start)}${attrs.start_time ? ` at ${attrs.start_time}` : ""}`,
              `  Status: ${attrs.status}`,
            ];

            if (assigneeName) {
              parts.push(`  Assigned to: ${assigneeName} (category ID: ${categoryId})`);
            } else if (categoryId) {
              parts.push(`  Assigned to: category ID ${categoryId}`);
            }

            if (attrs.recurring) {
              parts.push(`  Recurring: Yes${attrs.recurrence_set ? ` (${attrs.recurrence_set})` : ""}`);
            }

            if (attrs.reward_points) {
              parts.push(`  Reward points: ${attrs.reward_points}`);
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Chores:\n\n${choreList}`,
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

  // create_chore tool
  server.tool(
    "create_chore",
    `Add a new chore to Skylight.

Use this when the user wants to:
- Add a new task like "empty the dishwasher"
- Assign chores to family members
- Create recurring chores

Every chore needs an assignee: a family member's name or category ID from
get_family_members. The chore will appear on the Skylight display.

Returns: The chore ID, date and assignee.`,
    {
      summary: z.string().describe("Chore description (e.g., 'Empty the dishwasher')"),
      date: z
        .string()
        .optional()
        .describe("Due date (YYYY-MM-DD or 'today', 'tomorrow', day name). Defaults to today."),
      time: z
        .string()
        .optional()
        .describe("Due time (e.g., '10:00 AM', '14:30'). Optional."),
      assignee: z
        .string()
        .describe("Family member to assign: name or category ID from get_family_members (required by Skylight)"),
      recurring: z
        .boolean()
        .optional()
        .default(false)
        .describe("Is this a recurring chore?"),
      recurrencePattern: z
        .string()
        .optional()
        .describe("For recurring: 'daily', 'weekly', 'weekdays', or RRULE string"),
      rewardPoints: z
        .number()
        .optional()
        .describe("Reward points for completing this chore"),
    },
    async ({ summary, date, time, assignee, recurring, recurrencePattern, rewardPoints }) => {
      try {
        const tz = await getHouseholdTimezone();
        const choreDate = date ? parseDate(date, tz) : getTodayDate(tz);

        // Resolve assignee to category ID before posting: Skylight requires one.
        const resolved = await resolveCategory(assignee);
        if (!resolved.ok) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            isError: true,
          };
        }
        const category = resolved.category;

        // Convert simple recurrence patterns to RRULE
        let recurrenceSet: string | undefined;
        if (recurring && recurrencePattern) {
          const pattern = recurrencePattern.toLowerCase();
          if (pattern === "daily") {
            recurrenceSet = "RRULE:FREQ=DAILY";
          } else if (pattern === "weekly") {
            recurrenceSet = "RRULE:FREQ=WEEKLY";
          } else if (pattern === "weekdays") {
            recurrenceSet = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
          } else if (pattern.startsWith("RRULE:")) {
            recurrenceSet = pattern;
          } else {
            recurrenceSet = recurrencePattern;
          }
        }

        if (recurring && !recurrenceSet) {
          return {
            content: [{ type: "text" as const, text: "A recurring chore needs recurrencePattern ('daily', 'weekly', 'weekdays' or an RRULE)." }],
            isError: true,
          };
        }

        const startTime = time ? parseTime(time) : undefined;
        const chore = await createChore({
          summary,
          start: choreDate,
          startTime,
          categoryId: category.id,
          recurrenceSet,
          rewardPoints,
        });

        const savedStart = chore.attributes.start ?? choreDate;
        const savedTime = chore.attributes.start_time ?? startTime;
        const parts = [
          `Created chore: "${chore.attributes.summary ?? summary}" (ID: ${chore.id})`,
          `Date: ${formatDateForDisplay(savedStart)}${savedTime ? ` at ${savedTime}` : ""}`,
          `Assigned to: ${category.attributes.label ?? "Unnamed"} (category ID: ${category.id})`,
        ];

        if (recurrenceSet) {
          parts.push(`Recurring: ${recurrenceSet}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: parts.join("\n"),
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

  // update_chore tool
  server.tool(
    "update_chore",
    `Update an existing chore in Skylight.

Use this when:
- Marking a chore as complete: "Mark 'dishes' as done"
- Changing chore assignment: "Reassign the trash to Dad"
- Updating chore details: "Change the time for the homework chore"

Parameters:
- choreId (required): ID of the chore (from get_chores)
- summary: New description for the chore
- status: "completed" to mark done. Reopening a completed chore is done in
  the Skylight app.
- date: New due date. With status "completed" on a recurring chore, the
  occurrence to complete instead
- time: New due time
- assignee: New family member (name or category ID)

Returns: The chore ID and what changed.`,
    {
      choreId: z.string().describe("ID of the chore to update"),
      summary: z.string().optional().describe("New chore description"),
      status: z.enum(["pending", "completed"]).optional().describe("'completed' to mark done ('pending' is not supported by the API)"),
      date: z.string().optional().describe("New due date (YYYY-MM-DD or 'today', 'tomorrow'); with status 'completed', the occurrence to complete"),
      time: z.string().nullable().optional().describe("New due time (e.g., '10:00 AM', or null to clear)"),
      assignee: z.string().nullable().optional().describe("New family member: name or category ID (null to unassign)"),
      rewardPoints: z.number().nullable().optional().describe("New reward points (or null to clear)"),
    },
    async ({ choreId, summary, status, date, time, assignee, rewardPoints }) => {
      try {
        const tz = await getHouseholdTimezone();
        if (status === "pending") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Reopening a completed chore is not supported by the Skylight API the connector uses. Uncheck it in the Skylight app.",
              },
            ],
            isError: true,
          };
        }

        const updates: Parameters<typeof updateChore>[1] = {};
        const completing = status === "completed";
        const day = date !== undefined ? parseDate(date, tz) : undefined;

        if (summary !== undefined) updates.summary = summary;
        // When completing, `date` names the occurrence; it does not move the chore.
        if (day !== undefined && !completing) updates.start = day;
        if (time !== undefined) updates.startTime = time ? parseTime(time) : null;
        if (rewardPoints !== undefined) updates.rewardPoints = rewardPoints;

        // Handle assignee
        let assigneeText = "";
        if (assignee !== undefined) {
          if (assignee === null) {
            updates.categoryId = null;
            assigneeText = " (unassigned)";
          } else {
            const resolved = await resolveCategory(assignee);
            if (!resolved.ok) {
              return {
                content: [{ type: "text" as const, text: resolved.error }],
                isError: true,
              };
            }
            updates.categoryId = resolved.category.id;
            assigneeText = ` (assigned to ${resolved.category.attributes.label ?? "Unnamed"}, category ID: ${resolved.category.id})`;
          }
        }

        const lines: string[] = [];
        if (Object.keys(updates).length > 0) {
          const chore = await updateChore(choreId, updates);
          lines.push(`Updated chore: "${chore.attributes.summary ?? summary ?? choreId}" (ID: ${chore.id})${assigneeText}`);
        }
        if (completing) {
          // A recurring chore's occurrence ID is "<choreId>-<YYYY-MM-DD>": complete
          // that occurrence on the base chore.
          const occurrence = /^(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(choreId);
          if (occurrence) {
            await completeChore(occurrence[1], day ?? occurrence[2]);
          } else {
            await completeChore(choreId, day);
          }
          lines.push(`Marked chore ${choreId} complete${day ? ` for ${formatDateForDisplay(day)}` : ""}`);
        }
        if (lines.length === 0) {
          lines.push(`Nothing to change on chore ${choreId}.`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
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

  // delete_chore tool
  server.tool(
    "delete_chore",
    `Delete a chore from Skylight.

Use this when:
- Removing an old or irrelevant chore
- Deleting a chore that was added by mistake

Parameters:
- choreId (required): ID of the chore to delete (from get_chores)

Note: This permanently removes the chore. For recurring chores, this may only delete one instance.`,
    {
      choreId: z.string().describe("ID of the chore to delete"),
    },
    async ({ choreId }) => {
      try {
        await deleteChore(choreId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted chore (ID: ${choreId})`,
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
