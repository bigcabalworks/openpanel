CREATE TYPE "ExperimentStatus" AS ENUM ('draft', 'running', 'paused', 'stopped', 'archived');

CREATE TABLE "experiments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "slot" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'draft',
    "sites" TEXT[] NOT NULL,
    "environments" TEXT[] NOT NULL,
    "startsAt" TIMESTAMP(3),
    "stopsAt" TIMESTAMP(3),
    "allocation" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "variants" JSONB NOT NULL,
    "targeting" JSONB NOT NULL DEFAULT '[]',
    "patches" JSONB NOT NULL DEFAULT '[]',
    "primaryEvent" TEXT NOT NULL,
    "secondaryEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "guardrailEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "exclusionGroup" TEXT,
    "assignmentSalt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "experiment_placements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "variants" TEXT[] NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experiment_placements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "experiment_manifest_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experiment_manifest_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "experiment_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "experimentId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experiment_audit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "experiment_lifecycle_requests" (
    "requestId" TEXT NOT NULL,
    "experimentId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experiment_lifecycle_requests_pkey" PRIMARY KEY ("requestId")
);

CREATE UNIQUE INDEX "experiments_key_key" ON "experiments"("key");
CREATE INDEX "experiments_status_idx" ON "experiments"("status");
CREATE INDEX "experiments_slot_status_idx" ON "experiments"("slot", "status");
CREATE UNIQUE INDEX "experiment_placements_site_environment_slot_key" ON "experiment_placements"("site", "environment", "slot");
CREATE INDEX "experiment_placements_site_environment_idx" ON "experiment_placements"("site", "environment");
CREATE UNIQUE INDEX "experiment_manifest_revisions_site_environment_key" ON "experiment_manifest_revisions"("site", "environment");
CREATE INDEX "experiment_audit_experimentId_createdAt_idx" ON "experiment_audit"("experimentId", "createdAt");
CREATE INDEX "experiment_lifecycle_requests_createdAt_idx" ON "experiment_lifecycle_requests"("createdAt");

ALTER TABLE "experiment_audit" ADD CONSTRAINT "experiment_audit_experimentId_fkey"
FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
