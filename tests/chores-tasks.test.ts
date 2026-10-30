import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { formatDateForDisplay } from "../src/utils/dates.js";

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
  { type: "category", id: "26", attributes: { label: "Alexis", color: null, selected_for_chore_chart: true, linked_to_profile: true, profile_pic_url: null } },
  { type: "category", id: "27", attributes: { label: "Sam", color: null, selected_for_chore_chart: true, linked_to_profile: true, profile_pic_url: null } },
];

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** Route Skylight calls; `writes` gets every non-GET. */
function stub(onWrite: (call: Call) => unknown, chores: unknown[] = []): Call[] {
  const writes: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init.method ?? "GET";
      if (method === "GET") {
        if (path === "/api/frames/frame-1") return Response.json({ data: { type: "frame", id: "frame-1", attributes: { timezone: "America/Denver" } } });
        if (path.endsWith("/categories")) return Response.json({ data: CATEGORIES });
        if (path.endsWith("/chores")) return Response.json({ data: chores });
        return Response.json({ data: [] });
      }
      const call = { method, path, body: init.body ? JSON.parse(String(init.body)) : undefined };
      writes.push(call);
      return Response.json(onWrite(call));
    })
  );
  return writes;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const request = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(request, props, "test");
  const out = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: out.result.content[0].text, isError: out.result.isError ?? false };
}

const choreReply = (call: Call) => ({ data: { type: "chore", id: "900", attributes: { summary: call.body?.summary, start: call.body?.start, start_time: null } } });

afterEach(() => vi.unstubAllGlobals());

describe("family members", () => {
  it("lists each member's category ID", async () => {
    stub(() => ({}));
    const { text } = await callTool("get_family_members");
    expect(text).toContain("- Alex (category ID: 25)");
    expect(text).toContain("- Sam (category ID: 27)");
  });
});

describe("create_chore", () => {
  it("resolves the assignee and posts a flat body with category_id", async () => {
    const writes = stub(choreReply);
    const { text, isError } = await callTool("create_chore", { summary: "Dishes", date: "2026-10-31", assignee: "alex" });
    expect(isError).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/frames/frame-1/chores" });
    expect(writes[0].body).toEqual({ summary: "Dishes", start: "2026-10-31", category_id: "25" });
    expect(text).toContain("(ID: 900)");
    expect(text).toContain("Assigned to: Alex (category ID: 25)");
  });

  it("accepts a category ID as the assignee", async () => {
    const writes = stub(choreReply);
    await callTool("create_chore", { summary: "Trash", date: "2026-10-31", assignee: "27" });
    expect(writes[0].body).toMatchObject({ category_id: "27" });
  });

  it("refuses an ambiguous or unknown assignee without writing", async () => {
    const writes = stub(choreReply);
    const ambiguous = await callTool("create_chore", { summary: "Dishes", assignee: "Ale" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("matches more than one");
    const unknown = await callTool("create_chore", { summary: "Dishes", assignee: "Pat" });
    expect(unknown.text).toContain("Choose one of: Alex (category ID: 25)");
    expect(writes).toHaveLength(0);
  });

  it("creates recurring chores through create_multiple", async () => {
    const writes = stub((call) => ({ data: [choreReply(call).data] }));
    const { text, isError } = await callTool("create_chore", {
      summary: "Feed cat",
      date: "2026-10-31",
      assignee: "Sam",
      recurring: true,
      recurrencePattern: "daily",
    });
    expect(isError).toBe(false);
    expect(writes[0].path).toBe("/api/frames/frame-1/chores/create_multiple");
    expect(writes[0].body).toEqual({ summary: "Feed cat", start: "2026-10-31", category_ids: ["27"], recurrence_set: ["RRULE:FREQ=DAILY"] });
    expect(text).toContain("(ID: 900)");
  });
});

describe("update_chore", () => {
  it("completes through the completions endpoint", async () => {
    const writes = stub(() => ({}));
    const { text } = await callTool("update_chore", { choreId: "900", status: "completed" });
    expect(writes).toEqual([{ method: "PUT", path: "/api/frames/frame-1/chores/900/completions", body: { status: "complete" } }]);
    expect(text).toContain("Marked chore 900 complete");
  });

  it("completes a recurring occurrence on its base chore with the instance date", async () => {
    const writes = stub(() => ({}));
    await callTool("update_chore", { choreId: "900-2026-10-30", status: "completed" });
    expect(writes).toEqual([
      { method: "PUT", path: "/api/frames/frame-1/chores/900/completions", body: { status: "complete", instance_date: "2026-10-30" } },
    ]);
  });

  it("refuses to reopen a chore", async () => {
    const writes = stub(() => ({}));
    const { isError, text } = await callTool("update_chore", { choreId: "900", status: "pending" });
    expect(isError).toBe(true);
    expect(text).toContain("Skylight app");
    expect(writes).toHaveLength(0);
  });

  it("reassigns with a flat body", async () => {
    const writes = stub(choreReply);
    await callTool("update_chore", { choreId: "900", assignee: "Sam" });
    expect(writes[0]).toMatchObject({ method: "PUT", path: "/api/frames/frame-1/chores/900", body: { category_id: "27" } });
  });
});

describe("get_chores", () => {
  it("shows chore IDs, assignees, and 'no date' for undated chores", async () => {
    stub(() => ({}), [
      { type: "chore", id: "901", attributes: { summary: "Tidy", status: "pending", start: null, start_time: null }, relationships: { category: { data: { type: "category", id: "25" } } } },
    ]);
    const { text } = await callTool("get_chores");
    expect(text).toContain("- Tidy (ID: 901)");
    expect(text).toContain("Date: no date");
    expect(text).toContain("Assigned to: Alex (category ID: 25)");
    expect(text).not.toContain("Invalid Date");
  });

  it("filters done chores, which Skylight calls 'complete'", async () => {
    stub(() => ({}), [
      { type: "chore", id: "1", attributes: { summary: "Done one", status: "complete", start: "2026-10-30", start_time: null } },
      { type: "chore", id: "2", attributes: { summary: "Open one", status: "pending", start: "2026-10-30", start_time: null } },
    ]);
    const done = await callTool("get_chores", { status: "completed" });
    expect(done.text).toContain("Done one");
    expect(done.text).not.toContain("Open one");
    const open = await callTool("get_chores");
    expect(open.text).toContain("Open one");
    expect(open.text).not.toContain("Done one");
  });

  it("formatDateForDisplay never prints Invalid Date", () => {
    expect(formatDateForDisplay(null)).toBe("no date");
    expect(formatDateForDisplay("")).toBe("no date");
    expect(formatDateForDisplay("2026-10-31T00:00:00-06:00")).toMatch(/Sat.*Oct.*31/);
    expect(formatDateForDisplay("someday")).toBe("someday");
  });
});

describe("create_task", () => {
  it("posts a flat body and returns the task ID", async () => {
    const writes = stub((call) => ({ data: { type: "task_box_item", id: "77", attributes: { summary: call.body?.summary } } }));
    const { text, isError } = await callTool("create_task", { summary: "Call plumber" });
    expect(isError).toBe(false);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/frames/frame-1/task_box/items" });
    expect(writes[0].body).toEqual({ summary: "Call plumber", routine: false });
    expect(text).toContain('Created task: "Call plumber" (ID: 77)');
  });
});
