import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { describeHttpError, extractApiMessage } from "../src/utils/errors.js";
import { VERSION } from "../src/version.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Stub fetch with a router; records every call. */
function stubSkylight(route: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return route(call);
    })
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

afterEach(() => vi.unstubAllGlobals());

describe("healthcheck", () => {
  it("reports version, frame, timezones and warns when they differ", async () => {
    stubSkylight(() => json({ data: { type: "frame", id: "frame-1", attributes: { timezone: "America/Denver", plus: true } } }));
    const { text, isError } = await callTool("healthcheck");
    expect(isError).toBe(false);
    expect(text).toContain("Connector: OK");
    expect(text).toContain(`Version: ${VERSION}`);
    expect(text).toContain("Frame ID: frame-1");
    expect(text).toContain("Household timezone: America/Denver");
    expect(text).toContain("Connector timezone: America/Los_Angeles");
    expect(text).toContain("Skylight Plus: yes");
    expect(text).toContain("Warning:");
  });

  it("reports DOWN with the reason when Skylight is unreachable", async () => {
    stubSkylight(() => {
      throw new TypeError("fetch failed");
    });
    const { text, isError } = await callTool("healthcheck");
    expect(isError).toBe(true);
    expect(text).toContain("Connector: DOWN");
    expect(text).toContain("Could not reach Skylight: fetch failed");
  });

  it("reports a timeout as DOWN instead of hanging", async () => {
    stubSkylight(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const { text, isError } = await callTool("healthcheck");
    expect(isError).toBe(true);
    expect(text).toMatch(/did not respond within \d+s/);
  });
});

describe("list items", () => {
  it("get_list_items returns the list ID and each item's ID", async () => {
    stubSkylight(() =>
      json({
        data: { type: "list", id: "L1", attributes: { label: "House stuff", kind: "to_do" } },
        included: [
          { type: "list_item", id: "101", attributes: { label: "Fix gate", status: "pending", section: null, position: 1, created_at: "2026-10-29T15:00:00Z" } },
          { type: "list_item", id: "102", attributes: { label: "Bulbs", status: "completed", section: "Hardware", position: 2, created_at: null } },
        ],
      })
    );
    const { text } = await callTool("get_list_items", { listId: "L1", includeCompleted: true });
    expect(text).toContain("House stuff (list ID: L1):");
    expect(text).toContain("[ ] Fix gate (item ID: 101, added 2026-10-29T15:00:00Z)");
    expect(text).toContain("Hardware:\n[x] Bulbs (item ID: 102)");
  });

  it("create_list_item posts a flat body and returns the new item's ID", async () => {
    const calls = stubSkylight(() => json({ data: { type: "list_item", id: 555, attributes: { label: "Milk", status: "pending", section: "Dairy" } } }, 201));
    const { text, isError } = await callTool("create_list_item", { listId: "L1", label: "Milk", section: "Dairy" });
    expect(isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/frames/frame-1/lists/L1/list_items");
    expect(calls[0].body).toEqual({ label: "Milk", section: "Dairy" });
    expect(text).toContain("(item ID: 555, list ID: L1)");
  });

  it("create_list_item surfaces Skylight's 422 message", async () => {
    stubSkylight(() => json({ errors: [{ status: "422", detail: "Label can't be blank" }] }, 422));
    const { text, isError } = await callTool("create_list_item", { listId: "L1", label: "Milk" });
    expect(isError).toBe(true);
    expect(text).toContain("HTTP 422: Label can't be blank");
  });

  it("update_list_item PATCHes a flat body and returns the item ID", async () => {
    const calls = stubSkylight(() => json({ data: { type: "list_item", id: "101", attributes: { label: "Fix gate", status: "completed" } } }));
    const { text } = await callTool("update_list_item", { listId: "L1", itemId: "101", status: "completed" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual({ status: "completed" });
    expect(text).toContain("(item ID: 101) (marked complete)");
  });
});

describe("Skylight error text", () => {
  it("reads JSON:API, Rails-style and plain error bodies", () => {
    expect(extractApiMessage('{"errors":[{"detail":"Label can\'t be blank"}]}')).toBe("Label can't be blank");
    expect(extractApiMessage('{"errors":{"category":["is required"],"base":["Try again"]}}')).toBe("Category is required; Try again");
    expect(extractApiMessage('{"error":"invalid_token"}')).toBe("invalid_token");
    expect(extractApiMessage("<html>Bad Gateway</html>")).toBeNull();
  });

  it("falls back to the raw body, then the bare status", () => {
    expect(describeHttpError(502, "<html>Bad Gateway</html>")).toBe("HTTP 502: <html>Bad Gateway</html>");
    expect(describeHttpError(500, "")).toBe("HTTP 500");
  });
});
