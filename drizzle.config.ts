// drizzle.config.ts
// Source: RESEARCH.md Pattern 6 + orm.drizzle.team/docs/drizzle-config-file
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL']!,
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
});
