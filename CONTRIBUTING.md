# Contributing

Run the app against Neon using [README.md](README.md). The implemented design, including
the live-query integration, is in [SPEC.md](SPEC.md).

## Formatting and checks

Use Node.js 22.22.2+ (or 24.15+ / 26+) and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm format:check
pnpm build
pnpm test:unit
```

Prettier formats TypeScript, React, CSS, JSON, HTML and Markdown. Its rules are
in `.prettierrc.json`, with editor defaults in `.editorconfig`. pgFormatter formats
SQL and PL/pgSQL using `.pg-format.json` through `scripts/format-sql.ts`; it
requires Perl. Generated output, dependencies and local service data are ignored.
Keep comments focused on ownership, concurrency, rollback and protocol behavior.

Game constants live in `shared/game-config.ts`. Keep SQL and browser tile codecs
in agreement, including boundary edges and explicit box owners. Board dimensions
are also encoded in the schema and setup SQL; changing a constant alone is not
a supported board migration.

## Full-stack tests

`test:realtime` and `test:e2e` use owned disposable local databases so tests never
write to the configured Neon game. They require a matching Neon Realtime backend
source checkout, PostgreSQL 18 with the Realtime extension installed, and the
Realtime proxy executable. Set these paths for the local fixture:

```sh
export NEON_REALTIME_BACKEND_DIR=/path/to/realtime-backend-checkout
export PG_BIN=/path/to/pg_install/v18/bin
export REALTIME_PROXY_BIN=/path/to/realtime-proxy
pnpm test:realtime
pnpm exec playwright install chromium
pnpm test:e2e
```

The backend checkout must provide `pgxn/neon_realtime/scripts/dev-server.sh`.
The test harness starts Postgres, the proxy and API on separate ports, adds Vite
for browser tests, and removes its database after shutdown. Run these suites
sequentially: they share fixture ports 55441/55442, 8081, 3002 and 5174.
`test:realtime -- --quick` skips the capability-expiry wait during iteration;
the full run checks renewal too.

`dev:local` is a fixture-development helper. It starts a persistent local cluster
under `.local/dev/`, generates local secrets and runs the proxy, API and frontend. Fixture launchers run the database setup
script before the API; the API itself never migrates on startup.
Stop it before rebuilding extensions. The public `dev` command uses the Neon
credentials in `.env` and starts only the application processes.

## Reviewing a change

Run formatting, build and unit checks for every change. Run the full-stack suites
when modifying transactions, tile encoding, identity/quota handling or Realtime
subscriptions. Preserve the one-call draw transaction, sorted tile locks and
committed-write confirmation. Update the specification when behavior changes.

The demo uses Apache-2.0 licensing with Databricks copyright.
