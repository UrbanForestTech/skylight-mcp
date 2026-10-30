import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getClient } from "../api/client.js";
import { getFrame } from "../api/endpoints/frames.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { VERSION } from "../version.js";

/** Short on purpose: an unattended run should log "down" quickly, not wait out the default timeout. */
const HEALTHCHECK_TIMEOUT_MS = 8_000;

export function registerHealthTools(server: McpServer): void {
  server.tool(
    "healthcheck",
    `Check that the Skylight connector is up before doing anything else.

Returns the connector version, frame ID, the household's timezone and the
timezone the connector reads bare times in. Fails fast (about 8 seconds) with
"Connector: DOWN" and the reason when Skylight is unreachable or the sign-in
has expired, so a scheduled run can log it and stop instead of stalling.`,
    {},
    async () => {
      const client = getClient();
      const started = Date.now();
      const head = [`Version: ${VERSION}`, `Frame ID: ${client.frameId}`];
      try {
        const frame = await getFrame({ timeoutMs: HEALTHCHECK_TIMEOUT_MS });
        const attrs = frame.attributes;
        const householdTz = typeof attrs.timezone === "string" ? attrs.timezone : "unknown";
        const lines = [
          "Connector: OK",
          ...head,
          `Household timezone: ${householdTz}`,
          `Connector timezone: ${client.timezone}`,
        ];
        if (typeof attrs.plus === "boolean") lines.push(`Skylight Plus: ${attrs.plus ? "yes" : "no"}`);
        lines.push(`Response time: ${Date.now() - started} ms`);
        if (householdTz !== "unknown" && householdTz !== client.timezone) {
          lines.push(
            `\nWarning: bare times are read as ${client.timezone}, but the household is on ${householdTz}. ` +
              "Reconnect and choose the household's timezone."
          );
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        const lines = ["Connector: DOWN", ...head, `Reason: ${formatErrorForMcp(error)}`];
        return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: true };
      }
    }
  );
}
