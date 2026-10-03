import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../src/server/db";
import { seedDatabase } from "../prisma/seed";

// This helper is solely for Playwright's newly created, isolated temporary database.
const url = process.env.DATABASE_URL ?? "";
const file = resolve(url.slice(5));
if (process.env.YANBAN_BROWSER_TEST !== "true" || !url.startsWith("file:")
  || !file.startsWith(`${resolve(tmpdir())}${sep}yanban-e2e-`)) {
  throw new Error("Browser fixtures require their dedicated temporary database.");
}
try {
  await seedDatabase(db, { fixtures: "admin" });
} finally { await db.$disconnect(); }
