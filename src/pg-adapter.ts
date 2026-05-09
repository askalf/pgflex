/**
 * PgAdapter — wraps a `pg.Pool`. The "production" mode: connects to a
 * real PostgreSQL server (Docker, RDS, Supabase, anything that speaks
 * the wire protocol).
 *
 * Defaults: pool of 20, 30s idle timeout, 15s connect timeout, and a
 * 30s statement_timeout set on every fresh connection. Override `max`
 * via constructor opts; the timeouts are deliberately not exposed —
 * they're sane defaults that protect a pool from runaway queries and
 * exhausted-connection deadlocks. Open a feature request if you need
 * to tune them.
 */

import pg from 'pg';
import type { DatabaseAdapter, QueryResultRow, TransactionClient } from './interface.js';

const { Pool } = pg;

export interface PgAdapterOptions {
  /** Max pool size. Default 20. */
  max?: number;
}

export class PgAdapter implements DatabaseAdapter {
  readonly mode = 'pg' as const;
  private pool: pg.Pool;

  constructor(connectionString: string, opts?: PgAdapterOptions) {
    this.pool = new Pool({
      connectionString,
      max: opts?.max ?? 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });

    this.pool.on('error', (err) => {
      // Idle-client errors are routed to stderr rather than propagated:
      // the failing client is auto-removed from the pool, so the next
      // query gets a fresh one. Surfacing means operators see it without
      // a request-level callback being invoked unexpectedly.
      process.stderr.write(`[pgflex/pg] idle client error: ${err.message}\n`);
    });

    this.pool.on('connect', (client) => {
      // Per-connection statement timeout. Survives connection reuse
      // because pg sets it on the session, not the pool.
      client.query('SET statement_timeout = 30000').catch((err: Error) => {
        process.stderr.write(`[pgflex/pg] failed to set statement_timeout: ${err.message}\n`);
      });
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, params);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async transaction<T>(
    fn: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Escape hatch: get the underlying `pg.Pool` for code that needs it
   *  (LISTEN/NOTIFY, pg-specific options, etc.). Use sparingly — code
   *  that touches the pool directly won't work in pglite mode. */
  getPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
