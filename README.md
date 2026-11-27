# BUCC Manifestation Board API

Anonymous semester-goal board backend built with Node.js, TypeScript, Express, and PostgreSQL.

**Frontend/API reference:** [API Specification](API-SPEC.md) contains every route, request and response shape, required header, enum, error, and integration note.

## Requirements

- Node.js 20.6 or newer
- PostgreSQL 16 or newer

## Local setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL`, `CORS_ORIGINS` to the exact browser origin(s), `IP_HASH_SECRET` to at least 32 random characters, and `TURNSTILE_SECRET_KEY` in `.env`. Leave `TRUSTED_PROXIES` empty for direct local development. Rate limits default to 3 posts per hour and 30 likes per minute.

For production, `DATABASE_URL` must use `sslmode=verify-full`; set `MIGRATION_DATABASE_URL` to a separate migration role with the same verified TLS requirement. Configure exact `TRUSTED_PROXIES`, HTTPS-only `CORS_ORIGINS`, `TURNSTILE_EXPECTED_HOSTNAME`, and `TURNSTILE_EXPECTED_ACTION`. The runtime refuses to start over insecure HTTP and checks that its PostgreSQL role is not privileged or an owner of application objects.

Apply and verify the database schema:

```powershell
npm run db:migrate
npm run db:verify
```

Create the first administrator by temporarily setting `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` in `.env`, then running:

```powershell
npm run admin:bootstrap
```

The bootstrap command refuses to create another admin when an active admin already exists. Remove the bootstrap values after use.

After login, create the initial open semester with the admin API (`POST /admin/semesters`). Admins can close it at semester end and create the next one. Post creation and owner edits/deletes are blocked while no semester is open.

Run the API:

```powershell
npm run dev
```

The default address is `http://localhost:3001`.

## Public API

- `GET /names/random` returns an available name such as `Manifest-Lion-482`.
- `GET /names/check?name=...` checks case-insensitive availability.
- `POST /posts` creates a goal; send `display_name`, `body`, optional `category`, and `captcha_token`. Include `X-Device-Id`. The one-time `edit_key` is returned only at creation. If the poster explicitly opts in to a semester-end check-in, also send optional `check_in_email`.
- `GET /posts/:id/owner` requires `X-Edit-Key`; it returns the poster's post without exposing whether it is held or live, and returns `410` with a neutral message if rejected or removed.
- `GET /posts` returns live posts, 30 per page, with `sort`, `search`, and `cursor` query parameters. Sort values are `shuffle`, `newest`, `most-liked-today`, and `most-liked-all-time`.
- `PATCH /posts/:id` and `DELETE /posts/:id` require `X-Edit-Key`.
- `POST /posts/:id/like` and `DELETE /posts/:id/like` require `X-Device-Id`.
- `POST /posts/:id/report` requires `X-Device-Id` and a reason: `offensive`, `sexual`, `harassment`, `spam`, or `other`. Three distinct device reports hide a live post.

## Admin API

`POST /admin/login` sets an HttpOnly session cookie and returns a CSRF token. Admin mutations require an allowed `Origin` and `X-CSRF-Token`.

- Staff: `GET /admin/queue`, `GET /admin/rejected`, and post-specific `approve`, `reject`, `undo`, and `restore` actions.
- Admin only: `GET/POST /admin/moderators`, `DELETE /admin/moderators/:id`, `GET/PUT /admin/banned-terms`.
- Admin only: `GET/POST /admin/semesters` and `POST /admin/semesters/:id/close` manage the single open semester.
- `POST /admin/logout` ends the session.

Held and report-hidden posts appear in the moderation queue. Rejected posts can be restored for seven days, then are permanently deleted by scheduled cleanup.

## Verification

```powershell
npm run build
npm run db:verify
npm run test:api
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database before running `npm run test:api`. The integration test creates and removes its fixtures, including rate-limit records, one-use CAPTCHA hashes, and test semesters.