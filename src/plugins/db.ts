// src/plugins/db.ts
// Source: RESEARCH.md Pattern 3 — DB plugin with fp(), dependencies: ['config']
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';
import { createPool } from '../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: NodePgDatabase<typeof schema>;
    pgPool: pg.Pool;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = createPool(fastify.config.DATABASE_URL);

  // Fast-fail: if DB is unreachable at boot, exit now (T-02-04: intentional)
  await pool.query('SELECT 1');

  fastify.decorate('db', drizzle(pool, { schema }));
  fastify.decorate('pgPool', pool);

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
};

export default fp(dbPlugin, { name: 'db', dependencies: ['config'] });
