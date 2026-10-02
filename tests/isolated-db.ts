import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

/** Every caller owns a new temporary database; the development database is never reset. */
export async function migratedTestDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "yanban-vitest-"));
  const file = join(directory, "test.db");
  const url = `file:${file}`;
  try {
    // SQLite accepts an empty new file; existing development files are never involved.
    await writeFile(file, "", { flag: "wx" });
    await run(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      timeout: 60_000,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, file, url, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
