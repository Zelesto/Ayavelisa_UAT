CREATE TABLE "Branch" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");

INSERT INTO "Branch" ("id", "name")
VALUES ('eastern-cape-delivery', 'Eastern Cape delivery')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE "UserBranch" (
  "userId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserBranch_pkey" PRIMARY KEY ("userId", "branchId")
);

CREATE INDEX "UserBranch_branchId_idx" ON "UserBranch"("branchId");

INSERT INTO "UserBranch" ("userId", "branchId", "isDefault")
SELECT "id", 'eastern-cape-delivery', true FROM "User"
ON CONFLICT ("userId", "branchId") DO NOTHING;

CREATE TABLE "BranchCase" (
  "branchId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  CONSTRAINT "BranchCase_pkey" PRIMARY KEY ("branchId", "caseId")
);

CREATE INDEX "BranchCase_caseId_idx" ON "BranchCase"("caseId");

ALTER TABLE "AppState" ADD COLUMN "branchId" TEXT;
CREATE UNIQUE INDEX "AppState_branchId_key" ON "AppState"("branchId");
UPDATE "AppState" SET "branchId" = 'eastern-cape-delivery' WHERE "id" = 'workspace';

ALTER TABLE "CaseRecord" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "UserBranch"
  ADD CONSTRAINT "UserBranch_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UserBranch_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BranchCase"
  ADD CONSTRAINT "BranchCase_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BranchCase_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "CaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppState"
  ADD CONSTRAINT "AppState_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
