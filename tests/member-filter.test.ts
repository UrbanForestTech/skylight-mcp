import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Denver",
  hasPlus: true,
};

const CATEGORIES = [
  { type: "category", id: "25", attributes: { label: "Alex", color: null, selected_for_chore_chart: true, linked_to_profile: true, profile_pic_url: null } },
  { type: "category", id: "27", attributes: { label: "Sam", color: null, selected_for_chore_chart: true, linked_to_profile: true, profile_pic_url: null } },
];

/** A timed event on Mon Nov 2 2026 (MST, -07:00) assigned to the given categories; undefined = no assignment data. */
function event(id: string, from: string, to: string, who?: string[]) {
  return {
    type: "calendar_event",
    id,
    attributes: { summary: id, all_day: false, starts_at: `2026-11-02T${from}:00.000-07:00`, ends_at: `2026-11-02T${to}:00.000-07:00` },
    ...(who ? { relationships: { categories: { data: who.map((c) => ({ type: "category", id: c })) } } } : {}),
  };
}

function stub(events: unknown[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      urls.push(u.pathname + u.search);
      if (u.pathname === "/api/frames/frame-1") return Response.json({ data: { type: "frame", id: "frame-1", attributes: { timezone: "America/Denver" } } });
      if (u.pathname.endsWith("/categories")) return Response.json({ data: CATEGORIES });
      return Response.json({ data: events, included: CATEGORIES });
    })
  );
  return urls;
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

const WEEK = [
  event("Alex work", "09:00", "10:00", ["25"]),
  event("Alex dentist", "09:30", "10:30", ["25"]),
  event("Sam class", "09:00", "10:00", ["27"]),
  event("Family dinner", "17:00", "18:00", ["25", "27"]),
];

describe("find_conflicts member filter", () => {
  it("counts only the member's events", async () => {
    stub(WEEK);
    const { text } = await call("find_conflicts", { date: "2026-11-02", days: 1, member: "Sam" });
    expect(text).toContain("No conflicts for Sam (category ID: 27)");

    const alex = await call("find_conflicts", { date: "2026-11-02", days: 1, member: "25" });
    expect(alex.text).toContain("Conflicts for Alex (category ID: 25)");
    expect(alex.text).toContain('"Alex work"');
    expect(alex.text).not.toContain("Sam class");
  });

  it("without member, every event counts", async () => {
    stub(WEEK);
    const { text } = await call("find_conflicts", { date: "2026-11-02", days: 1 });
    expect(text).toContain("Sam class");
  });

  it("refuses an unknown member", async () => {
    const urls = stub(WEEK);
    const { text, isError } = await call("find_conflicts", { date: "2026-11-02", days: 1, member: "Pat" });
    expect(isError).toBe(true);
    expect(text).toContain("No family member matches");
    expect(urls.some((u) => u.includes("/calendar_events"))).toBe(false);
  });
});

describe("find_free_slots member filter", () => {
  it("treats only the member's events as busy", async () => {
    stub(WEEK);
    const { text } = await call("find_free_slots", { date: "2026-11-02", days: 1, member: "Sam", earliest: "08:00", latest: "12:00", durationMinutes: 60 });
    expect(text).toContain("Free slots for Sam (category ID: 27)");
    expect(text).toContain("8:00 AM–9:00 AM");
    expect(text).toContain("10:00 AM–12:00 PM");
  });

  it("keeps events with no assignment data as busy and says so", async () => {
    stub([...WEEK, event("Unlabelled", "10:00", "12:00")]);
    const { text } = await call("find_free_slots", { date: "2026-11-02", days: 1, member: "Sam", earliest: "08:00", latest: "12:00", durationMinutes: 60 });
    expect(text).not.toContain("10:00 AM–12:00 PM");
    expect(text).toContain("1 event(s) had no assignment data");
  });
});
