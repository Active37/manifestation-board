# BUCC Manifestation Board API Specification

This document describes the API currently implemented in this repository. It is the frontend integration reference for v1. Routes are unversioned; there is no `/v1` prefix.

## Quick Reference

| Method | Route | Purpose | Access |
|---|---|---|---|
| `GET` | `/names/random` | Suggest an available display name | Public |
| `GET` | `/names/check?name=...` | Check case-insensitive name availability | Public |
| `GET` | `/posts` | Browse live posts with search, sorting, and cursors | Public |
| `POST` | `/posts` | Create a post; returns the one-time edit key | Public, CAPTCHA and device ID required |
| `GET` | `/posts/:id/owner` | Retrieve the poster's own post without exposing moderation state | Edit key required |
| `PATCH` | `/posts/:id` | Edit the poster's post | Edit key required |
| `DELETE` | `/posts/:id` | Remove the poster's post | Edit key required |
| `POST` | `/posts/:id/like` | Like a live post | Device ID required |
| `DELETE` | `/posts/:id/like` | Remove the device's like | Device ID required |
| `POST` | `/posts/:id/report` | Report a live post | Device ID required |
| `POST` | `/admin/login` | Start an admin/moderator session | Allowed Origin |
| `POST` | `/admin/logout` | End the current session | Allowed Origin; CSRF if an active session is present |
| `GET` | `/admin/queue` | List held and automatically hidden posts | Moderator or admin |
| `GET` | `/admin/rejected` | List rejected posts still inside the seven-day window | Moderator or admin |
| `POST` | `/admin/posts/:id/approve` | Approve a held or hidden post | Moderator or admin, CSRF |
| `POST` | `/admin/posts/:id/reject` | Reject a held or hidden post | Moderator or admin, CSRF |
| `POST` | `/admin/posts/:id/undo` | Undo the latest moderation action | Moderator or admin, CSRF |
| `POST` | `/admin/posts/:id/restore` | Restore an eligible rejected post | Moderator or admin, CSRF |
| `GET` | `/admin/moderators` | List moderator/admin accounts | Admin |
| `POST` | `/admin/moderators` | Create a moderator/admin account | Admin, CSRF |
| `DELETE` | `/admin/moderators/:id` | Deactivate an account and revoke its sessions | Admin, CSRF |
| `GET` | `/admin/banned-terms` | Read the banned-term list | Admin |
| `PUT` | `/admin/banned-terms` | Replace the complete banned-term list | Admin, CSRF |
| `GET` | `/admin/semesters` | List semesters | Admin |
| `POST` | `/admin/semesters` | Create the next open semester | Admin, CSRF |
| `POST` | `/admin/semesters/:id/close` | Close an open semester | Admin, CSRF |

## Base URL And Setup

| Environment | Base URL |
|---|---|
| Local development | `http://localhost:3001` |
| Hosted | The API host supplied by the deployment team |

Set `DATABASE_URL`, `CORS_ORIGINS`, `IP_HASH_SECRET` (at least 32 characters), and `TURNSTILE_SECRET_KEY`. Apply migrations with `npm run db:migrate`. Verify the schema with `npm run db:verify`. The first administrator is provisioned with `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, and `npm run admin:bootstrap`.

At least one semester must be in the `open` state for post creation and public interactions. Create it using `POST /admin/semesters`. When it ends, close it with `POST /admin/semesters/:id/close`; create the next semester when ready.

The running API uses the configured exact `CORS_ORIGINS` allowlist. Browser clients must send credentials for admin session cookies. Production additionally requires HTTPS, verified PostgreSQL TLS, an explicit `TRUSTED_PROXIES` list, a distinct `MIGRATION_DATABASE_URL`, and Turnstile expected hostname/action values.

## Common Rules

| Item | Contract |
|---|---|
| Request content type | Send JSON requests as `Content-Type: application/json`. Request bodies are limited to 16 KiB. |
| Device identity | `X-Device-Id` is client supplied, 1-200 characters. The API HMACs it before storing rate-limit, like, or report identifiers. Changing it can bypass per-device controls; it is not device attestation. |
| Client IP | Derived from the socket/proxy chain. Configure trusted proxies carefully; do not let an untrusted client define its effective IP via forwarded headers. |
| Post ownership | `X-Edit-Key` is a 43-character base64url secret returned only at post creation. Store it on the poster's device; never use the display name as proof of ownership. The database stores a SHA-256 hash. |
| Admin session | Login sets `__Host-admin_session`: `Secure`, `HttpOnly`, `SameSite=Strict`, path `/`, eight-hour lifetime. JavaScript cannot read it. |
| Admin CSRF | For state-changing admin operations send the `csrf_token` from login in `X-CSRF-Token`, plus the session cookie and an allowlisted `Origin`. |
| CORS request headers | `Content-Type`, `X-Device-Id`, `X-Edit-Key`, and `X-CSRF-Token`. CAPTCHA is a JSON body field, not a header. |
| Rate limits | Defaults: 3 post attempts/hour and 30 like/unlike attempts/minute, independently by device and IP. Admin login rate limiting is intentionally not implemented. |
| Time handling | Timestamps are ISO 8601 UTC strings. “Today” for daily likes and shuffle is calculated in UTC. |
| Unknown fields | Post create, edit, report, login, moderator create, and banned-term replacement bodies reject unknown fields. |

### Header Matrix

| Header | Required on | Value / notes |
|---|---|---|
| `Content-Type: application/json` | JSON request bodies | Use for create/edit/report/admin JSON operations. Request body maximum is 16 KiB. |
| `X-Device-Id` | `POST /posts`, `POST/DELETE /posts/:id/like`, `POST /posts/:id/report` | Client-generated stable identifier, 1-200 characters. Keep consistent for the same browser/device. |
| `X-Edit-Key` | `GET /posts/:id/owner`, `PATCH /posts/:id`, `DELETE /posts/:id` | Secret from `POST /posts`; 43 base64url characters. |
| `Origin` | `POST /admin/login`, `POST /admin/logout`, and every admin mutation | Must exactly match a configured origin in `CORS_ORIGINS`. |
| `Cookie: __Host-admin_session=...` | Authenticated admin reads and mutations | Browser-managed Secure, HttpOnly cookie from login; send credentials for cross-origin requests. |
| `X-CSRF-Token` | Admin mutations; logout when a valid session exists | Token from `POST /admin/login`. CORS preflight explicitly allows this header. |

Public feed and name reads require no custom headers. The admin session cookie is not a bearer token to copy into JavaScript; use the browser's credential mechanism.

## Values And Enums

| Field | Allowed values / constraints |
|---|---|
| `category` | `academic`, `career`, `spiritual`, `money`, `fun/random`, or `null`. Optional on create; it can be set to `null` when editing to clear it. Category display/filtering are not v1 endpoints. |
| `reason` | `offensive`, `sexual`, `harassment`, `spam`, `other` |
| Feed `sort` | `shuffle` (default), `newest`, `most-liked-today`, `most-liked-all-time` |
| Post lifecycle | `live`, `held`, `hidden`, `rejected`, `removed`. Public feed responses contain only `live` posts. Owner lookup deliberately does not return this field. |
| Admin `role` | `admin`, `moderator` |
| Semester `state` | `open`, `closed`. At most one semester can be open. |
| `body` | Trimmed string with 1-300 characters. |
| `display_name` | Non-empty after trimming; normalized with Unicode NFKC and lowercase for uniqueness. No application-level maximum is currently enforced. |
| `check_in_email` | Optional valid email, trimmed, maximum 320 characters. Presence means the user opted in; frontend must only send it after explicit consent. |

## Names

### `GET /names/random`

| Request item | Required | Structure / values |
|---|---:|---|
| Query parameters | No | None accepted. |

| Success | Response |
|---|---|
| `200` | `{ "name": "Manifest-Lion-482" }` |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid name request" }` for unexpected query parameters. |
| `503` | `{ "error": "No names are currently available" }` if none of the 32 sampled candidates are available. |
| `500` | `{ "error": "Internal server error" }` for unexpected failures. |

Current candidate space: 10 first words × 10 second words × 1,000 suffixes = 100,000 combinations. The generator samples 32 candidates per call, so it may return 503 before every possible name is taken.

### `GET /names/check?name=...`

| Request item | Required | Structure / values |
|---|---:|---|
| `name` query | Yes | Non-empty string. Trims whitespace; comparison is NFKC-normalized and case-insensitive. |

| Success | Response |
|---|---|
| `200` | `{ "name": "Manifest-Lion-482", "available": true }`; `available` is boolean. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid name request" }` for missing, blank, or extra query fields. |
| `500` | `{ "error": "Internal server error" }` for unexpected failures. |

Availability checks do not reserve a name. `POST /posts` is authoritative and can return `409` if another request claims that name first.

## Public Posts

### `GET /posts`

| Request item | Required | Structure / values |
|---|---:|---|
| `sort` query | No | Enum in Values And Enums; defaults to `shuffle`. |
| `search` query | No | Non-empty trimmed string; case-insensitive substring match against display name only. |
| `cursor` query | No | Opaque string returned as `next_cursor`, 1-4096 characters. Keep sort/search the same when requesting the next page. |

| Success | Response |
|---|---|
| `200` | `{ "posts": [<PublicPost>], "next_cursor": "<opaque string>" }`. `posts` contains 0-30 items. On the final page, `next_cursor` is `null`. |

`PublicPost` structure:

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID string | Post ID. |
| `display_name` | string | Public name. |
| `body` | string | Goal text. |
| `category` | category enum or `null` | Optional category stored on the post. |
| `like_count` | integer | Current total likes. |
| `created_at` | ISO date-time string | Creation timestamp in UTC. |

Public responses never include edit keys, email addresses, device IDs, report detail, or moderation status.

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid feed query" }` for invalid sort, blank search, unknown query fields; `{ "error": "Invalid or expired cursor" }` for a malformed cursor or a cursor used with different sort/search/day values. |
| `500` | `{ "error": "Internal server error" }` for unexpected failures. |

### `POST /posts`

Headers: `X-Device-Id` required. Body is JSON. A Turnstile token is required. If the poster explicitly opts in to a future check-in, include `check_in_email`.

| Body field | Required | Type / constraints | Example |
|---|---:|---|---|
| `display_name` | Yes | String, non-empty after trimming; unique case-insensitively. | `Manifest-Lion-482` |
| `body` | Yes | String, 1-300 characters after trimming. | `Complete my semester project before exams` |
| `category` | No | Category enum or `null`; defaults to `null`. | `academic` |
| `check_in_email` | No | Valid email, max 320 characters. Include only after explicit user opt-in. Stored separately and never returned. | `member@example.org` |
| `captcha_token` | Yes | Turnstile token, 1-2048 characters. Fresh tokens must match configured hostname/action and can be used once. | `0.xxxxx...` |

Headers example: `X-Device-Id: dev_2t4x8QwL9nP3sR7v`.

| Success | Response |
|---|---|
| `201` | `{ "id": "<uuid>", "display_name": "Manifest-Lion-482", "body": "Complete my semester project before exams", "category": "academic", "created_at": "2026-11-26T14:30:00.000Z", "edit_key": "<43-character secret>" }`. Email and moderation status are not returned. Save `edit_key` immediately. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid post request" }` for invalid fields, email, category, or missing device ID; `{ "error": "CAPTCHA verification failed" }` for unsuccessful/replayed CAPTCHA. |
| `409` | `{ "error": "Display name is already taken" }` or `{ "error": "No open semester is available" }`. |
| `413` | `{ "error": "Request body is too large" }` when JSON exceeds 16 KiB. |
| `429` | `{ "error": "Too many requests" }` when the post attempt limit is exceeded by device or IP. |
| `503` | `{ "error": "CAPTCHA verification is unavailable" }` when the provider cannot be reached or returns an unusable response. |
| `500` | `{ "error": "Internal server error" }` for unexpected failures. |

Content that passes filters is `live`; a matching banned term or gibberish is created with internal status `held`. Both return `201`; the owner-facing response intentionally does not reveal the moderation status.

Example body with opt-in:

```json
{
  "display_name": "Manifest-Lion-482",
  "body": "Complete my semester project before exams",
  "category": "academic",
  "check_in_email": "member@example.org",
  "captcha_token": "<fresh Turnstile token>"
}
```

### `GET /posts/:id/owner`

Header: `X-Edit-Key` required.

| Success | Response |
|---|---|
| `200` | `{ "id": "<uuid>", "display_name": "Manifest-Lion-482", "body": "A semester goal", "category": null, "created_at": "2026-11-26T14:30:00.000Z" }`. No status or edit key is returned. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid owner-post request" }` for malformed key or ID. |
| `404` | `{ "error": "Post not found" }` for unknown post or wrong key. |
| `410` | `{ "error": "This post was removed" }` when the keyed post is rejected or removed. |

### `PATCH /posts/:id`

Header: `X-Edit-Key` required. At least one field must be provided. Unknown properties are rejected.

| Body field | Required | Type / constraints |
|---|---:|---|
| `display_name` | No | Non-empty string after trimming; remains globally unique, case-insensitively. |
| `body` | No | String, 1-300 characters after trimming. |
| `category` | No | Category enum or `null`; `null` removes the category. |

| Success | Response |
|---|---|
| `200` | `{ "id": "<uuid>", "display_name": "Manifest-Lion-482", "body": "Updated goal", "category": null, "created_at": "2026-11-26T14:30:00.000Z" }`. No edit key, email, or moderation status. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid post edit request" }` for malformed body/key. |
| `404` | `{ "error": "Post not found" }` for wrong key or missing/removed post. |
| `409` | `{ "error": "Display name is already taken" }` or `{ "error": "Archived semesters are read-only" }`. |

Edits re-run the banned-term/gibberish checks. A flagged live/held post becomes held; the API does not expose that state in the response.

### `DELETE /posts/:id`

Header: `X-Edit-Key` required. This is a soft removal from the board; any separately stored check-in email is deleted in the same transaction.

| Success | Response |
|---|---|
| `204` | No response body. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid post edit request" }` for malformed key/ID. |
| `404` | `{ "error": "Post not found" }` for wrong key or missing/removed post. |
| `409` | `{ "error": "Archived semesters are read-only" }`. |

### `POST /posts/:id/like` and `DELETE /posts/:id/like`

Header: `X-Device-Id` required. No JSON body is required. Like/unlike attempts both consume the 30/minute default limit by device and IP. One like per post/device is enforced by PostgreSQL.

| Method | Success response |
|---|---|
| `POST` | `200` `{ "like_count": 5 }` |
| `DELETE` | `200` `{ "like_count": 4 }` |

Repeated like/unlike calls are idempotent with respect to the stored like. The response is the current total, not a boolean.

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid post ID" }` or `{ "error": "A valid X-Device-Id header is required" }`. |
| `404` | `{ "error": "Post not found" }` for missing/non-live post on like. |
| `409` | `{ "error": "Archived semesters are read-only" }`. |
| `429` | `{ "error": "Too many requests" }`. |

### `POST /posts/:id/report`

Header: `X-Device-Id` required. Reason is required; detail is optional/nullable. No route-specific detail character maximum is configured; JSON request size is limited to 16 KiB.

| Body field | Required | Type / values |
|---|---:|---|
| `reason` | Yes | `offensive`, `sexual`, `harassment`, `spam`, `other`. |
| `detail` | No | String or `null`. |

| Success | Response |
|---|---|
| `200` | `{ "report_count": 2 }` with the current distinct-device report count. |

One report per post/device is accepted. A repeated report from that device does not increment the count. The third distinct-device report changes a live post to `hidden`, placing it in the moderator queue.

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid report request" }` or invalid post/device ID. |
| `404` | `{ "error": "Post not found" }` for missing/non-live post. |
| `409` | `{ "error": "Archived semesters are read-only" }`. |

## Admin Authentication

### `POST /admin/login`

Header: `Origin` must exactly match a configured `CORS_ORIGINS` value. No session is needed to log in.

| Body field | Required | Type / constraints |
|---|---:|---|
| `email` | Yes | Valid email, max 320 characters. Normalized with NFKC, trimmed, and lowercased. |
| `password` | Yes | 12-128 characters and at most 72 UTF-8 bytes. |

| Success | Response |
|---|---|
| `200` | `Set-Cookie: __Host-admin_session=...; Secure; HttpOnly; SameSite=Strict; Path=/` plus JSON `{ "csrf_token": "<43-character token>" }`. Cookie expires after eight hours. |

| Error | Response |
|---|---|
| `400` | `{ "error": "Invalid login request" }`. |
| `401` | `{ "error": "Invalid email or password" }` for bad credentials or inactive account. |
| `403` | `{ "error": "Request origin not allowed" }`. |

Admin login rate limiting is not implemented. Do not treat this endpoint as suitable for production exposure until a login abuse policy is added.

### `POST /admin/logout`

Requires an allowlisted `Origin`. If a valid session cookie is present, also send its `X-CSRF-Token`. No body is required.

| Success | Response |
|---|---|
| `204` | Session invalidated and cookie cleared; no response body. |

| Error | Response |
|---|---|
| `403` | `{ "error": "Request origin not allowed" }` or `{ "error": "Invalid CSRF token" }`. |

## Moderation

All moderation endpoints require an admin session cookie. Moderator and admin roles may read the queue and act on posts. Mutations additionally require an allowed `Origin` and `X-CSRF-Token`. Moderation action request bodies may be omitted or `{}`; non-empty bodies are rejected.

### `GET /admin/queue`

| Success | Response |
|---|---|
| `200` | `{ "posts": [<ModerationPost>] }`; posts with status `held` or `hidden`, oldest first. |

`ModerationPost` fields: `id` UUID, `display_name` string, `body` string, `category` enum/null, `status` (`held`/`hidden`/`rejected`), `report_count` integer, `created_at` ISO date-time. Queue items have held/hidden status.

### `GET /admin/rejected`

| Success | Response |
|---|---|
| `200` | `{ "posts": [<ModerationPost>] }`; status is `rejected`, includes `rejected_at`, only within the seven-day recovery period. Expired entries are excluded and scheduled cleanup permanently purges them. |

### Moderation action routes

| Method and route | Effect | Success |
|---|---|---|
| `POST /admin/posts/:id/approve` | `held` or `hidden` -> `live` | `204`, no body |
| `POST /admin/posts/:id/reject` | `held` or `hidden` -> `rejected`; starts seven-day window | `204`, no body |
| `POST /admin/posts/:id/undo` | Reverses the latest eligible action if post state has not changed | `204`, no body |
| `POST /admin/posts/:id/restore` | Restores an in-window rejected post to its pre-rejection state | `204`, no body |

Errors: `401` `{ "error": "Authentication required" }`; `403` for missing staff role, disallowed Origin, or invalid CSRF; `404` `{ "error": "Post not found" }`; `409` `{ "error": "Post is not awaiting moderation" }`, `{ "error": "No moderation action to undo" }`, `{ "error": "Post has changed since that moderation action" }`, or `{ "error": "Post is outside the rejection backlog" }`.

## Admin Management

### Moderators

All routes require admin role. Mutations also require allowed `Origin` and `X-CSRF-Token`.

| Method and route | Request | Success response |
|---|---|---|
| `GET /admin/moderators` | No body | `200` `{ "moderators": [{ "id": "<uuid>", "email": "mod@example.org", "role": "moderator", "active": true }] }`; password hashes are never returned. |
| `POST /admin/moderators` | `{ "email": "mod@example.org", "password": "12+ chars, <=72 UTF-8 bytes", "role": "moderator" }`; role enum `admin`/`moderator`. | `201` `{ "moderator": { "id": "<uuid>", "email": "mod@example.org", "role": "moderator", "active": true } }`. |
| `DELETE /admin/moderators/:id` | UUID path; no body | `204`; account deactivated and sessions revoked. |

`POST` errors: `400` invalid request, `401` no session, `403` non-admin/Origin/CSRF failure, `409` `{ "error": "Moderator already exists" }`. `DELETE` also returns `404` for unknown UUID and `409` if attempting to deactivate the last active admin.

### Banned terms

| Method and route | Request | Success response |
|---|---|---|
| `GET /admin/banned-terms` | No body | `200` `{ "terms": [{ "term": "example phrase", "type": "profanity" }] }`. |
| `PUT /admin/banned-terms` | Replaces the entire list: `{ "terms": [{ "term": "example phrase", "type": "profanity" }] }`. Maximum 500 entries. Both fields are non-empty strings; `type` is free-form, not an enum. Duplicate normalized term/type pairs are rejected. Use `{ "terms": [] }` to clear. | `200` `{ "terms": [...] }`. |

Mutations require admin session, allowed Origin, and CSRF. Errors: `400` invalid/duplicate terms, `401` unauthenticated, `403` not admin/Origin/CSRF failure.

### Semesters

All semester management routes require admin role. Mutations also require an allowed `Origin` and `X-CSRF-Token`.

| Method and route | Request | Success response |
|---|---|---|
| `GET /admin/semesters` | No body | `200` `{ "semesters": [{ "id": "<uuid>", "name": "2026 Semester 1", "ends_on": "2026-12-31", "state": "open" }] }`. |
| `POST /admin/semesters` | `{ "name": "2027 Semester 1", "ends_on": "2027-05-30" }`; name 1-120 chars; end date must be a real `YYYY-MM-DD` calendar date. | `201` `{ "semester": { "id": "<uuid>", "name": "2027 Semester 1", "ends_on": "2027-05-30", "state": "open" } }`. |
| `POST /admin/semesters/:id/close` | UUID path; no body or `{}` | `204`; state becomes `closed`. |

Only one semester can be open. Creating another while one is open returns `409` `{ "error": "An open semester already exists" }`. Closing an unknown ID returns `404`; closing an already closed semester returns `409`. No public post creation/edit/delete/like/report writes are accepted when the associated semester is closed.

## Error Format

Handled API errors return JSON with exactly one field:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|---:|---|
| `400` | Request schema/parameter/header validation failure, invalid CAPTCHA, or CAPTCHA replay. |
| `401` | Admin authentication required or invalid login credentials. |
| `403` | Admin role, allowed Origin, or CSRF requirement failed. |
| `404` | Resource not found or an edit key does not match. |
| `409` | Duplicate name, no/open semester conflict, closed-semester write, or invalid state transition. |
| `410` | Owner-keyed post was rejected or removed; response message is neutral. |
| `413` | JSON request body exceeded 16 KiB. |
| `426` | HTTP used in production; HTTPS required. |
| `429` | Post/like rate limit exceeded. |
| `500` | Unexpected server/database error; internal details are not returned. |
| `503` | CAPTCHA provider unavailable or no generated-name candidate found. |

Send syntactically valid JSON. The current generic error middleware does not specially map JSON parser syntax errors, so malformed JSON may return `500` rather than `400`.

## Frontend Integration Notes

| Requirement | Frontend behavior |
|---|---|
| CAPTCHA | Obtain a fresh Turnstile token and submit it as `captcha_token`. Production verifies token freshness, hostname, action, and single use. A failed/replayed token is a `400`; provider outage is `503`. |
| Optional email | Show the email input only after explicit opt-in. Submit `check_in_email` only after consent. It is stored separately with `consented_at`; it is not returned by `POST /posts`. Email delivery/unsubscribe/delete workflows are not implemented yet. |
| Owner post | Persist `edit_key` on the poster's device. Use `GET /posts/:id/owner` to recover the post. A `200` has no status field, so do not reveal “held/pending”. A `410` means show the PRD's neutral removal message and forget local ownership data. |
| CORS | Use an exact configured origin. For admin APIs, send credentials so the secure HttpOnly cookie is included. `X-CSRF-Token` must be allowed in preflight. |
| Empty action bodies | For admin action POSTs send `{}` with JSON content type or omit the body; do not send other properties. |
| Names | `GET /names/check` is advisory and does not reserve a name. Handle `409` from post creation if a race occurs. |
| Feed cursor | Treat `next_cursor` as opaque. Keep the same `sort` and `search` for the next page. Restart pagination after changing sort/search or after the UTC day changes for daily shuffle/today-like order. |
| `X-Device-Id` | Supply a stable random client-generated value as requested. It is not proof of a physical device; changing it can bypass per-device protections. |

## Test And Try-It Setup

```powershell
npm run build
npm run db:migrate
npm run db:verify
$env:TEST_DATABASE_URL = "postgresql://.../disposable_test_db"
npm run test:api
```

The integration test writes and removes fixtures, clears rate-limit records, creates a temporary admin, and verifies opt-in email storage. Use a disposable database only. Integration CAPTCHA is injected as a test verifier; live Turnstile configuration is not covered by that test. For a docs UI, use `POST /admin/login` first, keep the cookie, then use its `csrf_token` for mutations. `POST /posts` requires a real fresh Turnstile response token outside tests.

## Current Scope And Deferred Work

Email is optionally collected at initial creation only when the poster opts in. Future work still includes sending the semester-end check-in, unsubscribe, request-based deletion, and related retention workflow. Category display/filtering and semester-end reflection/results are also after launch. This spec intentionally reflects backend behavior; the separate `backend/openapi.json` has not been updated in this change.