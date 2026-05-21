// src/plugins/config.ts
// Source: RESEARCH.md Pattern 2 — Config plugin with fp() for cross-plugin visibility
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
const configPlugin: FastifyPluginAsync<{ config: Env }> = async (fastify, opts) => {
  fastify.decorate('config', opts.config);
};

export default fp(configPlugin, { name: 'config' });
