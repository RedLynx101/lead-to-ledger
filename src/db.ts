import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { databaseUrl, ROOT } from './config.ts';

export type Db = pg.Pool;

export function createDb(connectionString = databaseUrl()): Db {
  return new pg.Pool({ connectionString, max: 8 });
}

/** Applies db/*.sql in order, once each. Safe to run at every start. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    // Two processes starting at once take turns.
    await client.query('select pg_advisory_lock(727001)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(path.join(ROOT, 'db')).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(path.join(ROOT, 'db', file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
