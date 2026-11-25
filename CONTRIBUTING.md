# Contributing

This guide applies to contributions to the BUCC Manifestation Board. Preserve existing work and follow the current codebase patterns unless a task explicitly requires a change.

## Before starting

- Read this guide and `README.md`. Inspect the relevant implementation, tests, scripts, and migrations before proposing changes.
- Check `git status` and the current branch. Do not overwrite or discard existing changes.
- Work on a short, kebab-case branch named `feat/*`, `fix/*`, `chore/*`, or `docs/*`. Never commit directly to `master` or `staging`.
- Start new work from the latest `staging`. After preserving any local changes, use:

  ```sh
  git checkout staging
  git pull
  git checkout -b feat/short-description
  ```

- Keep feature work updated with `git pull origin staging`. Resolve conflicts on the feature branch only.
- If `staging` is unavailable or existing work makes switching unsafe, stop and confirm a safe plan with the maintainer. Do not force the workflow with destructive Git commands.

## Plan and scope

Before implementation, explain the approach in 2–3 short lines, list the exact files to create or modify, and identify database changes and dependencies. Get approval before adding dependencies. Do not begin implementation until the proposed approach is approved.

Make the smallest focused change that meets the task. Do not add unrelated features, refactor unnecessarily, or remove existing work.

## Architecture and code style

- Follow the existing architecture and conventions. Group new code by feature.
- Keep HTTP handlers thin: parse and validate input, call services, and return a response. Keep business logic out of handlers and services independent of HTTP.
- Access each external system through the project’s shared integration point; avoid using external SDKs directly across features.
- If types or validation schemas are shared with the separately maintained frontend, keep their source in a shared package rather than duplicating them.
- Prefer short, clear functions and names. Avoid unnecessary abstractions and dependencies.
- Add comments only to explain non-obvious intent. Do not add trivial JSDoc, commented-out code, unused files, or leftover debug logging.

## API requirements

- New endpoints use `/v1/` paths and plural resource names. Preserve existing endpoints and contracts; introduce a new version for breaking changes and keep the old version available during client migration.
- Use `GET` to read, `POST` to create or perform actions, `PATCH` to edit, and `DELETE` to remove.
- Use the shared response-envelope implementation. Paginate every list endpoint.
- Validate all inputs with schemas. Apply authentication by default, explicitly documenting intentionally public endpoints, and rate-limit every endpoint. Apply stricter limits to authentication endpoints.
- Use typed application errors for expected failures. Give each a stable error code; do not rename or reuse existing codes. Frontend error handling should use codes, not messages.
- Add every new or modified endpoint to the API collection and API documentation, including example request bodies where applicable.

## Security and configuration

- Do not weaken security to make implementation easier. Never log passwords, tokens, cookies, headers, request bodies, or secrets.
- Declare settings in the central settings module, validate them at startup, and document them in `.env.example`. Do not read environment variables directly elsewhere.
- Never commit `.env` files, credentials, API keys, or other secrets.

## Frontend integration

This repository contains backend code only. Do not add or modify frontend source here unless a task explicitly requires it. Preserve documented API contracts needed by the separately maintained frontend.

## Database

- Inspect the current schema and migrations before changing database behavior.
- Include a suitable migration for every schema change. Preserve existing data; do not modify a live database directly.
- Explain the migration and database impact in the contribution or pull request description.

## Testing

Before requesting review, run:

```sh
npm run build
npx tsc --noEmit -p backend/tsconfig.json
npm run test:api
```

Add focused tests for new or changed behavior, and run relevant existing tests. Report only checks that actually ran and their results.

## Commits and pull requests

- Do not commit or push without explicit authorization.
- Use Conventional Commit subjects in the form `type(scope): imperative summary`, under 72 characters. Allowed types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, and `style`. Do not add AI co-author or generated-by attribution lines.
- Include a commit body with bullets explaining each change and why, followed by a `Checked:` line listing the checks run.
- Target pull requests to `staging`, never `master`. Include what changed and why, reviewer test steps, endpoint and API-collection updates, and migration details where applicable.
- Before review, verify the branch is based on `staging`, required checks pass, API changes are documented, settings are validated and listed, frontend integration requirements are met when relevant, no debug output or unused code remains, and no secrets are included.
- Respond to requested changes with new commits. Never force-push to rewrite review history.
