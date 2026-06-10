// migrate() tests — run against PGlite (memory://) so they exercise
// the real transaction + exec paths with zero external services. The
// same runner code drives pg mode; the SQL surface is identical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, migrate } from '../dist/index.js';

/** Create a throwaway migrations directory from a {filename: sql} map. */
async function makeMigrationsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'pgflex-migrate-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql, 'utf8');
  }
  return dir;
}

test('migrate: applies files in order, records them, is idempotent', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  const dir = await makeMigrationsDir({
    // Multi-statement file — exercises exec() rather than query().
    '001_init.sql': `
      CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE INDEX users_name_idx ON users (name);
    `,
    '002_seed.sql': `INSERT INTO users (name) VALUES ('alice'), ('bob');`,
    'README.txt': 'not a migration — must be ignored',
  });
  try {
    const first = await migrate(db, { dir });
    assert.deepEqual(first.applied, ['001_init.sql', '002_seed.sql']);
    assert.equal(first.skipped, 0);

    const users = await db.query('SELECT name FROM users ORDER BY name');
    assert.deepEqual(users, [{ name: 'alice' }, { name: 'bob' }]);

    const tracked = await db.query('SELECT name FROM pgflex_migrations ORDER BY name');
    assert.deepEqual(tracked, [{ name: '001_init.sql' }, { name: '002_seed.sql' }]);

    // Second run: everything already applied.
    const second = await migrate(db, { dir });
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped, 2);

    // Seed data not duplicated.
    const count = await db.queryOne('SELECT count(*)::int AS n FROM users');
    assert.deepEqual(count, { n: 2 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate: picks up new files added later', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  const dir = await makeMigrationsDir({
    '001_init.sql': 'CREATE TABLE t1 (id INT);',
  });
  try {
    await migrate(db, { dir });
    await writeFile(join(dir, '002_more.sql'), 'CREATE TABLE t2 (id INT);', 'utf8');

    const result = await migrate(db, { dir });
    assert.deepEqual(result.applied, ['002_more.sql']);
    assert.equal(result.skipped, 1);

    const t2 = await db.query('SELECT * FROM t2');
    assert.deepEqual(t2, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate: a failing migration rolls back fully and is not recorded', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  const dir = await makeMigrationsDir({
    '001_ok.sql': 'CREATE TABLE good (id INT);',
    // Second statement fails → the whole file (including the first
    // statement) must roll back, and the file must not be recorded.
    '002_broken.sql': `
      CREATE TABLE half_done (id INT);
      THIS IS NOT SQL;
    `,
  });
  try {
    await assert.rejects(
      () => migrate(db, { dir }),
      /migration "002_broken\.sql" failed/,
    );

    // 001 committed, 002 fully rolled back.
    assert.deepEqual(await db.query('SELECT * FROM good'), []);
    await assert.rejects(
      () => db.query('SELECT * FROM half_done'),
      /does not exist/,
      'failed migration must leave no partial state behind',
    );

    const tracked = await db.query('SELECT name FROM pgflex_migrations');
    assert.deepEqual(tracked, [{ name: '001_ok.sql' }]);

    // Fixing the file lets the run resume from where it stopped.
    await writeFile(join(dir, '002_broken.sql'), 'CREATE TABLE half_done (id INT);', 'utf8');
    const retry = await migrate(db, { dir });
    assert.deepEqual(retry.applied, ['002_broken.sql']);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate: custom tracking table; rejects invalid table names', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  const dir = await makeMigrationsDir({
    '001_init.sql': 'CREATE TABLE custom_tracked (id INT);',
  });
  try {
    await migrate(db, { dir, table: 'my_migrations' });
    const tracked = await db.query('SELECT name FROM my_migrations');
    assert.deepEqual(tracked, [{ name: '001_init.sql' }]);

    await assert.rejects(
      () => migrate(db, { dir, table: 'bad; DROP TABLE users--' }),
      /invalid table name/,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate: missing directory throws with the resolved path', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  try {
    await assert.rejects(
      () => migrate(db, { dir: 'definitely-does-not-exist-pgflex' }),
      /migrations directory not found: .*definitely-does-not-exist-pgflex/,
    );
  } finally {
    await db.close();
  }
});

test('adapter: exec() runs multi-statement scripts outside transactions too', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  try {
    await db.exec(`
      CREATE TABLE a (id INT);
      CREATE TABLE b (id INT);
      INSERT INTO a VALUES (1);
    `);
    assert.deepEqual(await db.query('SELECT id FROM a'), [{ id: 1 }]);
    assert.deepEqual(await db.query('SELECT * FROM b'), []);
  } finally {
    await db.close();
  }
});
