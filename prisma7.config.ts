import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? 'file:./data/dev.db';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  // Prisma CLI and runtime must resolve the same file, independent of schema location.
  datasource: { url: url.startsWith('file:') ? `file:${path.resolve(root, url.slice(5))}` : url },
});
