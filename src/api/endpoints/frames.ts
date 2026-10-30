import { getClient } from "../client.js";
import type { FrameResponse, FrameResource } from "../types.js";

/**
 * Get frame (household) information
 */
export async function getFrame(options: { timeoutMs?: number } = {}): Promise<FrameResource> {
  const client = getClient();
  const response = await client.request<FrameResponse>("/api/frames/{frameId}", { timeoutMs: options.timeoutMs });
  return response.data;
}
