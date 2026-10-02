import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';

const globalDb = globalThis as unknown as { yanbanDb?: PrismaClient };
export function createDb(url = process.env.DATABASE_URL ?? 'file:./data/dev.db'): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url, timeout: 50 });
  return new PrismaClient({ adapter });
}
export const db = globalDb.yanbanDb ?? createDb();
if (process.env.NODE_ENV !== 'production') globalDb.yanbanDb = db;
