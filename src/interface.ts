/**
 * Database adapter interface — the contract every pgflex adapter
 * implements. Lets your app issue one set of queries that runs against
 * either a real PostgreSQL server (`pg` mode) or PGlite (in-process
 * WASM, `pglite` mode) without changing any SQL.
 *
 * Both adapters speak full PostgreSQL dialect, so positional parameters
 * (`$1`, `$2`), JSONB, ON CONFLICT, RETURNING, TIMESTAMPTZ, triggers,
 * functions, and pgvector all work identically across modes.
 */

export interface QueryResultRow {
  [key: string]: unknown;
}

/** Handler invoked for each NOTIFY received on a channel subscribed
 *  via `listen()`. `payload` is the notification payload (empty string
 *  when the NOTIFY carried none). */
export type NotificationHandler = (payload: string) => void;

export interface TransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;

  /** Run a multi-statement SQL script inside this transaction. Unlike
   *  `query`, takes no parameters — scripts (DDL, seed files,
   *  migrations) are executed verbatim. */
  exec(sql: string): Promise<void>;
}

export interface DatabaseAdapter {
  /** Execute a query and return all rows. */
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;

  /** Execute a query and return the first row, or null if none. */
  queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null>;

  /** Run a multi-statement SQL script (DDL, seed files, migration
   *  files). Unlike `query`, takes no parameters and returns no rows —
   *  the script is executed verbatim. In `pg` mode this uses the
   *  simple query protocol (which allows multiple statements); in
   *  `pglite` mode it delegates to PGlite's `exec()`. */
  exec(sql: string): Promise<void>;

  /** Run a function inside a transaction. Auto-commits on success,
   *  rolls back if the function throws. */
  transaction<T>(
    fn: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;

  /** Subscribe to a NOTIFY channel. The handler fires once per
   *  notification. Returns an unlisten function — call it to remove
   *  this handler (the channel subscription is dropped when its last
   *  handler is removed). In `pg` mode notifications arrive on a
   *  dedicated connection that auto-reconnects and re-LISTENs if the
   *  server connection drops. */
  listen(
    channel: string,
    handler: NotificationHandler,
  ): Promise<() => Promise<void>>;

  /** Send a NOTIFY on a channel (via `pg_notify`, so channel names and
   *  payloads need no manual quoting). */
  notify(channel: string, payload?: string): Promise<void>;

  /** Liveness probe — runs `SELECT 1` and reports whether it succeeded.
   *  Never throws; wire it straight into a `/health` endpoint. */
  ping(): Promise<boolean>;

  /** Close the underlying connection / pool. */
  close(): Promise<void>;

  /** Which backend is in use. */
  readonly mode: 'pg' | 'pglite';
}
