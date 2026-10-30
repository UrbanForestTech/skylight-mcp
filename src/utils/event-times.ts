/**
 * Calendar event times in household wall-clock terms.
 *
 * Skylight reads a time without an offset as UTC and ignores the request's
 * `timezone` field, so a bare "06:00" lands at midnight in Denver. Every time
 * we send therefore carries the household zone's offset for that date
 * (DST-aware), and every confirmation reads the saved time back in that zone.
 */

import { addDays, dateInZone, formatDay, formatTime, offsetAt, toLocalParts, zonedToEpoch } from "./schedule.js";

export interface EventTime {
  epoch: number;
  /** ISO 8601 with the household offset, e.g. 2026-10-31T06:00:00-06:00 */
  iso: string;
  /** Something the caller should see: an ambiguous time, or an offset that is not the household's. */
  note?: string;
}

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const HOUR_MS = 3_600_000;

export function isDateOnly(input: string): boolean {
  return DATE_ONLY.test(input.trim());
}

/** ISO 8601 for an instant, written in the zone's local time with its offset. */
export function isoInZone(epochMs: number, timeZone: string): string {
  const p = toLocalParts(epochMs, timeZone);
  const offsetMin = Math.round(offsetAt(epochMs, timeZone) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}` +
    `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
}

/** "MDT" style abbreviation of the zone at an instant. */
export function zoneAbbreviation(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(epochMs));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/**
 * Turn a caller's event time into an instant.
 * - all-day: the date's local midnight (any time part is ignored)
 * - bare date-time: household wall-clock time; a time in the spring-forward
 *   gap is rejected, an ambiguous fall-back time takes the first occurrence
 * - explicit offset or Z: honoured as given, with a note if the offset is not
 *   the household's on that date
 */
export function resolveEventTime(input: string, timeZone: string, allDay: boolean): EventTime {
  const text = input.trim();

  if (allDay) {
    const date = DATE_ONLY.exec(text)?.[1] ?? DATE_TIME.exec(text)?.[1];
    if (!date) throw new Error(`"${input}" is not a date. Use YYYY-MM-DD for all-day events.`);
    const epoch = zonedToEpoch(date, "00:00", timeZone);
    return { epoch, iso: isoInZone(epoch, timeZone) };
  }

  const match = DATE_TIME.exec(text);
  if (!match) {
    const hint = isDateOnly(text) ? " Add a time, or set allDay: true." : "";
    throw new Error(`"${input}" is not a date and time. Use YYYY-MM-DDTHH:MM in household time (${timeZone}).${hint}`);
  }
  const [, date, hourText, minuteText, secondText = "00", offset] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`"${input}" is not a valid time of day.`);

  if (offset) {
    const normalized = offset.toUpperCase() === "Z" ? "Z" : offset.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
    const epoch = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${minuteText}:${secondText}${normalized}`);
    if (Number.isNaN(epoch)) throw new Error(`"${input}" is not a valid date and time.`);
    const given = normalized === "Z" ? 0 : (normalized.startsWith("-") ? -1 : 1) * (Number(normalized.slice(1, 3)) * 60 + Number(normalized.slice(4, 6))) * 60_000;
    const note =
      given !== offsetAt(epoch, timeZone)
        ? `"${input}" carries offset ${offset}, which is ${formatTime(epoch, timeZone)} ${zoneAbbreviation(epoch, timeZone)} household time. Send times without an offset to mean household time.`
        : undefined;
    return { epoch, iso: isoInZone(epoch, timeZone), note };
  }

  const wall = `${String(hour).padStart(2, "0")}:${minuteText}`;
  const epoch = zonedToEpoch(date, wall, timeZone) + second * 1000;
  const back = toLocalParts(epoch, timeZone);
  if (back.hour !== hour || back.minute !== minute || dateInZone(epoch, timeZone) !== date) {
    throw new Error(`${date} ${wall} does not exist in ${timeZone}: the clocks spring forward over it. Pick a time outside that hour.`);
  }
  const later = toLocalParts(epoch + HOUR_MS, timeZone);
  const note =
    later.hour === hour && later.minute === minute && dateInZone(epoch + HOUR_MS, timeZone) === date
      ? `${date} ${wall} happens twice in ${timeZone} (clocks fall back); used the first one, ${zoneAbbreviation(epoch, timeZone)}.`
      : undefined;
  return { epoch, iso: isoInZone(epoch, timeZone), note };
}

/**
 * Resolve an all-day end. Skylight's all-day end is the following midnight
 * (exclusive), so an end on or before the start day becomes start + 1 day.
 */
export function resolveAllDayEnd(start: EventTime, endInput: string | undefined, timeZone: string): EventTime {
  const startDate = dateInZone(start.epoch, timeZone);
  const end = endInput ? resolveEventTime(endInput, timeZone, true) : undefined;
  if (end && dateInZone(end.epoch, timeZone) > startDate) return end;
  const epoch = zonedToEpoch(addDays(startDate, 1), "00:00", timeZone);
  return { epoch, iso: isoInZone(epoch, timeZone) };
}

/**
 * Human readback of what was saved: "Sat, Oct 31, 6:00 AM–6:30 AM MDT",
 * "Sat, Oct 31 (all day)", or a two-day range when it crosses midnight.
 */
export function describeEventTimes(start: number, end: number, allDay: boolean, timeZone: string): string {
  const startDate = dateInZone(start, timeZone);
  if (allDay) {
    const lastDay = dateInZone(Math.max(start, end - 1), timeZone);
    return lastDay === startDate
      ? `${formatDay(startDate)} (all day)`
      : `${formatDay(startDate)} – ${formatDay(lastDay)} (all day)`;
  }
  const endDate = dateInZone(end, timeZone);
  if (endDate === startDate) {
    return `${formatDay(startDate)}, ${formatTime(start, timeZone)}–${formatTime(end, timeZone)} ${zoneAbbreviation(end, timeZone)}`;
  }
  return (
    `${formatDay(startDate)}, ${formatTime(start, timeZone)} ${zoneAbbreviation(start, timeZone)} – ` +
    `${formatDay(endDate)}, ${formatTime(end, timeZone)} ${zoneAbbreviation(end, timeZone)}`
  );
}
