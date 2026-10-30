import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { describeEventTimes, resolveAllDayEnd, resolveEventTime } from "../src/utils/event-times.js";

const TZ = "America/Denver";

describe("resolveEventTime", () => {
  it("reads a bare time as household time with that date's offset", () => {
    expect(resolveEventTime("2026-10-31T06:00", TZ, false)).toEqual({
      epoch: Date.parse("2026-10-31T12:00:00Z"),
      iso: "2026-10-31T06:00:00-06:00",
      note: undefined,
    });
    // Clocks fall back on Nov 1: two days later the offset is -07:00.
    expect(resolveEventTime("2026-11-02T06:00:00", TZ, false).iso).toBe("2026-11-02T06:00:00-07:00");
    expect(resolveEventTime("2026-11-02 6:00", TZ, false).iso).toBe("2026-11-02T06:00:00-07:00");
  });

  it("takes the first occurrence of an ambiguous fall-back time and says so", () => {
    const t = resolveEventTime("2026-11-01T01:30", TZ, false);
    expect(t.iso).toBe("2026-11-01T01:30:00-06:00");
    expect(t.note).toContain("happens twice");
  });

  it("rejects a time in the spring-forward gap", () => {
    expect(() => resolveEventTime("2026-03-08T02:30", TZ, false)).toThrow(/does not exist/);
  });

  it("honours an explicit offset and notes when it is not the household's", () => {
    const utc = resolveEventTime("2026-10-31T06:00:00Z", TZ, false);
    expect(utc.iso).toBe("2026-10-31T00:00:00-06:00");
    expect(utc.note).toContain("12:00 AM MDT");
    const local = resolveEventTime("2026-10-31T06:00:00-06:00", TZ, false);
    expect(local.iso).toBe("2026-10-31T06:00:00-06:00");
    expect(local.note).toBeUndefined();
    expect(resolveEventTime("2026-10-31T06:00-0600", TZ, false).note).toBeUndefined();
  });

  it("rejects inputs it cannot place", () => {
    expect(() => resolveEventTime("2026-10-31", TZ, false)).toThrow(/Add a time, or set allDay/);
    expect(() => resolveEventTime("tomorrow at 6", TZ, false)).toThrow(/YYYY-MM-DDTHH:MM/);
    expect(() => resolveEventTime("2026-10-31T25:00", TZ, false)).toThrow(/not a valid time/);
  });

  it("anchors all-day events at local midnight", () => {
    const start = resolveEventTime("2026-11-01", TZ, true);
    expect(start.iso).toBe("2026-11-01T00:00:00-06:00");
    expect(resolveAllDayEnd(start, "2026-11-01", TZ).iso).toBe("2026-11-02T00:00:00-07:00");
    expect(resolveAllDayEnd(start, undefined, TZ).iso).toBe("2026-11-02T00:00:00-07:00");
    expect(resolveAllDayEnd(start, "2026-11-03", TZ).iso).toBe("2026-11-03T00:00:00-07:00");
  });
});

describe("describeEventTimes", () => {
  it("reads back timed, overnight and all-day events", () => {
    const s = Date.parse("2026-10-31T12:00:00Z");
    expect(describeEventTimes(s, s + 30 * 60_000, false, TZ)).toBe("Sat, Oct 31, 6:00 AM–6:30 AM MDT");
    expect(describeEventTimes(Date.parse("2026-11-01T05:00:00Z"), Date.parse("2026-11-01T09:00:00Z"), false, TZ)).toBe(
      "Sat, Oct 31, 11:00 PM MDT – Sun, Nov 1, 2:00 AM MST"
    );
    const day = Date.parse("2026-10-31T06:00:00Z");
    expect(describeEventTimes(day, Date.parse("2026-11-01T06:00:00Z"), true, TZ)).toBe("Sat, Oct 31 (all day)");
    expect(describeEventTimes(day, Date.parse("2026-11-02T07:00:00Z"), true, TZ)).toBe("Sat, Oct 31 – Sun, Nov 1 (all day)");
  });
});

describe("calendar tools", () => {
  const props: SkylightProps = {
    accessToken: "test-access-1",
    refreshToken: "test-refresh-1",
    fingerprint: "fp",
    expiresAt: Date.now() + 3_600_000,
    frameId: "frame-1",
    timezone: "America/Los_Angeles", // chosen at sign-in; the frame's zone should win
    hasPlus: true,
  };
  const posted: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

  function stub() {
    posted.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(String(url));
        if (u.pathname === "/api/frames/frame-1") {
          return Response.json({ data: { type: "frame", id: "frame-1", attributes: { timezone: TZ } } });
        }
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        posted.push({ method: init.method ?? "GET", url: u.pathname, body });
        // Echo back the way Skylight does: household-local ISO with offset.
        return Response.json({
          data: { type: "calendar_event", id: "E1", attributes: { starts_at: body.starts_at, ends_at: body.ends_at, all_day: body.all_day ?? false } },
        });
      })
    );
  }

  async function call(name: string, args: Record<string, unknown>) {
    const request = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await handleMcpRequest(request, props, "test");
    const out = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { text: out.result.content[0].text, isError: out.result.isError ?? false };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("create sends household-offset times and reads them back", async () => {
    stub();
    const { text, isError } = await call("create_calendar_event", { summary: "Test", startsAt: "2026-10-31T06:00", endsAt: "2026-10-31T06:30" });
    expect(isError).toBe(false);
    expect(posted[0].body).toMatchObject({ starts_at: "2026-10-31T06:00:00-06:00", ends_at: "2026-10-31T06:30:00-06:00", timezone: TZ });
    expect(text).toContain("(ID: E1)");
    expect(text).toContain("Saved: Sat, Oct 31, 6:00 AM–6:30 AM MDT (America/Denver)");
  });

  it("create refuses a spring-forward gap without writing", async () => {
    stub();
    const { text, isError } = await call("create_calendar_event", { summary: "Test", startsAt: "2026-03-08T02:30", endsAt: "2026-03-08T03:30" });
    expect(isError).toBe(true);
    expect(text).toContain("does not exist");
    expect(posted).toHaveLength(0);
  });

  it("update converts times, sends the zone, and notes a UTC input", async () => {
    stub();
    const { text } = await call("update_calendar_event", { eventId: "E1", startsAt: "2026-10-31T13:00:00Z", endsAt: "2026-10-31T14:00:00Z" });
    expect(posted[0].method).toBe("PUT");
    expect(posted[0].body).toMatchObject({ starts_at: "2026-10-31T07:00:00-06:00", ends_at: "2026-10-31T08:00:00-06:00", timezone: TZ });
    expect(text).toContain("Saved: Sat, Oct 31, 7:00 AM–8:00 AM MDT");
    expect(text).toContain("Note:");
  });

  it("update without times sends no times", async () => {
    stub();
    await call("update_calendar_event", { eventId: "E1", summary: "Renamed" });
    expect(posted[0].body).toEqual({ summary: "Renamed" });
  });
});
