-- AlterTable
ALTER TABLE "StudentAccount" ADD COLUMN "adultConfirmedAt" DATETIME;
ALTER TABLE "StudentAccount" ADD COLUMN "termsAcceptedAt" DATETIME;
ALTER TABLE "StudentAccount" ADD COLUMN "termsVersion" TEXT;

-- AlterTable
ALTER TABLE "TeacherAccount" ADD COLUMN "adultConfirmedAt" DATETIME;
ALTER TABLE "TeacherAccount" ADD COLUMN "major" TEXT;
ALTER TABLE "TeacherAccount" ADD COLUMN "termsAcceptedAt" DATETIME;
ALTER TABLE "TeacherAccount" ADD COLUMN "termsVersion" TEXT;
