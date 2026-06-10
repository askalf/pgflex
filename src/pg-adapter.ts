/**
 * PgAdapter — wraps a `pg.Pool`. The "production" mode: connects to a
 * real PostgreSQL server (Docker, RDS, Supabase, anything that speaks
 * the wire protocol).
 *
 * Defaults: pool of 20, 30s idle timeout, 15s connect timeout, and a
 * 30s statement_timeout set on every fresh connection. All four are
 * tunable via constructor opts; the defaults are deliberately
 * protective — they keep a pool safe from runaway queries and
 * exhausted-connection deadlocks.
 *
 * LISTEN/NOTIFY: `listen()` lazily opens ONE dedicated connection
 * (separate from the pool — a pooled client could be handed to someone
 * else between notifications). If that connection drops, the adapter
 * reconnects with capped exponential backoff and re-LISTENs every
 * subscribed channel. `notify()` goes through the pool via
 * `pg_notify()`, so it needs no quoting and no dedicated connection.
 */

import pg from 'pg';
import type {
  DatabaseAdapter,
  NotificationHandler,
  QueryResultRow,
  TransactionClient,
} from './interface.js';

const { Pool, Client } = pg;

export interface PgAdapterOptions {
  /** Max pool size. Default 20. */
  max?: number;
  /** Close idle pooled connections after this many ms. Default 30_000. */
  idleTimeoutMillis?: number;
  /** Fail a connection attempt after this many ms. Default 15_000. */
  connectionTimeoutMillis?: number;
  /** Per-connection `statement_timeout` in ms, set on every fresh
   *  connection. Pass 0 to skip setting it entirely (the server
   *  default applies). Default 30_000. */
  statementTimeoutMillis?: number;
}

/** Quote a channel name as a PostgreSQL identifier — LISTEN/UNLISTEN
 *  take identifiers, not parameters, so this is the one spot where
 *  quoting is done by hand. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PgAdapter implements DatabaseAdapter {
  readonly mode = 'pg' as const;
  private pool: pg.Pool;
  private readonly connectionString: string;

  // LISTEN plumbing — one dedicated connection shared by all channels.
  private listenClient: pg.Client | null = null;
  private listenConnecting: Promise<pg.Client> | null = null;
  private readonly listenHandlers = new Map<string, Set<NotificationHandler>>();
  private relistenTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1_000;
  private closed = false;

  constructor(connectionString: string, opts?: PgAdapterOptions) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      max: opts?.max ?? 20,
      idleTimeoutMillis: opts?.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: opts?.connectionTimeoutMillis ?? 15_000,
    });

    this.pool.on('error', (err) => {
      // Idle-client errors are routed to stderr rather than propagated:
      // the failing client is auto-removed from the pool, so the next
      // query gets a fresh one. Surfacing means operators see it without
      // a request-level callback being invoked unexpectedly.
      process.stderr.write(`[pgflex/pg] idle client error: ${err.message}\n`);
    });

    const statementTimeout = opts?.statementTimeoutMillis ?? 30_000;
    if (statementTimeout > 0) {
      this.pool.on('connect', (client) => {
        // Per-connection statement timeout. Survives connection reuse
        // because pg sets it on the session, not the pool.
        client.query(`SET statement_timeout = ${Math.floor(statementTimeout)}`).catch((err: Error) => {
          process.stderr.write(`[pgflex/pg] failed to set statement_timeout: ${err.message}\n`);
        });
      });
    }
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
      client.release();
      return result;
    } catch (err) {
      // ROLLBACK can itself fail (e.g. the connection died mid-
      // transaction). Don't let that mask the original error — hand the
      // broken client back to the pool for destruction and rethrow what
      // the caller's fn actually threw.
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (rollbackErr) {
        client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      }
      throw err;
    }
  }

  // ── LISTEN/NOTIFY ──

  async listen(
    channel: string,
    handler: NotificationHandler,
  ): Promise<() => Promise<void>> {
    let handlers = this.listenHandlers.get(channel);
    const firstForChannel = !handlers;
    if (!handlers) {
      handlers = new Set();
      this.listenHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    try {
      const client = await this.ensureListenClient();
      if (firstForChannel) {
        await client.query(`LISTEN ${quoteIdent(channel)}`);
      }
    } catch (err) {
      // Roll back the bookkeeping so a failed subscribe leaves no trace.
      handlers.delete(handler);
      if (handlers.size === 0) this.listenHandlers.delete(channel);
      throw err;
    }

    return async () => {
      const set = this.listenHandlers.get(channel);
      if (!set || !set.delete(handler)) return;
      if (set.size > 0) return;
      this.listenHandlers.delete(channel);
      const client = this.listenClient;
      if (!client) return;
      await client.query(`UNLISTEN ${quoteIdent(channel)}`).catch(() => {});
      if (this.listenHandlers.size === 0) {
        // Last channel gone — drop the dedicated connection too.
        this.listenClient = null;
        await client.end().catch(() => {});
      }
    };
  }

  async notify(channel: string, payload?: string): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload ?? '']);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async ensureListenClient(): Promise<pg.Client> {
    if (this.closed) throw new Error('PgAdapter is closed');
    if (this.listenClient) return this.listenClient;
    if (this.listenConnecting) return this.listenConnecting;

    this.listenConnecting = (async () => {
      const client = new Client({ connectionString: this.connectionString });

      client.on('notification', (msg) => {
        const handlers = this.listenHandlers.get(msg.channel);
        if (!handlers) return;
        for (const h of handlers) {
          try {
            h(msg.payload ?? '');
          } catch (handlerErr) {
            process.stderr.write(
              `[pgflex/pg] listen handler for "${msg.channel}" threw: ${handlerErr instanceof Error ? handlerErr.message : String(handlerErr)}\n`,
            );
          }
        }
      });

      // 'error' fires when the server connection drops; 'end' covers
      // terminations that bypass the error path. Either way the cure is
      // the same: tear down and reconnect. Both no-op for clients that
      // were torn down intentionally (see scheduleRelisten's guards).
      client.on('error', (err) => {
        process.stderr.write(`[pgflex/pg] listen connection error: ${err.message}\n`);
        this.scheduleRelisten(client);
      });
      client.on('end', () => this.scheduleRelisten(client));

      await client.connect();
      for (const ch of this.listenHandlers.keys()) {
        await client.query(`LISTEN ${quoteIdent(ch)}`);
      }
      this.listenClient = client;
      this.reconnectDelayMs = 1_000;
      return client;
    })();

    try {
      return await this.listenConnecting;
    } finally {
      this.listenConnecting = null;
    }
  }

  /** Entry point for dropped-connection recovery. No-ops when the
   *  adapter is closed or when the dropped client was already replaced
   *  / torn down intentionally. */
  private scheduleRelisten(dropped: pg.Client): void {
    if (this.closed || this.listenClient !== dropped) return;
    this.listenClient = null;
    dropped.end().catch(() => {});
    this.scheduleReconnect();
  }

  /** Reconnect with capped exponential backoff (1s → 30s) for as long
   *  as there are subscribed handlers. Resets to 1s on success. */
  private scheduleReconnect(): void {
    if (this.closed || this.listenHandlers.size === 0 || this.relistenTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.relistenTimer = setTimeout(() => {
      this.relistenTimer = null;
      this.ensureListenClient().catch((err: Error) => {
        process.stderr.write(`[pgflex/pg] listen reconnect failed: ${err.message}\n`);
        this.scheduleReconnect();
      });
    }, delay);
    this.relistenTimer.unref?.();
  }

  /** Escape hatch: get the underlying `pg.Pool` for code that needs it
   *  (COPY, cursors, pg-specific options, etc.). Use sparingly — code
   *  that touches the pool directly won't work in pglite mode. */
  getPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.relistenTimer) {
      clearTimeout(this.relistenTimer);
      this.relistenTimer = null;
    }
    this.listenHandlers.clear();
    const client = this.listenClient;
    this.listenClient = null;
    if (client) await client.end().catch(() => {});
    await this.pool.end();
  }
}
