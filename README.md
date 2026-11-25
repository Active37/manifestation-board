# BUCC Manifestation Board

Anonymous goal-board REST API built with **Node.js**, **TypeScript**,
**Express**, and **PostgreSQL**.

## Features

- Create, edit, and remove semester goals without user accounts.
- Browse and search goals, track progress, like, and report posts.
- Moderate content with separate admin and moderator roles.
- Protect requests with validation, rate limits, CAPTCHA, and audit logs.

## Get started

**Requirements:** Node.js 20.6 or newer and PostgreSQL.

```powershell
npm install
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

Set `DATABASE_URL`, `CORS_ORIGINS`, `IP_HASH_SECRET` (at least 32 characters),
and `TURNSTILE_SECRET_KEY` in `.env`. Add a semester with `state = 'open'`
before creating posts. The API listens on port `3001`; check
`http://localhost:3001/health`.

Optional numeric settings in `.env.example` can be removed to use defaults.
Do not leave them blank.

For local testing without a CAPTCHA widget, set `POST_CAPTCHA_BYPASS=true`.
It is off by default, rejected in production, and does not disable post
rate-limits. Production always requires valid CAPTCHA verification.

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start the API in watch mode |
| `npm run build` | Compile the backend |
| `npm start` | Run the compiled API |
| `npm run test:api` | Run the API tests |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:hash-interaction-devices` | Backfill legacy interaction IDs |
| `npm run admin:bootstrap` | Create the first admin account |

Run the interaction backfill only when upgrading an existing database. For
production, rehearse migrations on staging, use verified TLS and a separate
migration role, and keep encrypted backups.

## API

- Public routes: `/health`, `/names`, `/posts`, and `/semesters`
- Admin routes: `/admin` for login, moderation, and board management
- Post edits and removals require the one-time `X-Edit-Key`.
- Admin mutations require a session, role authorization, and CSRF token.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development rules and
[BACKEND-CONTRIBUTION.md](./BACKEND-CONTRIBUTION.md) for the detailed backend
guide, endpoint list, and deployment notes.
