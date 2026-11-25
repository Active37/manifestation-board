# BUCC Manifestation Board Backend Contribution

This document describes the backend work in this repository, how to run it locally, how to test it, and what remains before production deployment. The repository contains the backend; the frontend is maintained separately.

## Project overview

- Runtime: Node.js 20.6 or newer, TypeScript, Express 5, and PostgreSQL.
- Database access: `pg` with parameterized SQL queries; no ORM.
- Validation: Zod at HTTP and configuration boundaries.
- Source organization: routes, controllers, feature services, shared configuration, and database migrations under `backend/`.
- Dependencies: Express, PostgreSQL client, Zod, Helmet, CORS, bcryptjs, TypeScript, and `tsx`.

Request handlers validate input and call services. Services implement business rules and database operations. SQL migrations are forward-only and tracked in `schema_migrations`.

## Work delivered

### Public board

- Health check and anonymous display-name generation and availability checks.
- Goal creation, editing and removal with one-time edit keys.
- Public feeds with search, category filters, stable daily shuffle, sorting, and cursor pagination.
- Goal progress states, achievement badges, categories, featured posts, and archived-semester browsing.
- Likes and reports, including report-count updates and automatic hiding after the report threshold.

### Administration and moderation

- Admin and moderator login, role checks, moderator management, protected sessions, logout, and CSRF validation.
- Moderation queue, approvals, rejections, undo, restoration, and scheduled cleanup of old rejected posts.
- Banned-term and category management, analytics, featuring, and semester archiving.
- Audit events for sensitive operations and scheduled cleanup of expired authentication and security records.

### Security and reliability

- Strict request schemas, unknown-field rejection, JSON-only mutation bodies, body limits, request timeouts, Helmet headers, and exact-origin CORS.
- Bcrypt password hashing, hashed session and edit-key storage, constant-time comparisons, secure cookies, generic authentication failures, and progressive login lockouts.
- Shared database-backed rate limits, temporary blocks, HMAC-based IP pseudonyms, CAPTCHA verification and replay prevention.
- Production HTTPS checks behind explicitly trusted proxies, PostgreSQL TLS verification, bounded database pools and query timeouts.
- Runtime database-role checks, migration advisory locks, constraints and indexes, append-only audit protections, and request correlation IDs.
- Anonymous browser identity uses a random `Secure`, `HttpOnly`, `SameSite=None` cookie. The client-supplied `X-Device-Id` is ignored. Device tokens are HMACed before use in rate limits or persistence.
- A batched backfill preserves legacy like/report records and counters, then validates the interaction identity constraints.

## Repository layout

```text
backend/
  migrations/       Forward-only PostgreSQL migrations (001–017)
  src/
    admin/          Authentication, roles, moderation, analytics, cleanup
    db/             Migration runner, permissions, backfill, migration lock
    filter/          Keyword and gibberish checks
    names/           Anonymous name generation and lookup
    posts/           Post APIs, feed queries, CAPTCHA, interactions
    routes/          Express route mounts
    app.ts           Express middleware and route composition
    config.ts        Environment parsing and validation
    server.ts        Database pool, service wiring, startup and shutdown
BACKEND-WORK.txt    Short project and test summary
CONTRIBUTING.md     Repository contribution rules
README.md           Setup, endpoint list, and deployment guidance
```

## Local setup

### Prerequisites

- Node.js 20.6 or newer and npm.
- PostgreSQL reachable from the API.
- A valid Cloudflare Turnstile secret for successful post creation.

For local manual testing without a Turnstile widget, set
`POST_CAPTCHA_BYPASS=true`. This setting is permitted only outside production;
the existing database-backed fixed-window limit still applies per anonymous
cookie and IP (3 posts per hour by default).

### Install and configure

From the repository root:

```sh
npm install
Copy-Item .env.example .env
```

Edit `.env` with the local PostgreSQL connection URL, exact allowed browser origins, an `IP_HASH_SECRET` of at least 32 characters, and a Turnstile secret. Never commit `.env` or put real credentials in `.env.example`.

The current `.env.example` has blank values for several optional numeric settings. Do not leave those blank in `.env`: blank numeric strings fail configuration validation. Either remove optional entries to use defaults or set valid values.

Required API settings:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL |
| `CORS_ORIGINS` | Comma-separated exact browser origins, without paths |
| `IP_HASH_SECRET` | Key for IP and anonymous-device pseudonyms; minimum 32 characters |
| `TURNSTILE_SECRET_KEY` | Server-side CAPTCHA verification secret |

Important defaults and production-only requirements:

| Variable | Default or requirement |
|---|---|
| `NODE_ENV` | `development`; use `production` for deployment |
| `PORT` | `3001` |
| `POST_CAPTCHA_BYPASS` | `false`; local/test-only bypass, production rejects `true` |
| `POSTS_PER_HOUR` | `3` |
| `LIKES_PER_MINUTE` | `30` |
| `REPORTS_PER_HOUR` | `5` |
| `NAMES_PER_MINUTE` | `30` |
| `ADMIN_LOGIN_FAILURES` | `5` |
| `ADMIN_LOGIN_WINDOW_MS` | `900000` |
| `ADMIN_LOGIN_INITIAL_LOCKOUT_MS` | `900000` |
| `ADMIN_LOGIN_MAX_LOCKOUT_MS` | `86400000`; must be at least the initial lockout |
| `DB_POOL_MAX` | `10` |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` |
| `DB_QUERY_TIMEOUT_MS` | `12000` |
| `REQUEST_TIMEOUT_MS` | `30000` |
| `TRUSTED_PROXIES` | Empty in development; production requires exact proxy IPs/CIDRs |
| `MIGRATION_DATABASE_URL` | Optional locally; production requires a distinct migration-role URL |
| `TURNSTILE_EXPECTED_HOSTNAME` | Optional locally; required in production |
| `TURNSTILE_EXPECTED_ACTION` | Optional locally; required in production |

All settings and bounds are validated in `backend/src/config.ts`. See `.env.example` and `README.md` for deployment guidance.

### Apply schema and prepare local data

```sh
npm run db:migrate
npm run db:hash-interaction-devices
```

The migration command applies unapplied SQL files in order using a PostgreSQL advisory lock. The hash command processes legacy interaction IDs in batches and validates the four constraints required by API startup. Use the same `IP_HASH_SECRET` for the API and backfill.

Create one open semester in the local database before attempting to create posts. The application does not currently include a semester seed command. In production, post creation requires a valid Turnstile response; local test bypass behavior is described above.

For the first administrator only, temporarily set `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` in `.env` and run:

```sh
npm run admin:bootstrap
```

Passwords must be 12–72 UTF-8 bytes and at least 12 characters. Remove the bootstrap values from `.env` after the initial admin is created.

### Run the API

```sh
npm run dev
```

The API listens on port 3001 by default. Check `http://localhost:3001/health`; a healthy API returns `{"status":"ok"}`.

Build and run the compiled API:

```sh
npm run build
npm start
```

`npm run dev:api`, `npm run build:api`, and `npm run start:api` remain aliases for the API-specific commands.

## API overview

The current API paths are unversioned to preserve the existing client contract. Inputs are JSON and validated at the request boundary. Public responses do not expose held/rejected posts or internal credentials.

### Public routes

| Method and path | Purpose |
|---|---|
| `GET /health` | Database-backed health check |
| `GET /names/random` | Generate an available anonymous name |
| `GET /names/check?name=...` | Check name availability |
| `GET /posts` | Cursor-paginated public feed; supports sort, search, and category |
| `GET /posts/categories` | List active categories |
| `GET /posts/achieved` | List public achieved goals |
| `GET /posts/featured` | List public featured goals |
| `GET /posts/trending` | List today's most-liked posts |
| `GET /posts/random` | Return one live post or `null` |
| `POST /posts` | Create a goal; requires valid Turnstile token and allowlisted Origin |
| `PATCH /posts/:id` | Edit a goal using `X-Edit-Key` |
| `DELETE /posts/:id` | Remove a goal using `X-Edit-Key` |
| `PATCH /posts/:id/progress` | Update progress using `X-Edit-Key` |
| `POST /posts/:id/like` | Like using the anonymous cookie identity |
| `DELETE /posts/:id/like` | Remove a like using the anonymous cookie identity |
| `POST /posts/:id/report` | Report a post with a required reason |
| `GET /semesters` | List closed semesters |
| `GET /semesters/:id/posts` | Paginate live posts in a closed semester |

Post creation accepts `displayName`, `body` (maximum 300 characters), optional `category`, and `captchaToken` unless the local/test-only bypass is enabled. The edit key is returned once. The browser must send credentialed cross-origin requests for the anonymous cookie and must use an allowed Origin on post/interaction writes.

### Admin routes

Admin paths are protected by a separate router and should also be restricted at the deployment boundary.

- Authentication: `POST /admin/login`, `POST /admin/logout`.
- Moderators: `GET/POST /admin/moderators`, `DELETE /admin/moderators/:id` (admin-only).
- Moderation: `GET /admin/queue`, `GET /admin/rejected`; `POST /admin/posts/:id/approve`, `/reject`, `/undo`, and `/restore`.
- Banned terms: `GET/PUT /admin/banned-terms` (admin-only).
- Categories: `GET/PUT /admin/categories` (admin-only).
- Analytics: `GET /admin/analytics`, optionally filtered by `semesterId` (admin-only).
- Featuring: `POST /admin/posts/:id/feature`, `DELETE /admin/posts/:id/feature` (admin-only).
- Semesters: `POST /admin/semesters/:id/archive` (admin-only).

Admin sessions use secure, HttpOnly cookies. Mutating admin calls require an allowed Origin and CSRF token.

## Database migrations

Migrations `001`–`017` create and extend the schema for semesters, posts, interactions, rate limits, admin authentication, moderation, progress, categories, featured posts, analytics, audit logging, abuse controls, auth cleanup, and hashed interaction identifiers.

Migration `017` adds version and format constraints to interaction identifiers. Run it and the data backfill with old API instances stopped. Rehearse on a restored staging copy and take a verified backup before production migration. Production migrations must use the separate migration role.

The local development database was migrated through `017`; the backfill processed zero interaction rows there. No production database was migrated. The backfill test suite uses a mock client; it is not an integration test against PostgreSQL.

## Tests and verification

Run the backend API tests:

```sh
npm run test:api
```

The suite covers routes and validation, authentication and authorization, posts and edits, likes and reports, moderation, rate limiting, CAPTCHA, search/feed behavior, database-role checks, migration locking, and the backfill helper.

Most recent verified results:

- API tests: 137 passed.
- `npm run build`: passed.
- `npx tsc --noEmit -p backend/tsconfig.json`: passed.
- `npm audit`: zero reported vulnerabilities.
- `git diff --check`: passed.

No lint script or backend ESLint configuration is included.

## Production checklist and limitations

- Set `NODE_ENV=production`, `DATABASE_URL` with `sslmode=verify-full`, a distinct `MIGRATION_DATABASE_URL`, exact `TRUSTED_PROXIES`, and Turnstile expected hostname/action.
- Ensure the HTTPS-terminating proxy overwrites forwarded protocol headers and is the only trusted source for them.
- Provision a non-owner runtime role with least-privilege grants and a separate migration role. Configure grants/default privileges for future tables.
- Set exact `CORS_ORIGINS`; the separate frontend must use HTTPS and include credentials for cross-origin cookie requests.
- Restrict admin routes at the deployment boundary. CORS is not authorization.
- Configure encrypted backups, retention, point-in-time recovery where available, restricted backup access, and restore drills.
- Externalize audit logs if protection from database owners/superusers is required.
- Preserve `IP_HASH_SECRET` while keeping interaction identity history. Rotating it changes the pseudonyms and cannot re-key stored cookie hashes.
- The anonymous cookie can be cleared or replaced and is not device attestation. It reduces casual identity changes but cannot stop determined automation.
- Legacy client-supplied device IDs cannot be securely associated with new anonymous cookies. Old likes may not be removable by the visitor, and reports from a legacy ID and a new cookie may count as different identities.
- Admin MFA is not implemented. Review as a separate security enhancement.
- Passing tests and dependency audits do not prove production security. Validate migrations, role grants, proxy behavior, backups, frontend credentials, and recovery procedures in staging.
