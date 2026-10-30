# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-10-30

### Added

- **Event assignees**: `get_calendar_events` asks Skylight for each event's
  categories and shows `assigned_to` (the family members the event is assigned
  to on the frame, by name and category ID), which can differ from whose
  calendar it came from. Categories that are not people (calendar colours,
  group calendars) are listed separately as `other_categories`. An event with
  no assignment reads `nobody`; one Skylight sent no assignment data for reads
  `unknown`.

## [1.7.0] - 2026-10-30

### Fixed

- **`create_chore`** failed "Category is required": Skylight wants a flat body
  with `category_id`, not the JSON:API wrapper with a category relationship.
  The assignee (a name or category ID) is now required and resolved before
  posting; an ambiguous or unknown name fails with the family listed.
  Recurring chores go through `/chores/create_multiple`, the only endpoint that
  creates them.
- **`update_chore`** sends a flat body, and `status: "completed"` now uses the
  chore completions endpoint (a status in the chore update was ignored).
  Reopening a chore is refused with a pointer to the app instead of silently
  doing nothing.
- **`create_task`** failed "summary can't be blank": same wrapper problem; it now
  sends a flat body.
- `get_chores` printed "Invalid Date" for undated chores; it prints "no date".
- `get_chores` with `status: "completed"` returned nothing: Skylight reports
  done chores as `complete`.
- Completing a recurring chore by its occurrence ID (`<id>-<YYYY-MM-DD>`, as
  `get_chores` lists it) now completes that occurrence on the base chore.

### Added

- `get_family_members` shows each member's category ID; `get_chores` shows each
  chore's ID and its assignee's category ID.

### Changed

- The family-member cache is per client rather than per process, so a hosted
  server cannot serve one household's members to another.

## [1.6.0] - 2026-10-30

### Fixed

- **Calendar times without an offset landed in UTC.** Skylight reads a bare
  `2026-10-31T06:00` as UTC and ignores the request's `timezone`, so the event
  showed at midnight in Denver. `create_calendar_event` and
  `update_calendar_event` now send every time with the household offset for
  that date (DST-aware). Explicit offsets and `Z` are still honoured, with a
  note when they are not the household's. All-day events are anchored at local
  midnight, ending the following midnight.
- A time in the spring-forward gap is refused with a message; an ambiguous
  fall-back time takes the first occurrence and says so.

### Changed

- The household timezone (the frame's own setting) is now the one source of
  truth for calendar, planning, chores, meals and messages. The timezone chosen
  at sign-in is only a fallback when the frame's cannot be read.
- Calendar create and update confirmations read the saved time back, e.g.
  `Saved: Sat, Oct 31, 6:00 AM–6:30 AM MDT (America/Denver)`.

## [1.5.0] - 2026-10-30

### Added

- **`healthcheck`** tool: connector version, frame ID, household and connector
  timezones, and Plus status. Gives up after 8 seconds and reports
  `Connector: DOWN` with the reason, so unattended runs fail fast.
- **List item IDs**: `get_list_items` shows the list ID and each item's ID (and
  creation time when Skylight sends it), and accepts `listId`.

### Changed

- Every write tool's confirmation includes the ID of what it created or changed
  (`create_chore`, `update_chore`, `update_list`, `create_list_item`,
  `update_list_item` and `create_task` did not).
- Skylight errors show the API's own message (`HTTP 422: Label can't be blank`)
  instead of the raw JSON body.
- Requests time out after 20 seconds, and a network failure is reported as
  "Could not reach Skylight" rather than an uncaught exception.

### Fixed

- **`create_list_item`** failed with HTTP 422 "Label can't be blank": Skylight
  wants a flat `{label, section}` body, not the JSON:API `data.attributes`
  wrapper. `update_list_item` now sends a flat body with PATCH as well.

## [1.4.1] - 2026-10-29

### Fixed

- **Messages**: `get_messages` showed every message as "selected devices" and listed
  profile names instead of "everyone", and `update_message` would have refused
  every message. Messages need the newer `Skylight-Api-Version` that the web app
  sends (`2026-10-15`); under the repo-wide older version the responses omit
  `all_profiles`, `all_devices` and `voice_kind`. The messages endpoints now send
  the newer version; every other endpoint is unchanged.

## [1.4.0] - 2026-10-29

### Added

- **Messages**: `get_messages` (read) and `send_message` (write) for the notes
  shown on the frame. Endpoint and payload were taken from the web app's own
  calls. Sends are silent unless `readAloud` is set, go to everyone on all
  devices, and are capped at 300 characters. Skylight offers no way to delete a
  message, so `send_message` previews by default and posts only with an explicit
  `confirm: true` after the user has approved the text. Presigned audio URLs, which carry
  temporary storage credentials, are never returned.

- `update_message` edits a message's text or sender (PATCH with the whole form, as
  the web app does) for messages sent to everyone on all devices that don't repeat.
  Message IDs are validated as numeric before they reach a URL path.

### Not yet supported

- Targeting specific profiles or devices, scheduling, repeats and voice notes.
  The request fields for these have not been captured.

## [1.3.0] - 2026-10-29

### Added

- **Planning tools**: `get_week_overview`, `find_conflicts`, `find_free_slots`
  (all read-only) and `plan_week_meals` (write, with dry run). Chores and
  tasks are first-class in the overview: status, assignee, points, and an
  overdue section.
- `src/utils/schedule.ts`: zone-aware interval math (Intl only, no library)
  with explicit handling of DST gaps/overlaps and all-day events.
- Tests for the schedule math and the four planning tools.

### Notes

- `plan_week_meals` registers without Plus and fails with a clear message there.
- The hosted Worker exposes the new tools automatically (read + write profile).
  Redeploy to pick them up.

## [1.2.0] - 2026-10-29

### Fixed

- **Meals**: `get_meal_categories` showed every category as "Unknown"; the
  API field is `label`, not `name`. `get_meal_sittings` now shows what is
  planned (summary or recipe), the category name, and each date in range.
  `create_meal_sitting` accepts a free-text `summary` so a meal can be
  scheduled without creating a recipe first, and reads the list-shaped
  create response correctly.

### Added

- **Browser-paste sign-in**: `skylight-mcp auth login` / `auth complete <url>` /
  `auth status` / `auth logout`. You sign in in your own browser and paste the
  redirect URL; the password never reaches the server. PKCE (S256) and a
  state check bound to a short-lived `0600` pending-login file.
- **Encrypted credential store**: AES-256-GCM with the key in macOS Keychain;
  `0600` file store elsewhere. Fails closed when the Keychain is unavailable.
- Automatic access-token refresh with rotation persisted; one in-flight
  refresh shared across concurrent requests; one retry on 401.
- Tests for the OAuth module, both credential stores, client auth order,
  API host pinning, the tool registry, request context and the hosted MCP
  handler (82 total).

- **Hosted server for Claude Duet** (`src/worker/`, `wrangler.jsonc`): a
  Cloudflare Worker that is both OAuth authorization server and MCP resource
  server (`@cloudflare/workers-oauth-provider` 1.x). Consent page gated by a
  setup passphrase; the same browser-paste Skylight sign-in, with the PKCE
  verifier held in a browser-bound upstream transaction; Skylight tokens kept
  in encrypted grant props and refreshed in `tokenExchangeCallback`. Exposes
  read + create/update tools only.
- `src/context.ts`: per-request AsyncLocalStorage context so one process can
  serve many grants; `src/tools/registry.ts`: effect classification and MCP
  annotations for every tool.

### Changed

- Package renamed to `@dwooods/skylight-mcp`; repository metadata points at
  this fork. README carries an explicit unofficial-status notice.
- Auth source order is now explicit token, stored credential, then the
  deprecated email/password login. Startup no longer requires email/password or
  token env vars.
- The client refuses absolute endpoint URLs whose origin is not the Skylight API
  host, so a bearer token can never be sent elsewhere.
- README, SECURITY.md and `.env.example` rewritten for the new flow.
- `THIRD_PARTY_NOTICES.md` credits kamilio/skylight-calendar-agent (MIT), whose
  design informed the sign-in flow and credential store.

### Security

- `npm audit`: 24 → 0. Runtime: `@modelcontextprotocol/sdk` 1.25 → 1.32
  (GHSA-345p-7cg4-v4c7, cross-client data leak via shared transport reuse;
  this server already creates one server+transport per request) and `zod`
  3 → 4 (GHSA-mrhx-c7xc-m3w5). Dev: `vitest` 1 → 5, `vite` 8, `@types/node`
  22.

### Removed

- Node 18 support (end-of-life April 2025; `wrangler` needs 20+). `engines` is now `>=20`.

### Deprecated

- `SKYLIGHT_EMAIL` / `SKYLIGHT_PASSWORD` login.

## [1.1.8] - 2026-04-14

### Fixed

- **Authentication**: Updated email/password authentication to match Skylight's current web OAuth flow. The server now follows the browser login sequence (`/oauth/authorize` -> `/auth/session` -> `/oauth/token`) and uses the returned bearer token for API requests.

### Changed

- Centralized shared API constants, including the Skylight API version header
- Updated auth-related docs and error guidance to reflect OAuth-based login
- Added automated tests for the OAuth login flow and kept live smoke validation against the real API

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
