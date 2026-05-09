// Factory unit tests — exercise createAdapterFromEnv's mode/env-var
// branching without touching either backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterFromEnv } from '../dist/index.js';

test('createAdapterFromEnv throws when pg mode lacks a connection string', async () => {
  const original = process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL'];
  try {
    await assert.rejects(
      () => createAdapterFromEnv(),
      /DATABASE_URL is required/,
      'pg mode without DATABASE_URL must surface a clear error',
    );
  } finally {
    if (original !== undefined) process.env['DATABASE_URL'] = original;
  }
});

test('createAdapterFromEnv respects custom env-var names', async () => {
  const originalDb = process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL'];
  process.env['MYAPP_DB_URL'] = 'postgresql://does-not-matter';
  try {
    // We don't run any SELECT, so no actual TCP connection happens —
    // we just confirm mode dispatching picks up the custom env var.
    const adapter = await createAdapterFromEnv({
      connectionStringEnvVar: 'MYAPP_DB_URL',
    });
    assert.equal(adapter.mode, 'pg', 'falls into pg mode when MYAPP_DB_URL is set');
    await adapter.close();
  } finally {
    delete process.env['MYAPP_DB_URL'];
    if (originalDb !== undefined) process.env['DATABASE_URL'] = originalDb;
  }
});

test('createAdapterFromEnv routes PGFLEX_MODE=pglite to the pglite backend', async () => {
  const originalMode = process.env['PGFLEX_MODE'];
  process.env['PGFLEX_MODE'] = 'pglite';
  // Set the data dir BEFORE creating the adapter — otherwise the env
  // fallback would create `~/.pgflex/data` on the test machine.
  process.env['PGFLEX_TEST_DATADIR'] = 'memory://';
  try {
    const adapter = await createAdapterFromEnv({
      dataDirEnvVar: 'PGFLEX_TEST_DATADIR',
    });
    assert.equal(adapter.mode, 'pglite', 'pglite mode selected via PGFLEX_MODE');
    // Smoke-check the adapter actually works via the env path.
    const row = await adapter.queryOne('SELECT 1::int AS one');
    assert.deepEqual(row, { one: 1 });
    await adapter.close();
  } finally {
    delete process.env['PGFLEX_TEST_DATADIR'];
    if (originalMode !== undefined) {
      process.env['PGFLEX_MODE'] = originalMode;
    } else {
      delete process.env['PGFLEX_MODE'];
    }
  }
});
