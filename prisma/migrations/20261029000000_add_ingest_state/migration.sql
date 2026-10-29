-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "IngestErrorKind" AS ENUM ('TEMPORARY', 'PERMANENT');

-- CreateEnum
CREATE TYPE "IngestFileStatus" AS ENUM ('PENDING', 'INGESTED', 'SKIPPED');

-- AlterTable
ALTER TABLE "ConsultaCache" ADD COLUMN     "totalAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" "IngestStatus" NOT NULL,
    "prepared" BOOLEAN NOT NULL DEFAULT false,
    "phase" TEXT,
    "error" TEXT,
    "errorKind" "IngestErrorKind",
    "lastFailureEmailAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestFile" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "tableName" TEXT,
    "status" "IngestFileStatus" NOT NULL DEFAULT 'PENDING',
    "rows" INTEGER,
    "discarded" INTEGER,
    "ingestedAt" TIMESTAMP(3),

    CONSTRAINT "IngestFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestRun_status_idx" ON "IngestRun"("status");

-- CreateIndex
CREATE INDEX "IngestRun_startedAt_idx" ON "IngestRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IngestFile_runId_fileName_key" ON "IngestFile"("runId", "fileName");

-- AddForeignKey
ALTER TABLE "IngestFile" ADD CONSTRAINT "IngestFile_runId_fkey" FOREIGN KEY ("runId") REFERENCES "IngestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
