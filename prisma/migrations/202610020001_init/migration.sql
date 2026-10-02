-- CreateTable
CREATE TABLE "WriteFence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "revision" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AnswererProfile" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "bio" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isAdult" BOOLEAN NOT NULL DEFAULT true,
    "isFullTimeStudent" BOOLEAN NOT NULL DEFAULT true,
    "isEmployed" BOOLEAN NOT NULL DEFAULT false,
    "profileSource" TEXT NOT NULL DEFAULT 'DEMO',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" DATETIME,
    "idleSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnswererProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnswererSubject" (
    "answererId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,

    PRIMARY KEY ("answererId", "subjectId"),
    CONSTRAINT "AnswererSubject_answererId_fkey" FOREIGN KEY ("answererId") REFERENCES "AnswererProfile" ("userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswererSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuestionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "askerId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "targetAnswererId" TEXT,
    "attachmentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" DATETIME NOT NULL,
    "matchedAt" DATETIME,
    "endReason" TEXT,
    CONSTRAINT "QuestionRequest_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QuestionRequest_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QuestionRequest_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RequesterLease" (
    "askerId" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    CONSTRAINT "RequesterLease_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RequesterLease_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "QuestionRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnswererLease" (
    "answererId" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT,
    "sessionId" TEXT,
    "expiresAt" DATETIME,
    CONSTRAINT "AnswererLease_answererId_fkey" FOREIGN KEY ("answererId") REFERENCES "AnswererProfile" ("userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswererLease_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "QuestionRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswererLease_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Invitation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnswererLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnswerSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "answererId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    CONSTRAINT "Invitation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "QuestionRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invitation_answererId_fkey" FOREIGN KEY ("answererId") REFERENCES "AnswererProfile" ("userId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnswerSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "askerId" TEXT NOT NULL,
    "answererId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "askerEnteredAt" DATETIME,
    "answererEnteredAt" DATETIME,
    "askerSeenAt" DATETIME,
    "answererSeenAt" DATETIME,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "endReason" TEXT,
    "rtcCleanupStatus" TEXT NOT NULL DEFAULT 'NONE',
    "rtcCleanupLastAttemptAt" DATETIME,
    CONSTRAINT "AnswerSession_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "QuestionRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AnswerSession_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AnswerSession_answererId_fkey" FOREIGN KEY ("answererId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnswerSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploaderId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnswerSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT,
    "sessionId" TEXT,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "QuestionRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BusinessEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnswerSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BusinessEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucket" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1
);

-- CreateIndex
CREATE UNIQUE INDEX "LoginSession_tokenHash_key" ON "LoginSession"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginSession_expiresAt_idx" ON "LoginSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionRequest_attachmentId_key" ON "QuestionRequest"("attachmentId");

-- CreateIndex
CREATE INDEX "QuestionRequest_status_deadlineAt_idx" ON "QuestionRequest"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionRequest_askerId_idempotencyKey_key" ON "QuestionRequest"("askerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RequesterLease_requestId_key" ON "RequesterLease"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswererLease_requestId_key" ON "AnswererLease"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswererLease_offerId_key" ON "AnswererLease"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswererLease_sessionId_key" ON "AnswererLease"("sessionId");

-- CreateIndex
CREATE INDEX "Invitation_status_deadlineAt_idx" ON "Invitation"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_requestId_answererId_key" ON "Invitation"("requestId", "answererId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerSession_requestId_key" ON "AnswerSession"("requestId");

-- CreateIndex
CREATE INDEX "AnswerSession_endedAt_idx" ON "AnswerSession"("endedAt");

-- CreateIndex
CREATE INDEX "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_senderId_clientId_key" ON "Message"("sessionId", "senderId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_sessionId_key" ON "Feedback"("sessionId");

-- CreateIndex
CREATE INDEX "BusinessEvent_requestId_createdAt_idx" ON "BusinessEvent"("requestId", "createdAt");

