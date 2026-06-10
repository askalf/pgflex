/**
 * migrate() — a tiny, dependency-free SQL migration runner that works
 * on any `DatabaseAdapter`, so the SAME migration files run against
 * real PostgreSQL in production and PGlite in dev / standalone / CI.
 *
 * Conventions (deliberately boring):
 *   - Migrations are plain `.sql` files in one directory.
 *   - They apply in lexicographic filename order — use zero-padded
 *     numeric prefixes (`001_init.sql`, `002_add_users.sql`, ...).
 *   - Each file applies inside its own transaction, together with the
 *     row that records it as applied — a failed migration rolls back
 *     completely and is NOT recorded. PostgreSQL DDL is transactional,
 *     so this covers CREATE/ALTER/DROP too.
 *   - Applied filenames are tracked in a table (default
 *     `pgflex_migrations`). Files already recorded are skipped, so
 *     running migrate() at every startup is the intended usage.
 *   - The runner stops at the first failure and throws an error naming
 *     the file; already-applied migrations from the same run stay
 *     applied (they committed).
 *
 * Renaming an applied file makes it look like a new migration —
 * don't rename applied migrations.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DatabaseAdapter } from './interface.js';

export interface MigrateOptions {
  /** Directory containing the `.sql` migration files. */
  dir: string;
  /** Tracking table name. Must be a plain identifier
   *  (letters/digits/underscore). Default `'pgflex_migrations'`. */
  table?: string;
  /** Log one line per applied migration to stderr. Default false. */
  verbose?: boolean;
}

export interface MigrateResult {
  /** Filenames applied by this run, in the order they ran. */
  applied: string[];
  /** How many files were already applied and skipped. */
  skipped: number;
}

export async function migrate(
  db: DatabaseAdapter,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const table = opts.table ?? 'pgflex_migrations';
  // The table name is interpolated into SQL, so refuse anything that
  // isn't a plain identifier rather than attempting to quote-escape.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `migrate(): invalid table name "${table}" — use letters, digits, and underscores only`,
    );
  }

  // Resolve to an absolute path up front and surface it in errors —
  // "no such directory: migrations" with an ambient cwd is the classic
  // way migration runners go wrong in containers.
  const dir = resolve(opts.dir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`migrate(): migrations directory not found: ${dir}`);
  }

  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const seen = await db.query<{ name: string }>(`SELECT name FROM ${table}`);
  const alreadyApplied = new Set(seen.map((r) => r.name));

  const applied: string[] = [];
  let skipped = 0;

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped++;
      continue;
    }

    const sql = await readFile(join(dir, file), 'utf8');
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query(`INSERT INTO ${table} (name) VALUES ($1)`, [file]);
      });
    } catch (err) {
      throw new Error(
        `migrate(): migration "${file}" failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    applied.push(file);
    if (opts.verbose) {
      process.stderr.write(`[pgflex/migrate] applied ${file}\n`);
    }
  }

  return { applied, skipped };
}
