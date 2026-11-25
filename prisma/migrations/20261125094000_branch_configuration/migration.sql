CREATE TABLE "BranchConfiguration" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BranchConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BranchConfiguration_branchId_key" ON "BranchConfiguration"("branchId");

ALTER TABLE "BranchConfiguration"
  ADD CONSTRAINT "BranchConfiguration_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "BranchConfiguration" ("id", "branchId", "data", "updatedBy", "updatedAt")
VALUES (
  'config-eastern-cape-delivery',
  'eastern-cape-delivery',
  '{"title":"Individual subsidy","version":"2.3","effectiveOn":"2026-10-01","owner":"Ayavelisa programme lead","eligibilityRules":[]}'::jsonb,
  'system',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("branchId") DO NOTHING;
