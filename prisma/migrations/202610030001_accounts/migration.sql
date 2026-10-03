-- CreateTable
CREATE TABLE "StudentAccount" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "university" TEXT,
    "major" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StudentAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeacherAccount" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "university" TEXT,
    "degree" TEXT,
    "qualificationConfirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeacherAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAccount" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdminAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LoginSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'LEGACY',
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LoginSession" ("createdAt", "expiresAt", "id", "tokenHash", "userId") SELECT "createdAt", "expiresAt", "id", "tokenHash", "userId" FROM "LoginSession";
DROP TABLE "LoginSession";
ALTER TABLE "new_LoginSession" RENAME TO "LoginSession";
CREATE UNIQUE INDEX "LoginSession_tokenHash_key" ON "LoginSession"("tokenHash");
CREATE INDEX "LoginSession_expiresAt_idx" ON "LoginSession"("expiresAt");
CREATE TABLE "new_AnswererProfile" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "bio" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isAdult" BOOLEAN NOT NULL DEFAULT true,
    "isFullTimeStudent" BOOLEAN NOT NULL DEFAULT true,
    "isEmployed" BOOLEAN NOT NULL DEFAULT false,
    "profileSource" TEXT NOT NULL DEFAULT 'DEMO',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" DATETIME,
    "idleSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnswererProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AnswererProfile" ("bio", "enabled", "heartbeatAt", "idleSince", "isAdult", "isEmployed", "isFullTimeStudent", "online", "profileSource", "userId") SELECT "bio", "enabled", "heartbeatAt", "idleSince", "isAdult", "isEmployed", "isFullTimeStudent", "online", "profileSource", "userId" FROM "AnswererProfile";
DROP TABLE "AnswererProfile";
ALTER TABLE "new_AnswererProfile" RENAME TO "AnswererProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "StudentAccount_username_key" ON "StudentAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAccount_username_key" ON "TeacherAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AdminAccount_username_key" ON "AdminAccount"("username");
