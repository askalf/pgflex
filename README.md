# @askalf/pgflex

> One Postgres API. Two modes. Same SQL.

Switch between a **real PostgreSQL server** (`pg`) and **in-process PostgreSQL** (PGlite, WASM) with one line of config. Production runs on real Postgres; dev / standalone / "no-Docker mode" runs in-process. Same SQL, same query shape, same parameter style — drop the server when you don't need it.

```bash
npm install @askalf/pgflex
```

[![CI](https://img.shields.io/github/actions/workflow/status/askalf/pgflex/ci.yml?style=flat-square&label=CI&labelColor=020612)](https://github.com/askalf/pgflex/actions)
[![npm](https://img.shields.io/npm/v/@askalf/pgflex?style=flat-square&color=00ff88&label=npm&labelColor=020612)](https://www.npmjs.com/package/@askalf/pgflex)
[![License](https://img.shields.io/badge/MIT-00ff88?style=flat-square&label=license&labelColor=020612)](LICENSE)

## Why

Most apps need Postgres. Most dev environments don't want the overhead of running a Postgres server. Most CI environments REALLY don't want it. PGlite ([electric-sql/pglite](https://pglite.dev)) gives you full PostgreSQL — JSONB, `ON CONFLICT`, `RETURNING`, triggers, functions, even pgvector — running in WASM, in your Node process, with no server, no port, no Docker.

`pgflex` is the thin adapter on top: one `DatabaseAdapter` interface, two backends, mode flips via config or env var. Your SQL, your transactions, and your codepaths stay identical between modes.

## Use it

### Direct

```ts
import { createAdapter } from '@askalf/pgflex';

// Production — real Postgres server
const db = await createAdapter({
  mode: 'pg',
  connectionString: process.env.DATABASE_URL!,
});

// Dev / standalone — PGlite, no server needed
const db = await createAdapter({
  mode: 'pglite',
  dataDir: '~/.myapp/data',  // or 'memory://' for ephemeral
});

const users = await db.query<{ name: string }>(
  'SELECT name FROM users WHERE active = $1',
  [true],
);
```

### From environment

```ts
import { createAdapterFromEnv } from '@askalf/pgflex';

// PGFLEX_MODE=pglite     → pglite at $PGFLEX_DATA_DIR (or ~/.pgflex/data)
// otherwise              → pg at $DATABASE_URL
const db = await createAdapterFromEnv();
```

You can rename any of the env vars:

```ts
const db = await createAdapterFromEnv({
  modeEnvVar: 'MYAPP_MODE',
  connectionStringEnvVar: 'MYAPP_DB_URL',
  dataDirEnvVar: 'MYAPP_DATA_DIR',
  pgliteExtensions: ['vector'],
});
```

### Transactions

```ts
const transferred = await db.transaction(async (tx) => {
  await tx.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [30, 1]);
  await tx.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [30, 2]);
  return 30;
});
```

Auto-commits on return. Auto-rolls-back on throw.

## The interface

```ts
interface DatabaseAdapter {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(text: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly mode: 'pg' | 'pglite';
}
```

That's it. Same shape across both backends. `db.mode` is exposed if some piece of your app needs to branch on the runtime — but most don't.

## Extensions (pglite mode)

```ts
const db = await createAdapter({
  mode: 'pglite',
  dataDir: 'memory://',
  extensions: ['vector'],
});

await db.query('CREATE TABLE docs (id INT, embedding vector(1536))');
```

v0.0.1 wires `vector` (pgvector) end-to-end — both the JS-side WASM hooks and `CREATE EXTENSION vector` happen during `init()`.

Other PGlite contrib extensions (`uuid-ossp`, `pgcrypto`, `tsm_system_rows`, etc.) need their own JS-side import to register the WASM hooks. Listing them in the `extensions` array currently only runs `CREATE EXTENSION IF NOT EXISTS <name>`, which is enough for extensions baked into PGlite's core WASM but not enough for the contrib ones. Open an issue if you need one wired up; they're ~5 lines each.

In `pg` mode, extensions are the database admin's responsibility — they're either there or they aren't.

## Optional dependency

`@electric-sql/pglite` is in `optionalDependencies`, so:

- If you only ever use `pg` mode, you can install with `--no-optional` and skip the WASM bytes.
- If you use `pglite` mode, it gets installed by default.

If pglite mode is selected and the package isn't installed, `init()` throws a clear error telling you what to install.

## Statement timeout

In `pg` mode, every connection gets `SET statement_timeout = 30000` automatically. Protects the pool from runaway queries. Override at the SQL level (`SET statement_timeout = ...`) or open an issue if you need it tunable from the adapter config.

## Escape hatch

```ts
import { PgAdapter } from '@askalf/pgflex';

const adapter = new PgAdapter(process.env.DATABASE_URL!);
const pool = adapter.getPool();  // raw pg.Pool — for LISTEN/NOTIFY etc.
```

Use sparingly. Code that touches the underlying pool won't work in pglite mode.

## What it isn't

- **Not an ORM.** It's a thin adapter. Bring your own query builder, schema-validator, migration tool. It composes with anything that can take a `query(text, params)` function.
- **Not a connection pooler.** `pg` mode uses `pg.Pool` directly; `pglite` mode is single-process by design.
- **Not magic.** If you write `pg`-only SQL (e.g. `pg_sleep`, server-side functions you've installed yourself, advisory locks), it'll fail in pglite mode the same way `pg` would fail without those features.

## License

MIT — see [LICENSE](LICENSE).

## Also by askalf

| Project | What it does |
|---------|-------------|
| [arnie](https://github.com/askalf/arnie) | Portable IT troubleshooting companion. Networking, AD, Windows Update, package managers, log triage, hardware checks. |
| [brio](https://github.com/askalf/brio) | Capability layer for AI workloads — semantic cache, cost tiering, policy. Sits in front of any Anthropic-compat endpoint. |
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container. CDP on 9222 — Playwright/Puppeteer/MCP-compatible. |
| [claude-bridge](https://github.com/askalf/claude-bridge) | Bridge Claude Code sessions to Discord. |
| [dario](https://github.com/askalf/dario) | Local LLM router. Use your Claude Max/Pro subscription as an API. |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent. Plan → search → fetch → extract → synthesize. Cited answers. |
| [git-providers](https://github.com/askalf/git-providers) | Unified GitHub + GitLab + Bitbucket Cloud REST clients behind one GitProvider interface. Plus a 44-entry api-key-provider taxonomy. |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent. Mouse, keyboard, screen. |
| [install-kit](https://github.com/askalf/install-kit) | curl-pipe-bash template for self-hosted Docker apps. |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API. Two modes (ioredis ↔ in-process). |
