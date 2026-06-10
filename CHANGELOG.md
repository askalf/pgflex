# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

### Added

- **`migrate(db, { dir })` — a tiny, dependency-free migration
  runner.** Plain `.sql` files applied in lexicographic filename order,
  tracked in a `pgflex_migrations` table (configurable via `table:`).
  Each file runs in its own transaction with its tracking row — a
  failure rolls back completely, is not recorded, and stops the run
  with an error naming the file. Already-applied files are skipped, so
  running it at every startup is the intended usage. Works on the
  `DatabaseAdapter` interface, so the same migration files drive real
  Postgres in production and PGlite in dev/CI.
- `exec(sql)` on `DatabaseAdapter` and `TransactionClient` — run a
  multi-statement SQL script verbatim (simple query protocol in `pg`
  mode, PGlite's `exec()` in `pglite` mode).

## [0.1.0] - 2026-06-10

First feature release since extraction.

### Added

- **LISTEN/NOTIFY across both modes** — `db.listen(channel, handler)`
  returns an unlisten function; `db.notify(channel, payload?)` sends via
  `pg_notify()` (no manual quoting). In `pg` mode notifications arrive
  on one dedicated connection (separate from the pool) that
  auto-reconnects with capped exponential backoff (1s → 30s) and
  re-`LISTEN`s every subscribed channel after a drop. In `pglite` mode
  it delegates to PGlite's native `listen()`.
- `ping()` — `SELECT 1` liveness probe that returns `true`/`false` and
  never throws. Wire it straight into a `/health` endpoint.
- Pool tuning in `pg` mode: `idleTimeoutMillis`,
  `connectionTimeoutMillis`, and `statementTimeoutMillis` (0 = don't
  set) join `max` on `PgAdapterOptions`. Defaults unchanged.
- `NotificationHandler` exported from the package root.

### Changed

- **PGlite 0.5 support** — `@electric-sql/pglite` bumped to `^0.5.1`.
  PGlite 0.5 moved pgvector out of the core package; the extension
  loader now tries `@electric-sql/pglite-pgvector` (new, added to
  `optionalDependencies`) and falls back to the pre-0.5
  `@electric-sql/pglite/vector` subpath, so both layouts work.
- `pglite` transactions now delegate to PGlite's native exclusive
  `transaction()` instead of hand-rolled `BEGIN`/`COMMIT`.

### Fixed

- **Concurrent `transaction()` calls in pglite mode no longer
  interleave.** Previously two simultaneous transactions shared the
  single connection's `BEGIN`/`COMMIT` and could lose writes; they now
  queue on PGlite's exclusive lock (regression test included).
- A failed `ROLLBACK` in `pg` mode (e.g. connection died
  mid-transaction) no longer masks the error the transaction callback
  actually threw; the broken client is handed back to the pool for
  destruction instead of being reused.

## [0.0.2] - 2026-05-09 — npm-orphan

(v0.0.1 was tagged + GitHub-released but never reached npm — the freshly-created repo didn't have an `NPM_TOKEN` secret yet, so the auto-release workflow's `npm publish` step exited `ENEEDAUTH`. After provisioning the token, the version-changed gate considered v0.0.1 already-shipped from its perspective, so this re-tag bumps to v0.0.2 with identical content. Same pattern as brio 0.0.1 → 0.0.2 → 0.0.3 a few hours ago.)

Identical content to the v0.0.1 entry below.

## [0.0.1] - 2026-05-09

Initial release. Extracted from a private monorepo where the same
shape ran in production and in standalone / dev. Same SQL, same
transaction semantics, two backends.

### Added

- `createAdapter({ mode: 'pg' | 'pglite', ... })` — explicit factory.
- `createAdapterFromEnv()` — env-driven factory with configurable
  variable names (defaults: `PGFLEX_MODE`, `DATABASE_URL`,
  `PGFLEX_DATA_DIR`).
- `PgAdapter` — wraps `pg.Pool`; defaults to a 20-connection pool with
  30s idle timeout, 15s connect timeout, and a per-connection 30s
  `statement_timeout`. `getPool()` escape hatch for raw access.
- `PGliteAdapter` — runs PostgreSQL in-process via WASM. Opt-in
  extensions via `{ extensions: ['vector', 'uuid-ossp', ...] }`.
- Unified `DatabaseAdapter` interface: `query`, `queryOne`,
  `transaction`, `close`, `mode`.
- TypeScript build → `dist/`. `engines: node >=20`.
- CI matrix on Node 20 + 22 across Ubuntu and Windows. CodeQL.
  actionlint. Auto-release on `package.json` version bump.
