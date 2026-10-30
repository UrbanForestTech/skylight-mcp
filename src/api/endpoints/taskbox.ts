import { getClient } from "../client.js";
import type {
  TaskBoxItemResponse,
  TaskBoxItemResource,
  CreateTaskBoxItemRequest,
} from "../types.js";
import { ParseError } from "../../utils/errors.js";

export interface CreateTaskBoxItemOptions {
  summary: string;
  emojiIcon?: string;
  routine?: boolean;
  rewardPoints?: number;
}

/**
 * Create a task box item
 * Task box items are unscheduled tasks that can later be assigned to specific dates
 */
export async function createTaskBoxItem(
  options: CreateTaskBoxItemOptions
): Promise<TaskBoxItemResource> {
  const client = getClient();

  const request: CreateTaskBoxItemRequest = {
    summary: options.summary,
    routine: options.routine ?? false,
    ...(options.emojiIcon ? { emoji_icon: options.emojiIcon } : {}),
    ...(options.rewardPoints !== undefined ? { reward_points: options.rewardPoints } : {}),
  };

  const response = await client.post<TaskBoxItemResponse | TaskBoxItemResource>(
    "/api/frames/{frameId}/task_box/items",
    request
  );

  const item = "data" in response ? response.data : response;
  if (!item?.id) {
    throw new ParseError("Skylight accepted the task but did not return its ID.");
  }
  return { ...item, id: String(item.id), attributes: item.attributes ?? { summary: options.summary } };
}
