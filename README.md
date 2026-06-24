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

Auto-commits on return. Auto-rolls-back on throw. In `pglite` mode, concurrent `transaction()` calls queue on PGlite's exclusive lock instead of interleaving statements on the single shared connection — same isolation expectations as `pg` mode, where each transaction gets its own pooled connection.

### LISTEN/NOTIFY

```ts
const unlisten = await db.listen('events', (payload) => {
  console.log('got', payload);
});

await db.notify('events', 'user.created');

// later
await unlisten();
```

Same API in both modes. In `pg` mode, notifications arrive on one dedicated connection (separate from the pool) that auto-reconnects with capped exponential backoff and re-`LISTEN`s every subscribed channel if the server connection drops. In `pglite` mode it delegates to PGlite's native `listen()`. `notify()` uses `pg_notify()` under the hood, so channel names and payloads need no manual quoting.

### Health check

```ts
app.get('/health', async () => ({ db: await db.ping() }));
```

`ping()` runs `SELECT 1` and returns `true`/`false` — it never throws, so it wires straight into a health endpoint.

### Migrations

```ts
import { migrate } from '@askalf/pgflex';

const { applied, skipped } = await migrate(db, { dir: './migrations' });
```

A tiny, dependency-free runner with deliberately boring conventions: plain `.sql` files, applied in lexicographic filename order (`001_init.sql`, `002_add_users.sql`, ...), tracked in a `pgflex_migrations` table (rename via `table:`). Each file runs inside its own transaction together with its tracking row — a failed migration rolls back completely, is not recorded, and stops the run with an error naming the file. Already-applied files are skipped, so calling `migrate()` at every startup is the intended usage.

Because it runs on the `DatabaseAdapter` interface, the **same migration files** drive real Postgres in production and PGlite in dev/CI — your schema setup stops being the thing that differs between modes.

Multi-statement files work in both modes via the adapter's `exec()` (also public: `db.exec(sql)` runs any multi-statement script verbatim).

## The interface

```ts
interface DatabaseAdapter {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(text: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;  // multi-statement scripts
  transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;
  listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload?: string): Promise<void>;
  ping(): Promise<boolean>;
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

`vector` (pgvector) is wired end-to-end — both the JS-side WASM hooks and `CREATE EXTENSION vector` happen during `init()`. PGlite 0.5 moved pgvector out of the core package into [`@electric-sql/pglite-pgvector`](https://www.npmjs.com/package/@electric-sql/pglite-pgvector) (in our `optionalDependencies`, so it's installed by default); the loader also falls back to the pre-0.5 `@electric-sql/pglite/vector` subpath, so both layouts work.

Other PGlite contrib extensions (`uuid-ossp`, `pgcrypto`, `tsm_system_rows`, etc.) need their own JS-side import to register the WASM hooks. Listing them in the `extensions` array currently only runs `CREATE EXTENSION IF NOT EXISTS <name>`, which is enough for extensions baked into PGlite's core WASM but not enough for the contrib ones. Open an issue if you need one wired up; they're ~5 lines each.

In `pg` mode, extensions are the database admin's responsibility — they're either there or they aren't.

## Optional dependency

`@electric-sql/pglite` (and `@electric-sql/pglite-pgvector`) are in `optionalDependencies`, so:

- If you only ever use `pg` mode, you can install with `--omit=optional` and skip the WASM bytes.
- If you use `pglite` mode, they get installed by default.

If pglite mode is selected and the package isn't installed, `init()` throws a clear error telling you what to install.

## Pool tuning (pg mode)

```ts
const db = await createAdapter({
  mode: 'pg',
  connectionString: process.env.DATABASE_URL!,
  pool: {
    max: 20,                       // pool size
    idleTimeoutMillis: 30_000,     // close idle connections
    connectionTimeoutMillis: 15_000,
    statementTimeoutMillis: 30_000, // per-connection statement_timeout; 0 = don't set
  },
});
```

All four default to the values shown — protective enough that a runaway query or exhausted pool can't deadlock the app. Pass `statementTimeoutMillis: 0` to leave the server's own `statement_timeout` in charge.

## Escape hatch

```ts
import { PgAdapter } from '@askalf/pgflex';

const adapter = new PgAdapter(process.env.DATABASE_URL!);
const pool = adapter.getPool();  // raw pg.Pool — for COPY, cursors, etc.
```

Use sparingly. Code that touches the underlying pool won't work in pglite mode.

## What it isn't

- **Not an ORM.** It's a thin adapter. Bring your own query builder and schema-validator (a minimal migration runner IS included — see above). It composes with anything that can take a `query(text, params)` function.
- **Not a connection pooler.** `pg` mode uses `pg.Pool` directly; `pglite` mode is single-process by design.
- **Not magic.** If you write `pg`-only SQL (e.g. `pg_sleep`, server-side functions you've installed yourself, advisory locks), it'll fail in pglite mode the same way `pg` would fail without those features.

## License

MIT — see [LICENSE](LICENSE).

## Also by askalf

| Project | What it does |
|---------|-------------|
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container. CDP on 9222 — Playwright/Puppeteer/MCP-compatible. |
| [dario](https://github.com/askalf/dario) | Local LLM router. Use your Claude Max/Pro subscription as an API. |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent. Plan → search → fetch → extract → synthesize. Cited answers. |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent. Mouse, keyboard, screen. |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API. Two modes (ioredis ↔ in-process). |


---

## Built by Sprayberry Labs

This is one of the open-source building blocks from **[Sprayberry Labs](https://sprayberrylabs.com)** — an independent studio (Atlanta, GA) that ships bespoke software and **fixed-price code & security audits**, delivered with the AI workforce these tools are part of.

Part of the [askalf](https://askalf.org) ecosystem — a self-hosted AI workforce platform, now in early access.

**Got a codebase that needs an expert read?** → **[Scan a repo — free mini-audit](https://sprayberrylabs.com)**, or see the **$1,500 fixed-price Audit** and build Sprints. · [sprayberrylabs.com](https://sprayberrylabs.com) · hello@sprayberrylabs.com

---
Part of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it. Built by Thomas Sprayberry.
