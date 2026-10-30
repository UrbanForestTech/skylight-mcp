import { getClient } from "../client.js";
import type {
  ChoresResponse,
  ChoreResource,
  CategoryResource,
  CreateChoreRequest,
  CreateRecurringChoreRequest,
  UpdateChoreRequest,
} from "../types.js";
import { ParseError } from "../../utils/errors.js";

export interface GetChoresOptions {
  after?: string;
  before?: string;
  includeLate?: boolean;
  filterLinkedToProfile?: boolean;
}

export interface GetChoresResult {
  chores: ChoreResource[];
  categories: CategoryResource[];
}

/**
 * Get chores for a date range
 */
export async function getChores(options: GetChoresOptions = {}): Promise<GetChoresResult> {
  const client = getClient();
  const params: Record<string, string | boolean | undefined> = {
    after: options.after,
    before: options.before,
    include_late: options.includeLate,
  };

  if (options.filterLinkedToProfile) {
    params.filter = "linked_to_profile";
  }

  const response = await client.get<ChoresResponse>(
    "/api/frames/{frameId}/chores",
    params
  );

  return {
    chores: response.data,
    categories: response.included ?? [],
  };
}

/**
 * Pull the chore out of a create/update response: JSON:API `data` (one
 * resource or, from create_multiple, a list) or a bare resource.
 */
function choreFrom(response: unknown): ChoreResource {
  const body = response as { data?: unknown } | null;
  const data = body && typeof body === "object" && "data" in body ? body.data : body;
  const chore = (Array.isArray(data) ? data[0] : data) as ChoreResource | undefined;
  if (!chore?.id) {
    throw new ParseError("Skylight accepted the chore but did not return its ID.");
  }
  return { ...chore, id: String(chore.id), attributes: chore.attributes ?? ({} as ChoreResource["attributes"]) };
}

export interface CreateChoreOptions {
  summary: string;
  /** Required: Skylight rejects a chore without an assignee. */
  categoryId: string;
  start: string;
  startTime?: string;
  /** RRULE, with or without the "RRULE:" prefix. Makes the chore recurring. */
  recurrenceSet?: string;
  rewardPoints?: number;
  emojiIcon?: string;
}

/**
 * Create a chore. A one-off chore is POST /chores; a recurring one must go
 * through /chores/create_multiple, which takes category_ids and a
 * recurrence_set list.
 */
export async function createChore(options: CreateChoreOptions): Promise<ChoreResource> {
  const client = getClient();
  const common = {
    summary: options.summary,
    start: options.start,
    ...(options.startTime ? { start_time: options.startTime } : {}),
    ...(options.rewardPoints !== undefined ? { reward_points: options.rewardPoints } : {}),
    ...(options.emojiIcon ? { emoji_icon: options.emojiIcon } : {}),
  };

  if (options.recurrenceSet) {
    const rule = options.recurrenceSet.replace(/^RRULE:/i, "");
    const request: CreateRecurringChoreRequest = {
      ...common,
      category_ids: [options.categoryId],
      recurrence_set: [`RRULE:${rule}`],
    };
    return choreFrom(await client.post<unknown>("/api/frames/{frameId}/chores/create_multiple", request));
  }

  const request: CreateChoreRequest = { ...common, category_id: options.categoryId };
  return choreFrom(await client.post<unknown>("/api/frames/{frameId}/chores", request));
}

export interface UpdateChoreOptions {
  summary?: string;
  start?: string;
  startTime?: string | null;
  categoryId?: string | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Update an existing chore's details (not its completion; see completeChore)
 */
export async function updateChore(
  choreId: string,
  options: UpdateChoreOptions
): Promise<ChoreResource> {
  const client = getClient();

  const request: UpdateChoreRequest = {};
  if (options.summary !== undefined) request.summary = options.summary;
  if (options.start !== undefined) request.start = options.start;
  if (options.startTime !== undefined) request.start_time = options.startTime;
  if (options.categoryId !== undefined) request.category_id = options.categoryId;
  if (options.rewardPoints !== undefined) request.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) request.emoji_icon = options.emojiIcon;

  const response = await client.request<unknown>(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "PUT",
    body: request,
  });
  return choreFrom(response);
}

/**
 * Mark a chore done. Completion has its own endpoint: a status sent with the
 * chore update is ignored. For a recurring chore, instanceDate picks the
 * occurrence.
 */
export async function completeChore(choreId: string, instanceDate?: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}/completions`, {
    method: "PUT",
    body: instanceDate ? { status: "complete", instance_date: instanceDate } : { status: "complete" },
  });
}

/**
 * Delete a chore
 */
export async function deleteChore(choreId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "DELETE",
  });
}
