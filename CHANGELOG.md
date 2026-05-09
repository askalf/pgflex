# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

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
