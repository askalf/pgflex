// pg integration tests — exercise the same surface as pglite.test.mjs
// but against a real PostgreSQL server. Skipped automatically when
// `DATABASE_URL` is unset (so CI doesn't need a Postgres) — run with
// `npm run test:pg` after pointing DATABASE_URL at a throwaway DB.
//
// Tables are created with random suffixes so concurrent runs don't
// collide; everything is dropped in a `finally`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../dist/index.js';

const conn = process.env['DATABASE_URL'];
const t = conn ? test : test.skip;
const suffix = Math.random().toString(36).slice(2, 10);

t('pg: query / queryOne / transaction round-trip', async () => {
  const db = await createAdapter({ mode: 'pg', connectionString: conn });
  const tbl = `pgflex_test_${suffix}`;
  try {
    await db.query(`CREATE TABLE ${tbl} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
    await db.query(`INSERT INTO ${tbl} (name) VALUES ($1), ($2)`, ['a', 'b']);

    const all = await db.query(`SELECT name FROM ${tbl} ORDER BY name`);
    assert.deepEqual(all, [{ name: 'a' }, { name: 'b' }]);

    const one = await db.queryOne(`SELECT name FROM ${tbl} WHERE name = $1`, ['a']);
    assert.deepEqual(one, { name: 'a' });

    await assert.rejects(
      () =>
        db.transaction(async (client) => {
          await client.query(`INSERT INTO ${tbl} (name) VALUES ($1)`, ['c']);
          throw new Error('rollback');
        }),
      /rollback/,
    );

    const after = await db.query(`SELECT name FROM ${tbl} ORDER BY name`);
    assert.deepEqual(after, [{ name: 'a' }, { name: 'b' }],
      'failed transaction must not leave row "c" behind');
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${tbl}`).catch(() => {});
    await db.close();
  }
});
