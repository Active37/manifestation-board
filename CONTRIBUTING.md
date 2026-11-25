# Contributing

Thanks for helping improve the BUCC Manifestation Board backend. Keep changes
focused, preserve existing work, and follow the conventions below.

## Workflow

- Read the README and inspect the relevant code, tests, and migrations.
- Check `git status` before making changes; do not discard work you did not make.
- Work on a short `feat/*`, `fix/*`, `docs/*`, or `chore/*` branch. Never commit
  directly to `master` or `staging`.
- Base new work on the team's latest `staging` branch when available. If it is
  unavailable or switching could affect existing work, confirm a safe plan.
- Do not commit or push without explicit authorization.

## Code and API

- Follow the existing TypeScript and backend architecture. Keep handlers thin
  and business logic in services.
- Validate request inputs with schemas, use parameterized SQL, and return
  expected errors through the shared error handling.
- New endpoints use `/v1/`, preserve existing contracts, and include API
  documentation and request examples. Paginate list endpoints.
- Read settings through the validated config module. Document new settings in
  `.env.example`; never commit secrets or log credentials.
- Keep admin routes protected by authentication, role checks, and CSRF
  protection where applicable.

## Database and tests

- Make schema changes with forward-only migrations. Preserve existing data and
  do not modify a live database directly.
- Add focused tests for changed behavior. Run before requesting review:

  ```sh
  npm run build
  npx tsc --noEmit -p backend/tsconfig.json
  npm run test:api
  ```

## Commits and pull requests

- Use Conventional Commit subjects, for example
  `fix(api): validate post category`.
- Keep commits small. Do not add generated or AI co-author attribution.
- Target pull requests to `staging`, never `master`. Include a summary, test
  steps, API documentation updates, and migration details when relevant.
