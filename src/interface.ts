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

export interface TransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
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

  /** Run a function inside a transaction. Auto-commits on success,
   *  rolls back if the function throws. */
  transaction<T>(
    fn: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;

  /** Close the underlying connection / pool. */
  close(): Promise<void>;

  /** Which backend is in use. */
  readonly mode: 'pg' | 'pglite';
}
