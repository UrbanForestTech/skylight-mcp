import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { eventCategoryIds } from "../src/api/endpoints/calendar.js";
import type { CalendarEventResource } from "../src/api/types.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Denver",
  hasPlus: true,
};

const category = (id: string, label: string, person: boolean) => ({
  type: "category",
  id,
  attributes: { label, color: null, selected_for_chore_chart: person, linked_to_profile: person, profile_pic_url: null },
});

const event = (id: string, relationships?: CalendarEventResource["relationships"]) => ({
  type: "calendar_event",
  id,
  attributes: { summary: `Event ${id}`, starts_at: "2026-10-30T09:00:00.000-06:00" },
  ...(relationships ? { relationships } : {}),
});

function stub(eventsDoc: unknown, categories: unknown[] = []): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      urls.push(u.pathname + u.search);
      if (u.pathname === "/api/frames/frame-1") return Response.json({ data: { type: "frame", id: "frame-1", attributes: { timezone: "America/Denver" } } });
      if (u.pathname.endsWith("/categories")) return Response.json({ data: categories });
      return Response.json(eventsDoc);
    })
  );
  return urls;
}

async function events(): Promise<string> {
  const request = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_calendar_events", arguments: { date: "2026-10-30" } } }),
  });
  const res = await handleMcpRequest(request, props, "test");
  const out = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return out.result.content[0].text;
}

afterEach(() => vi.unstubAllGlobals());

describe("eventCategoryIds", () => {
  it("reads the categories relationship, an empty one, the attribute, or nothing", () => {
    const base = { type: "calendar_event" as const, attributes: {} };
    expect(eventCategoryIds({ ...base, id: "1", relationships: { categories: { data: [{ type: "category", id: "25" }] } } })).toEqual(["25"]);
    expect(eventCategoryIds({ ...base, id: "2", relationships: { categories: { data: [] } } })).toEqual([]);
    expect(eventCategoryIds({ ...base, id: "3", attributes: { category_ids: [26] } })).toEqual(["26"]);
    expect(eventCategoryIds({ ...base, id: "4" })).toBeNull();
  });
});

describe("get_calendar_events assignees", () => {
  it("requests categories and splits people from other categories", async () => {
    const urls = stub({
      data: [event("E1", { categories: { data: [{ type: "category", id: "25" }, { type: "category", id: "40" }] } })],
      included: [category("25", "Alex", true), category("40", "Soccer team", false)],
    });
    const text = await events();
    expect(urls.some((u) => u.includes("/calendar_events") && u.includes("include=categories"))).toBe(true);
    expect(text).toContain("assigned_to: Alex (category ID: 25)");
    expect(text).toContain("other_categories: Soccer team (category ID: 40)");
  });

  it("says nobody when the assignment is empty, unknown when absent", async () => {
    stub({ data: [event("E1", { categories: { data: [] } }), event("E2")] });
    const text = await events();
    expect(text).toMatch(/Event E1[\s\S]*assigned_to: nobody/);
    expect(text).toMatch(/Event E2[\s\S]*assigned_to: unknown/);
  });

  it("names assignees from the family list when Skylight includes no categories", async () => {
    stub({ data: [event("E1", { categories: { data: [{ type: "category", id: "27" }] } })] }, [category("27", "Sam", true)]);
    expect(await events()).toContain("assigned_to: Sam (category ID: 27)");
  });
});
