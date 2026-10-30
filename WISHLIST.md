# Skylight connector wish list

Features for the hosted (Cloudflare Worker) connector, from a test run of the
cloud connector on 2026-10-30. Test details live outside this repo in
`connector-appendix.md`, "Operational notes — Skylight (cloud)".

When an item ships, check it off here in the same commit as the code. The
Inbox Manager re-tests checked items on its next run.

This repo is public: keep names, member/category ids, email addresses and
event ids out of this file.

## Build order

1. [x] **Foundation for unattended runs.**
   - `healthcheck` tool: returns frame id, household timezone and connector
     version. Fails fast when Skylight is unreachable, so a 6 a.m. run logs
     "connector down" instead of stalling.
   - Every write returns the id of the object it created or changed, so the
     run log can record it and a retry does not create a duplicate.
   - Errors come back as plain text with Skylight's message (the 422 body),
     not a bare status code.
2. [x] **`get_list_items` returns ids.** Each item: `id`, `label`, `section`,
   `completed` (true/false), and `created_at` if the API has it. Without ids
   nothing can be checked off. This also unlocks the existing
   `update_list_item`.
3. [x] **Fix `create_list_item`.** Today it fails HTTP 422 "Label can't be
   blank", by list name and by list id. Accept `listId` plus `label` (and
   optional `section`); return the new item's id. This is the one write the
   rulebook needs on every run.
4. [x] **Times without an offset use the frame's timezone.**
   `create_calendar_event` and `update_calendar_event` read
   `2026-10-31T06:00:00` as UTC, so the event landed at midnight. Treat a bare
   local time as the frame's own timezone; keep accepting explicit offsets.
5. [x] **Family member ids, then chores.** `get_family_members` returns each
   member's category id. Then fix `create_chore`, which fails "Category is
   required": resolve the assignee name to its category id before posting.
6. [x] **Small fixes while in that code.**
   - `create_task` fails "summary can't be blank" (probably the same
     body-shape problem as item 3).
   - `get_chores` prints "Invalid Date" for undated chores; print "no date".
7. [x] **`get_calendar_events` returns assignees.** Include the assigned
   category ids and names on each event, if Skylight's API exposes them. This
   is the one thing the frame adds over the source calendars, and the weekly
   plan needs "who is driving". Today the run guesses from whose calendar holds
   the event.
8. [x] **Member filter on `find_free_slots` and `find_conflicts`.** Optional
   `member` (name or category id) so the tools look only at that person's
   events. Depends on item 7. Until then, availability comes from the Google
   and Outlook calendars, not these tools.

All build-order items shipped as of v1.9.0 (2026-10-30).

## Cut, and why

- **Narrow `delete_calendar_event`** (decided 2026-10-30): the hosted connector
  keeps no delete at all. The only events it could safely remove are
  Skylight-native ones, which agents are told not to create, so it would
  rarely help, and it would be the first way an unattended run could destroy
  calendar data. Clean up in the Skylight app.
- **Calendar picker on `create_calendar_event`:** the Google Calendar connector
  already writes to the household's Google calendar and the frame picks it up
  by sync. Agents should not create Skylight-native events.
- **One-call check-off:** `update_list_item` covers it once ids exist (item 2).
- **"New since" tool for lists:** new-since belongs in the run log, not the
  connector.
- **Delete for list items and chores:** low hazard, low value; checking an item
  off covers the job.
