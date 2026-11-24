ALTER TABLE "VisitEvidence"
  ADD COLUMN "storagePath" TEXT,
  ADD COLUMN "mimeType" TEXT;

UPDATE "VisitEvidence"
SET
  "storagePath" = 'legacy:' || "id",
  "mimeType" = CASE
    WHEN "dataUrl" ~ '^data:[^;,]+' THEN substring("dataUrl" FROM '^data:([^;,]+)')
    ELSE 'application/octet-stream'
  END;

ALTER TABLE "VisitEvidence"
  ALTER COLUMN "dataUrl" DROP NOT NULL,
  ALTER COLUMN "storagePath" SET NOT NULL,
  ALTER COLUMN "mimeType" SET NOT NULL;

ALTER TABLE "VisitGrievance"
  ADD COLUMN "categoryOther" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "VisitGrievance"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE INDEX "Visit_assignedTo_idx" ON "Visit"("assignedTo");
CREATE INDEX "Visit_scheduledFor_idx" ON "Visit"("scheduledFor");
