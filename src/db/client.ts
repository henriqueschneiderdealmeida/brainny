// src/db/client.ts
// Pool factory — used by dbPlugin; does not connect here
import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}
