/**
 * @askalf/pgflex — one Postgres API, two modes.
 *
 *   import { createAdapter } from '@askalf/pgflex';
 *
 *   // Production: real PostgreSQL server
 *   const db = await createAdapter({
 *     mode: 'pg',
 *     connectionString: process.env.DATABASE_URL!,
 *   });
 *
 *   // Dev / standalone: PGlite (in-process WASM, no server)
 *   const db = await createAdapter({
 *     mode: 'pglite',
 *     dataDir: '~/.myapp/data',
 *   });
 *
 *   const rows = await db.query('SELECT * FROM users WHERE active = $1', [true]);
 *
 *   // LISTEN/NOTIFY — same API in both modes
 *   const unlisten = await db.listen('events', (payload) => console.log(payload));
 *   await db.notify('events', 'user.created');
 *
 * Same SQL works in both modes. Pick the mode at startup; the rest of
 * your app sees one `DatabaseAdapter` interface.
 */

export type {
  DatabaseAdapter,
  NotificationHandler,
  QueryResultRow,
  TransactionClient,
} from './interface.js';
export { PgAdapter, type PgAdapterOptions } from './pg-adapter.js';
export { PGliteAdapter, type PGliteAdapterOptions } from './pglite-adapter.js';

import { PgAdapter, type PgAdapterOptions } from './pg-adapter.js';
import { PGliteAdapter, type PGliteAdapterOptions } from './pglite-adapter.js';
import type { DatabaseAdapter } from './interface.js';

/** Strict union of valid adapter configs. The mode field discriminates. */
export type AdapterConfig =
  | { mode: 'pg'; connectionString: string; pool?: PgAdapterOptions }
  | ({ mode: 'pglite' } & PGliteAdapterOptions);

/** Build an adapter from explicit config. PGlite mode auto-runs `init()`
 *  for you so the caller always gets a ready-to-query adapter back. */
export async function createAdapter(config: AdapterConfig): Promise<DatabaseAdapter> {
  if (config.mode === 'pglite') {
    const { mode: _mode, ...rest } = config;
    void _mode;
    const adapter = new PGliteAdapter(rest);
    await adapter.init();
    return adapter;
  }

  return new PgAdapter(config.connectionString, config.pool);
}

export interface FromEnvOptions {
  /** Env var name that selects the mode. Default `'PGFLEX_MODE'`. Set
   *  to `'pglite'` for in-process WASM, anything else for pg mode. */
  modeEnvVar?: string;
  /** Env var name that holds the connection string for `pg` mode.
   *  Default `'DATABASE_URL'`. */
  connectionStringEnvVar?: string;
  /** Env var name that holds the data directory for `pglite` mode.
   *  Default `'PGFLEX_DATA_DIR'`. If unset, falls back to
   *  `<HOME>/.pgflex/data` (or `<APPDATA>\pgflex\data` on Windows). */
  dataDirEnvVar?: string;
  /** Extensions to enable in pglite mode. Forwarded to `PGliteAdapter`. */
  pgliteExtensions?: ReadonlyArray<string>;
}

/** Build an adapter from environment variables. Convenient for apps
 *  that flip modes via deploy config rather than code change. */
export async function createAdapterFromEnv(opts: FromEnvOptions = {}): Promise<DatabaseAdapter> {
  const modeVar = opts.modeEnvVar ?? 'PGFLEX_MODE';
  const csVar = opts.connectionStringEnvVar ?? 'DATABASE_URL';
  const dataDirVar = opts.dataDirEnvVar ?? 'PGFLEX_DATA_DIR';

  const mode = process.env[modeVar];

  if (mode === 'pglite') {
    const dataDir = process.env[dataDirVar] ?? defaultPGliteDataDir();
    return createAdapter({
      mode: 'pglite',
      dataDir,
      ...(opts.pgliteExtensions ? { extensions: opts.pgliteExtensions } : {}),
    });
  }

  const connectionString = process.env[csVar];
  if (!connectionString) {
    throw new Error(
      `${csVar} is required for pg mode (set ${modeVar}=pglite to use in-process PGlite instead)`,
    );
  }
  return createAdapter({ mode: 'pg', connectionString });
}

function defaultPGliteDataDir(): string {
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? process.env['USERPROFILE'] ?? '.';
    return `${appdata}\\pgflex\\data`;
  }
  const home = process.env['HOME'] ?? '.';
  return `${home}/.pgflex/data`;
}
