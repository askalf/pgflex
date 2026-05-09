// pglite integration tests — exercise query, queryOne, transaction,
// and rollback semantics against an in-memory PGlite instance.
//
// Runs in CI on every node version because pglite is pure WASM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, PGliteAdapter } from '../dist/index.js';

test('pglite: query / queryOne / round-trip', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  try {
    assert.equal(db.mode, 'pglite');

    await db.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        meta JSONB
      )
    `);
    await db.query(
      `INSERT INTO users (name, active, meta) VALUES ($1, $2, $3), ($4, $5, $6)`,
      ['alice', true, { role: 'admin' }, 'bob', false, null],
    );

    const all = await db.query('SELECT name, active FROM users ORDER BY name');
    assert.deepEqual(all, [
      { name: 'alice', active: true },
      { name: 'bob', active: false },
    ]);

    const alice = await db.queryOne(
      'SELECT name, meta FROM users WHERE name = $1',
      ['alice'],
    );
    assert.deepEqual(alice, { name: 'alice', meta: { role: 'admin' } });

    const missing = await db.queryOne(
      'SELECT name FROM users WHERE name = $1',
      ['nobody'],
    );
    assert.equal(missing, null, 'queryOne returns null when no rows match');
  } finally {
    await db.close();
  }
});

test('pglite: transaction commits when fn returns', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  try {
    await db.query('CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)');
    await db.query('INSERT INTO accounts VALUES (1, 100), (2, 50)');

    const result = await db.transaction(async (client) => {
      await client.query('UPDATE accounts SET balance = balance - 30 WHERE id = $1', [1]);
      await client.query('UPDATE accounts SET balance = balance + 30 WHERE id = $1', [2]);
      const { rows } = await client.query('SELECT id, balance FROM accounts ORDER BY id');
      return rows;
    });

    assert.deepEqual(result, [
      { id: 1, balance: 70 },
      { id: 2, balance: 80 },
    ]);

    // Re-read outside the transaction — committed.
    const after = await db.query('SELECT id, balance FROM accounts ORDER BY id');
    assert.deepEqual(after, [
      { id: 1, balance: 70 },
      { id: 2, balance: 80 },
    ]);
  } finally {
    await db.close();
  }
});

test('pglite: transaction rolls back when fn throws', async () => {
  const db = await createAdapter({ mode: 'pglite', dataDir: 'memory://' });
  try {
    await db.query('CREATE TABLE counters (id INT PRIMARY KEY, n INT NOT NULL)');
    await db.query('INSERT INTO counters VALUES (1, 0)');

    await assert.rejects(
      () =>
        db.transaction(async (client) => {
          await client.query('UPDATE counters SET n = 99 WHERE id = $1', [1]);
          throw new Error('intentional rollback trigger');
        }),
      /intentional rollback trigger/,
    );

    const after = await db.queryOne('SELECT n FROM counters WHERE id = $1', [1]);
    assert.deepEqual(after, { n: 0 }, 'thrown transaction must roll back');
  } finally {
    await db.close();
  }
});

test('pglite: opt-in extensions wire up correctly (pgvector end-to-end)', async () => {
  // pgvector requires both JS-side wiring (loaded via @electric-sql/pglite/vector)
  // and a SQL-side `CREATE EXTENSION vector`. Both run during init() when
  // we list 'vector' in the extensions array. After init the adapter
  // should be able to create vector-typed columns and round-trip values.
  const adapter = new PGliteAdapter({
    dataDir: 'memory://',
    extensions: ['vector'],
  });
  await adapter.init();
  try {
    await adapter.query('CREATE TABLE docs (id INT PRIMARY KEY, embedding vector(3))');
    await adapter.query(
      "INSERT INTO docs (id, embedding) VALUES ($1, $2)",
      [1, '[0.1,0.2,0.3]'],
    );
    const row = await adapter.queryOne('SELECT id, embedding FROM docs WHERE id = $1', [1]);
    assert.equal(row?.id, 1);
    // pgvector returns the stored vector as a string in canonical form;
    // exact whitespace varies by version, so just check the prefix.
    assert.match(String(row.embedding), /^\[0\.1,0\.2,0\.3\]$/);
  } finally {
    await adapter.close();
  }
});

test('pglite: query before init() throws a clear error', async () => {
  const adapter = new PGliteAdapter({ dataDir: 'memory://' });
  try {
    await assert.rejects(
      () => adapter.query('SELECT 1'),
      /not initialized/,
    );
  } finally {
    // No init was called — close is still safe (no-op).
    await adapter.close();
  }
});
