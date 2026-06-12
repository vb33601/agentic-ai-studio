-- Additive, NON-DESTRUCTIVE creation of the preflight/learning tables.
-- Safe to run on a shared DB: IF NOT EXISTS never touches existing tables/data.
-- Run with:  npx prisma db execute --url='<studio DATABASE_URL>' --file ./prisma/add-preflight-tables.sql
-- (Do NOT use `prisma db push` here — it would drop tables not in the schema.)

CREATE TABLE IF NOT EXISTS "PreflightRule" (
  "id"         TEXT PRIMARY KEY,
  "tech"       TEXT NOT NULL,
  "ruleId"     TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "detail"     TEXT NOT NULL,
  "source"     TEXT NOT NULL DEFAULT 'web',
  "sourceUrl"  TEXT,
  "verified"   BOOLEAN NOT NULL DEFAULT false,
  "fixGlob"    TEXT,
  "fixFind"    TEXT,
  "fixReplace" TEXT,
  "fixFlags"   TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "PreflightRule_tech_ruleId_key" ON "PreflightRule" ("tech", "ruleId");
CREATE INDEX IF NOT EXISTS "PreflightRule_tech_idx" ON "PreflightRule" ("tech");

CREATE TABLE IF NOT EXISTS "FixOutcome" (
  "id"             TEXT PRIMARY KEY,
  "tech"           TEXT NOT NULL,
  "ruleId"         TEXT NOT NULL,
  "errorSignature" TEXT,
  "action"         TEXT NOT NULL,
  "success"        BOOLEAN NOT NULL,
  "phase"          TEXT NOT NULL DEFAULT 'deploy',
  "details"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "FixOutcome_tech_ruleId_idx" ON "FixOutcome" ("tech", "ruleId");
CREATE INDEX IF NOT EXISTS "FixOutcome_tech_success_idx" ON "FixOutcome" ("tech", "success");
