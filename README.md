# BUCC Manifestation Board

Anonymous goal board backend built with TypeScript, Express, and PostgreSQL. Requires Node.js 20.6 or newer.

## Setup

1. Install packages with `npm install`.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL`, `CORS_ORIGINS`, `IP_HASH_SECRET` (at least 32 random characters), and `TURNSTILE_SECRET_KEY`.
3. Apply the database schema with `npm run db:migrate`.
4. Hash legacy like/report device identifiers and validate the interaction constraints with `npm run db:hash-interaction-devices`. Use the same `IP_HASH_SECRET` as the API.
5. Insert the current semester into `semesters` with `state = 'open'`; posts cannot be created without one.
6. For the first administrator only, temporarily set `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` in `.env`, then run `npm run admin:bootstrap`. The password must be 12–72 UTF-8 bytes. Remove both bootstrap values afterward.
7. Start the API with `npm run dev:api`.

For local development or automated test environments only, set
`POST_CAPTCHA_BYPASS=true` to create test posts without a Turnstile token. The
existing database-backed fixed-window post limit still applies per anonymous
cookie and IP (3 posts per hour by default). The default is `false`, and
production startup rejects `true`; CAPTCHA remains required in production.

For an existing deployment, rehearse steps 3–4 against a restored staging copy first. Stop all old API instances before applying migration `017` because it rejects new un-hashed interaction identifiers. Run the backfill command with the migration database credentials, then deploy the new API. The backfill updates identifiers in batches without deleting interaction rows or changing counters; a uniqueness collision aborts the affected batch without discarding data.

The API defaults to port 3001. `POSTS_PER_HOUR`, `LIKES_PER_MINUTE`, `REPORTS_PER_HOUR`, and `NAMES_PER_MINUTE` configure public rate limits. `ADMIN_LOGIN_FAILURES`, `ADMIN_LOGIN_WINDOW_MS`, `ADMIN_LOGIN_INITIAL_LOCKOUT_MS`, and `ADMIN_LOGIN_MAX_LOCKOUT_MS` configure the progressive admin login lockout. Run `npm run build` followed by `npm start` for a compiled API. `npm run dev` starts the API in watch mode.
Database connections use bounded pools and query timeouts; adjust `DB_POOL_MAX`,
`DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, and `DB_QUERY_TIMEOUT_MS`
for the deployment capacity. Requests have a configurable `REQUEST_TIMEOUT_MS`.

## Endpoints

### Public

- `GET /health`
- `GET /names/random`
- `GET /names/check?name=...`
- `GET /posts` — optional `sort`, `search`, `category`, and `cursor` query parameters
- `GET /posts/categories` — lists categories currently available for new goals
- `GET /posts/achieved` — lists achieved goals that are still live
- `GET /posts/featured` — lists featured goals that are still live
- `GET /posts/trending` — today's most-liked live goals with cursor pagination
- `GET /posts/random` — one random live goal, or `{ "post": null }` when none are live
- `GET /semesters` — lists closed semesters available to browse
- `GET /semesters/:id/posts` — live posts from a closed semester, newest first with cursor pagination
- `POST /posts` — requires an allowlisted `Origin`; returns the edit key once and sets an anonymous device cookie
- `PATCH /posts/:id` and `DELETE /posts/:id` — require `X-Edit-Key`
- `PATCH /posts/:id/progress` — requires `X-Edit-Key`; accepts `not_started`, `in_progress`, or `achieved`
- `POST /posts/:id/like` and `DELETE /posts/:id/like` — require an allowlisted `Origin` and anonymous device cookie
- `POST /posts/:id/report` — requires an allowlisted `Origin`, anonymous device cookie, and report reason

Post responses include `progressStatus`, which defaults to `not_started`. Progress
updates do not change a post's moderation status. When an owner marks a goal
achieved, the API permanently awards one `goal_achieved` badge to that post and
includes earned badges in public post responses. Goal categories are managed as
lowercase slugs; the seeded `fun-random` category represents fun/random goals.

### Admin

Admin sessions use a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Login returns a CSRF token; include it in `X-CSRF-Token` on admin `POST`, `PUT`, and `DELETE` requests. Moderator and moderation routes require an admin or moderator session; moderator management and banned-term routes are admin-only.

- `POST /admin/login`
- `POST /admin/logout` — requires the session cookie and CSRF token when the session is active
- `GET /admin/moderators`, `POST /admin/moderators`, `DELETE /admin/moderators/:id`
- `GET /admin/queue`, `GET /admin/rejected`
- `POST /admin/posts/:id/approve`
- `POST /admin/posts/:id/reject`
- `POST /admin/posts/:id/undo`
- `POST /admin/posts/:id/restore`
- `POST /admin/posts/:id/feature`, `DELETE /admin/posts/:id/feature` — admin-only
- `GET /admin/banned-terms`, `PUT /admin/banned-terms`
- `GET /admin/categories`, `PUT /admin/categories` — replace the available category slugs. Removing a slug does not change older posts that used it.
- `GET /admin/analytics?semesterId=...` — aggregate totals and moderation counts for one semester, or all semesters when omitted
- `POST /admin/semesters/:id/archive` — closes the current semester; admin-only

For browser clients, send admin requests with credentials enabled. Restrict `/admin` at the deployment boundary and allow only trusted frontend origins in `CORS_ORIGINS`.

Moderation and admin configuration changes, owner post removals, scheduled purges, admin login/session events, authorization denials, and repeated rate-limit violations are recorded in append-only audit logs. Each HTTP response includes a server-generated `X-Request-Id`; audit writes inside request transactions carry that correlation ID. Audit metadata excludes emails, IP/device identifiers, passwords, session values, edit keys, CAPTCHA tokens, and report details. Audit logs are not exposed through the public API. The database trigger blocks normal row updates/deletes and truncation, but a database owner or superuser can bypass it; ship audit events to access-controlled external storage and consider hash chaining if tamper evidence beyond the database boundary is required.
Closed semesters are read-only to the public: owners cannot edit or remove goals, and visitors cannot like or report them. Moderators can still moderate archived posts. Add the next open semester after archiving the current one.

## Deployment checks

- Use HTTPS in production; admin session cookies are always `Secure`.
- Set `NODE_ENV=production`. The API and migration runner then require PostgreSQL URLs with `sslmode=verify-full`. The API rejects plaintext HTTP and requires `TRUSTED_PROXIES` so it can verify HTTPS termination; configure the proxy to overwrite `X-Forwarded-Proto`, not trust a client-supplied value.
- Give the application a dedicated non-owner, non-superuser database role in `DATABASE_URL`, with no inherited role memberships and no access to unrelated application schemas. Startup rejects privileged roles, ownership, role memberships, public-schema object creation, and unrelated application-schema access. Set `MIGRATION_DATABASE_URL` to a separate migration role; production configuration rejects identical role names. Provide the migration credential only to the migration job, not the API deployment.
- Grant the runtime role only required DML privileges in the application schema and sequence usage. Do not grant schema creation, role creation, database creation, ownership, or membership in unrelated roles. Keep audit logs append-only for that role. Configure default privileges for the migration role so newly created objects receive the intended runtime grants.
- Set `TRUSTED_PROXIES` to the exact proxy IPs or CIDRs. The default trusts no forwarded IP headers; do not trust arbitrary client-forwarded addresses.
- Set `CORS_ORIGINS` to exact trusted origins and use the matching production Turnstile secret. Production also requires `TURNSTILE_EXPECTED_HOSTNAME` and `TURNSTILE_EXPECTED_ACTION`; invalid, expired, unbound, or unavailable CAPTCHA verification prevents post creation.
- For cross-origin browser clients, configure credentialed requests and HTTPS at both origins. Confirm that the frontend uses `credentials: "include"` and that the browser accepts the Secure anonymous cookie before launch.
- Before deploying migration `017`, stop API instances running the old version. Back up the database, test the migration and `npm run db:hash-interaction-devices` on a restored staging copy, then run both with the migration role before starting the new API. Startup checks that all four interaction hash constraints are validated.
- Keep `/admin` restricted at the deployment boundary; CORS is not an access-control mechanism.
- Ensure the proxy and application agree on HTTP framing, reject conflicting `Content-Length`/`Transfer-Encoding` requests at the edge, and do not expose the database port publicly.

## Database recovery

- Enable encrypted managed backups and point-in-time recovery with a retention period approved for the board's data.
- Restrict backup access to a separate operations identity; keep backup keys and database credentials in a secret manager, not in the repository or deployment logs.
- Periodically verify backup integrity and perform a restore into an isolated database. Test migrations against that restored/staging database before production rollout.
- Migrations are forward-only in this project. For a failed deployment, restore from a verified backup or deploy a reviewed corrective migration; do not manually delete production data to reverse a migration.
- Rotate PostgreSQL and Turnstile credentials through the secret manager. Rotate `IP_HASH_SECRET` deliberately: existing HMAC-based rate-limit and login-lockout identities will no longer match after rotation.
- Expired admin sessions are removed during scheduled security-data cleanup. Login-attempt hashes older than 30 days are removed after their lockout has expired.

## Frontend integration

This repository contains the backend only; frontend source is maintained separately. The API strips markup from stored user text and returns text fields as JSON strings. The frontend must render names, goals, categories, and report text as text using framework output encoding; never insert these values with `innerHTML` or an equivalent unsafe HTML API.

The API issues an opaque `__Host-board_device` cookie with `Secure`, `HttpOnly`, `SameSite=None`, and `Path=/`. Browser clients calling the API cross-origin must send credentials (`credentials: "include"` or the equivalent) and the API origin must be listed exactly in `CORS_ORIGINS`. `X-Device-Id` is ignored; the frontend should stop sending it. State-changing post and interaction requests require an exact allowlisted `Origin`. The cookie token is HMACed with `IP_HASH_SECRET` before it is used for rate-limit subjects or stored in likes/reports. The backfill command preserves existing rows and counters, and API startup fails until its hash constraints are validated.

This cookie is a persistent anonymous identifier, not a device attestation. Users and automated clients can clear or replace it, so it does not prevent deliberate identity rotation. Keep `IP_HASH_SECRET` stable while retaining interaction history: rotation cannot re-key old device hashes because raw cookie tokens are intentionally not stored. A planned key-rotation policy must account for interaction uniqueness resetting for returning browsers.

The backfill preserves legacy like/report rows and counters, but old `X-Device-Id` values cannot be safely linked to newly issued cookies. Returning visitors may not be able to remove their pre-deployment likes, and a new cookie may count as a distinct reporter from that visitor's legacy identity.

## Checks

- `npm run test:api`
- `npm run build`
- `npm audit`
