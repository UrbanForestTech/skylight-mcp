import { getClient, type SkylightClient } from "../client.js";
import type { FrameResponse, FrameResource } from "../types.js";

/**
 * Get frame (household) information
 */
export async function getFrame(options: { timeoutMs?: number } = {}): Promise<FrameResource> {
  const client = getClient();
  const response = await client.request<FrameResponse>("/api/frames/{frameId}", { timeoutMs: options.timeoutMs });
  return response.data;
}

function validZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

const householdZones = new WeakMap<SkylightClient, Promise<string>>();

/**
 * The household's timezone as set on the frame: the zone Skylight shows
 * times in, so the one bare times mean. Falls back to the configured zone
 * (chosen at sign-in) when the frame has none or cannot be read. Cached per
 * client; a failed lookup is not cached.
 */
export function getHouseholdTimezone(): Promise<string> {
  const client = getClient();
  let zone = householdZones.get(client);
  if (!zone) {
    zone = getFrame()
      .then((frame) => validZone(frame?.attributes?.timezone) ?? client.timezone)
      .catch(() => {
        householdZones.delete(client);
        return client.timezone;
      });
    householdZones.set(client, zone);
  }
  return zone;
}
