/* =========================================================================
   server/routes/visits.ts
   Visit CRUD, evidence upload, grievances, and the submit/return/approve
   state machine. All evidence goes to Supabase Storage (bucket:
   visit-evidence). Grievances are nested in the wire format but stored
   as first-class rows for queryability.
   ========================================================================= */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import crypto from "node:crypto";

const BUCKET = "visit-evidence";
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap
const MAX_EVIDENCE_PER_VISIT = 25;

/* --- Validation --------------------------------------------------------- */

const VisitStatus = z.enum(["assigned", "in_progress", "captured", "returned", "approved"]);
const EvidenceKind = z.enum(["photo", "signature", "document"]);
const EvidenceCategory = z.enum([
  "identity", "proof_of_residence", "income_evidence", "prior_benefit_check",
  "property_check", "tenure_evidence", "dwelling", "other",
]);
const GrievanceCategory = z.enum(["identity", "category", "allocation", "evidence", "other"]);
const GrievanceStatus = z.enum(["open", "in_review", "resolved", "escalated"]);

const Provenance = z.object({
  deviceRef: z.string().nullable(),
  capturedAtDevice: z.string().nullable(),
  coordinates: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  fileHash: z.string().nullable(),
  transformation: z.string().nullable(),
}).strict();

const GrievanceInput = z.object({
  id: z.string().min(1).max(80),
  raisedAt: z.string().datetime(),
  raisedBy: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  category: GrievanceCategory,
  categoryOther: z.string().max(200).optional(),
  status: GrievanceStatus.default("open"),
  resolutionOwner: z.string().max(200).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  resolution: z.string().max(4000).nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
}).strict();

// VisitForm is opaque to the server in this slice — we store it as JSON.
// Schema validation of the form is a Slice 2 concern (when Case/Intake
// field mapping lands). For now we require it to be an object.
const VisitFormInput = z.record(z.string(), z.unknown());

const SubmitVisitBody = z.object({
  version: z.number().int().nonnegative(),   // optimistic lock vs Visit.version
  form: VisitFormInput,
  summary: z.record(z.string(), z.unknown()).nullable().optional(),
  grievances: z.array(GrievanceInput).max(50).default([]),
  submittedAt: z.string().datetime(),
}).strict();

const PatchVisitBody = z.object({
  version: z.number().int().nonnegative(),
  form: VisitFormInput.optional(),
  status: z.enum(["assigned", "in_progress"]).optional(),  // only these two are PATCH-able
  startedAt: z.string().datetime().nullable().optional(),
}).strict();

const ReturnVisitBody = z.object({
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(2000),
}).strict();

const ApproveVisitBody = z.object({
  version: z.number().int().nonnegative(),
}).strict();

/* --- Helpers ------------------------------------------------------------ */

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Detect MIME type from magic bytes. Returns null if not an accepted type. */
function sniffImageOrPdf(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: "image/png", ext: "png" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", ext: "webp" };
  }
  // PDF: "%PDF"
  if (buf.toString("ascii", 0, 4) === "%PDF") {
    return { mimeType: "application/pdf", ext: "pdf" };
  }
  return null;
}

function parseField<T>(value: unknown, schema: z.ZodType<T>, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error("invalid_multipart_field"), {
      statusCode: 400, code: "invalid_multipart_field", field, issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function isMultipart(request: FastifyRequest): boolean {
  return request.isMultipart();
}

async function readMultipart(request: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file: { buffer: Buffer; filename: string };
}> {
  if (!isMultipart(request)) {
    throw Object.assign(new Error("multipart_required"), { statusCode: 415, code: "multipart_required" });
  }
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; filename: string } | null = null;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file") { await part.toBuffer(); continue; } // discard unknowns
      if (file) { await part.toBuffer(); continue; }                      // ignore second file
      const buffer = await part.toBuffer();
      if (buffer.length > MAX_EVIDENCE_BYTES) {
        throw Object.assign(new Error("evidence_too_large"), { statusCode: 413, code: "evidence_too_large" });
      }
      file = { buffer, filename: part.filename ?? "upload" };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) {
    throw Object.assign(new Error("file_required"), { statusCode: 400, code: "file_required" });
  }
  return { fields, file };
}

/** Assert the visit exists and the requester may touch it. */
async function loadVisitForWrite(
  prisma: PrismaClient,
  visitId: string,
  actor: { id: string; role: string },
) {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { case: { select: { id: true, project: true } } },
  });
  if (!visit) {
    throw Object.assign(new Error("visit_not_found"), { statusCode: 404, code: "visit_not_found" });
  }
  const isFieldworker = actor.role === "fieldworker";
  const isSupervisor = actor.role === "supervisor" || actor.role === "admin";
  if (isFieldworker && visit.assignedTo !== actor.id) {
    throw Object.assign(new Error("visit_forbidden"), { statusCode: 403, code: "visit_forbidden" });
  }
  if (!isFieldworker && !isSupervisor && actor.role !== "reviewer") {
    throw Object.assign(new Error("visit_forbidden"), { statusCode: 403, code: "visit_forbidden" });
  }
  return visit;
}

/** Optimistic lock: updateMany with version guard. */
async function updateVisitGuarded(
  prisma: PrismaClient,
  visitId: string,
  expectedVersion: number,
  data: Prisma.VisitUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.visit.updateMany({
    where: { id: visitId, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  return result.count === 1;
}

/* --- Routes ------------------------------------------------------------- */

export async function registerVisitRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; supabaseAdmin: SupabaseClient | null },
) {
  const { prisma, supabaseAdmin } = deps;

  // -------- List ------------------------------------------------------
  app.get("/api/visits", async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });

    const query = z.object({
      caseId: z.string().optional(),
      assignedTo: z.string().optional(),
      status: VisitStatus.optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);

    const where: Prisma.VisitWhereInput = {};
    if (query.caseId) where.caseId = query.caseId;
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.scheduledFor = {};
      if (query.from) where.scheduledFor.gte = new Date(query.from);
      if (query.to) where.scheduledFor.lte = new Date(query.to);
    }
    // Fieldworkers only see their own visits, regardless of ?assignedTo.
    if (actor.role === "fieldworker") where.assignedTo = actor.id;
    else if (query.assignedTo) where.assignedTo = query.assignedTo;

    const visits = await prisma.visit.findMany({
      where,
      orderBy: { scheduledFor: "asc" },
      take: query.limit,
      include: {
        evidence: true,
        grievances: true,
        case: { select: { id: true, name: true, household: true, project: true, location: true } },
      },
    });
    return { visits: visits.map(serializeVisit) };
  });

  // -------- Get one ---------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/visits/:id", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });

    const visit = await prisma.visit.findUnique({
      where: { id: request.params.id },
      include: {
        evidence: true,
        grievances: true,
        case: { select: { id: true, name: true, household: true, project: true, location: true } },
      },
    });
    if (!visit) return reply.code(404).send({ error: "visit_not_found" });
    if (actor.role === "fieldworker" && visit.assignedTo !== actor.id) {
      return reply.code(403).send({ error: "visit_forbidden" });
    }
    return { visit: serializeVisit(visit) };
  });

  // -------- Patch (form / start) --------------------------------------
  app.patch<{ Params: { id: string } }>("/api/visits/:id", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });

    const parsed = PatchVisitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_visit_patch", issues: parsed.error.issues });
    }
    const visit = await loadVisitForWrite(prisma, request.params.id, actor);
    if (visit.status === "approved") {
      return reply.code(409).send({ error: "visit_not_editable" });
    }

    const data: Prisma.VisitUpdateManyMutationInput = {};
    if (parsed.data.form !== undefined) data.form = parsed.data.form as Prisma.InputJsonValue;
    if (parsed.data.status !== undefined) data.status = parsed.data.status;
    if (parsed.data.startedAt !== undefined) {
      data.startedAt = parsed.data.startedAt ? new Date(parsed.data.startedAt) : null;
    }

    const ok = await updateVisitGuarded(prisma, visit.id, parsed.data.version, data);
    if (!ok) {
      const latest = await prisma.visit.findUnique({ where: { id: visit.id }, select: { version: true } });
      return reply.code(409).send({ error: "visit_conflict", version: latest?.version ?? 0 });
    }
    const updated = await prisma.visit.findUnique({
      where: { id: visit.id },
      include: { evidence: true, grievances: true },
    });
    return { visit: serializeVisit(updated!) };
  });

  // -------- Evidence upload (multipart) -------------------------------
  app.post<{ Params: { id: string } }>("/api/visits/:id/evidence", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });
    if (!supabaseAdmin) return reply.code(503).send({ error: "evidence_storage_unavailable" });

    const visit = await loadVisitForWrite(prisma, request.params.id, actor);
    if (visit.status === "approved") {
      return reply.code(409).send({ error: "visit_not_editable" });
    }

    const { fields, file } = await readMultipart(request);

    const evidenceId = parseField(fields.id, z.string().min(1).max(80), "id");
    const kind = parseField(fields.kind, EvidenceKind, "kind");
    const category = fields.category ? parseField(fields.category, EvidenceCategory, "category") : undefined;
    const label = parseField(fields.label, z.string().min(1).max(200), "label");
    const capturedAt = parseField(fields.capturedAt, z.string().datetime(), "capturedAt");
    const provenance = fields.provenance ? parseField(JSON.parse(fields.provenance), Provenance, "provenance") : undefined;

    // Idempotency: if this evidenceId already exists, return it.
    const existing = await prisma.visitEvidence.findUnique({ where: { id: evidenceId } });
    if (existing) {
      if (existing.visitId !== visit.id) {
        return reply.code(409).send({ error: "evidence_id_in_use" });
      }
      return { evidence: serializeEvidence(existing) };
    }

    const sniffed = sniffImageOrPdf(file.buffer);
    if (!sniffed) {
      return reply.code(415).send({ error: "evidence_type_unsupported" });
    }

    // Per-visit cap
    const count = await prisma.visitEvidence.count({ where: { visitId: visit.id } });
    if (count >= MAX_EVIDENCE_PER_VISIT) {
      return reply.code(413).send({ error: "evidence_limit_reached", limit: MAX_EVIDENCE_PER_VISIT });
    }

    const hash = sha256(file.buffer);
    const path = `${visit.case.project.replace(/[^A-Za-z0-9_-]/g, "_")}/${visit.caseId}/${visit.id}/${evidenceId}.${sniffed.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: sniffed.mimeType, upsert: false });

    if (uploadError) {
      request.log.error({ err: uploadError, path }, "Supabase storage upload failed");
      // If the object already exists (retry after a DB failure), that's fine — proceed.
      if (!/already exists/i.test(uploadError.message)) {
        return reply.code(502).send({ error: "evidence_upload_failed" });
      }
    }

    let created;
    try {
      created = await prisma.visitEvidence.create({
        data: {
          id: evidenceId,
          visitId: visit.id,
          kind,
          category: category ?? null,
          label,
          storagePath: path,
          mimeType: sniffed.mimeType,
          sizeBytes: file.buffer.length,
          capturedAt: new Date(capturedAt),
          provenance: {
            ...(provenance ?? {}),
            fileHash: provenance?.fileHash ?? hash,
            serverComputedHash: hash,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (dbError) {
      // Orphan cleanup: delete the just-uploaded object so retries are clean.
      try {
        await supabaseAdmin.storage.from(BUCKET).remove([path]);
      } catch (cleanupError) {
        request.log.error({ err: cleanupError, path }, "Could not remove orphaned evidence object");
      }
      request.log.error({ err: dbError, evidenceId }, "Evidence DB insert failed");
      return reply.code(502).send({ error: "evidence_save_failed" });
    }

    return reply.code(201).send({ evidence: serializeEvidence(created) });
  });

  // -------- Evidence read (302 to signed URL) -------------------------
  app.get<{ Params: { id: string; evidenceId: string } }>(
    "/api/visits/:id/evidence/:evidenceId",
    async (request, reply) => {
      const actor = request.authUser;
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!supabaseAdmin) return reply.code(503).send({ error: "evidence_storage_unavailable" });

      const evidence = await prisma.visitEvidence.findFirst({
        where: { id: request.params.evidenceId, visitId: request.params.id },
      });
      if (!evidence) return reply.code(404).send({ error: "evidence_not_found" });

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(evidence.storagePath, 60 * 60);
      if (error || !data?.signedUrl) {
        request.log.error({ err: error, path: evidence.storagePath }, "Signed URL creation failed");
        return reply.code(502).send({ error: "evidence_url_failed" });
      }
      return reply.redirect(data.signedUrl, 302);
    },
  );

  // -------- Evidence delete -------------------------------------------
  app.delete<{ Params: { id: string; evidenceId: string } }>(
    "/api/visits/:id/evidence/:evidenceId",
    async (request, reply) => {
      const actor = request.authUser;
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const visit = await loadVisitForWrite(prisma, request.params.id, actor);
      if (visit.status === "approved") return reply.code(409).send({ error: "visit_not_editable" });

      const evidence = await prisma.visitEvidence.findFirst({
        where: { id: request.params.evidenceId, visitId: visit.id },
      });
      if (!evidence) return reply.code(404).send({ error: "evidence_not_found" });

      await prisma.visitEvidence.delete({ where: { id: evidence.id } });
      if (supabaseAdmin) {
        const { error } = await supabaseAdmin.storage.from(BUCKET).remove([evidence.storagePath]);
        if (error) request.log.warn({ err: error, path: evidence.storagePath }, "Storage delete failed; orphan remains");
      }
      return reply.code(204).send();
    },
  );

  // -------- Submit ----------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/visits/:id/submit", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });

    const parsed = SubmitVisitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_visit_submission", issues: parsed.error.issues });
    }
    const visit = await loadVisitForWrite(prisma, request.params.id, actor);
    if (visit.status !== "assigned" && visit.status !== "in_progress" && visit.status !== "returned") {
      return reply.code(409).send({ error: "visit_not_submittable", status: visit.status });
    }

    // Atomic: visit row + grievances in one transaction.
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.visit.updateMany({
        where: { id: visit.id, version: parsed.data.version },
        data: {
          status: "captured",
          form: parsed.data.form as Prisma.InputJsonValue,
          summary: (parsed.data.summary ?? null) as Prisma.InputJsonValue,
          submittedAt: new Date(parsed.data.submittedAt),
          synced: false,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("visit_conflict");

      // Upsert grievances by client id — idempotent on retry.
      for (const g of parsed.data.grievances) {
        await tx.visitGrievance.upsert({
          where: { id: g.id },
          create: {
            id: g.id,
            visitId: visit.id,
            raisedAt: new Date(g.raisedAt),
            raisedBy: g.raisedBy,
            description: g.description,
            category: g.category,
            categoryOther: g.categoryOther ?? null,
            status: g.status,
            resolutionOwner: g.resolutionOwner ?? null,
            dueDate: g.dueDate ? new Date(g.dueDate) : null,
            resolution: g.resolution ?? null,
            resolvedAt: g.resolvedAt ? new Date(g.resolvedAt) : null,
          },
          update: {}, // never overwrite server-side grievance edits from a stale retry
        });
      }

      await tx.activity.create({
        data: {
          id: crypto.randomUUID(),
          kind: "visit",
          tone: "blue",
          title: "Visit submitted for review",
          detail: visit.id,
          time: "Just now",
          at: new Date(),
          caseId: visit.caseId,
        },
      });

      return tx.visit.findUnique({
        where: { id: visit.id },
        include: { evidence: true, grievances: true },
      });
    }).catch((err: Error) => {
      if (err.message === "visit_conflict") {
        throw Object.assign(err, { statusCode: 409, code: "visit_conflict" });
      }
      throw err;
    });

    return { visit: serializeVisit(result!) };
  });

  // -------- Return ----------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/visits/:id/return", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });
    if (actor.role !== "reviewer" && actor.role !== "supervisor" && actor.role !== "admin") {
      return reply.code(403).send({ error: "review_required" });
    }
    const parsed = ReturnVisitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_return", issues: parsed.error.issues });
    }
    const visit = await prisma.visit.findUnique({ where: { id: request.params.id } });
    if (!visit) return reply.code(404).send({ error: "visit_not_found" });
    if (visit.status !== "captured") {
      return reply.code(409).send({ error: "visit_not_returnable", status: visit.status });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.visit.updateMany({
        where: { id: visit.id, version: parsed.data.version },
        data: {
          status: "returned",
          returnedAt: new Date(),
          reviewedAt: new Date(),
          reviewedBy: actor.name,
          returnReason: parsed.data.reason,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("visit_conflict");

      // Update case readiness — mirrors the current store's returnVisit.
      await tx.caseRecord.update({
        where: { id: visit.caseId },
        data: {
          verification: "Returned for correction",
          verificationTone: "warning",
          readiness: "Review returned",
          nextAction: "Correct visit and resubmit",
        },
      });

      await tx.activity.create({
        data: {
          id: crypto.randomUUID(),
          kind: "visit",
          tone: "coral",
          title: "Visit returned",
          detail: `${visit.id} · ${parsed.data.reason.slice(0, 60)}`,
          time: "Just now",
          at: new Date(),
          caseId: visit.caseId,
        },
      });

      return tx.visit.findUnique({ where: { id: visit.id }, include: { evidence: true, grievances: true } });
    }).catch((err: Error) => {
      if (err.message === "visit_conflict") {
        throw Object.assign(err, { statusCode: 409, code: "visit_conflict" });
      }
      throw err;
    });

    return { visit: serializeVisit(result!) };
  });

  // -------- Approve ---------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/visits/:id/approve", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });
    if (actor.role !== "reviewer" && actor.role !== "supervisor" && actor.role !== "admin") {
      return reply.code(403).send({ error: "review_required" });
    }
    const parsed = ApproveVisitBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_approval", issues: parsed.error.issues });
    }
    const visit = await prisma.visit.findUnique({ where: { id: request.params.id } });
    if (!visit) return reply.code(404).send({ error: "visit_not_found" });
    if (visit.status !== "captured") {
      return reply.code(409).send({ error: "visit_not_approvable", status: visit.status });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.visit.updateMany({
        where: { id: visit.id, version: parsed.data.version },
        data: {
          status: "approved",
          reviewedAt: new Date(),
          reviewedBy: actor.name,
          synced: true,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("visit_conflict");

      // Mirror the store's approveVisit: readiness depends on latest VerifyNow check.
      const caseRecord = await tx.caseRecord.findUnique({ where: { id: visit.caseId } });
      let readiness = "Ready for department";
      let nextAction = "Prepare department handoff packet";
      if (caseRecord) {
        const checks = (caseRecord.verifyNowChecks as unknown[] | null) ?? [];
        // verifyNowChecks isn't a column yet; this is a placeholder for Slice 2.
        // For now, approve just unlocks readiness.
        void checks;
      }
      await tx.caseRecord.update({
        where: { id: visit.caseId },
        data: {
          verification: "Field review approved",
          verificationTone: "success",
          readiness,
          nextAction,
        },
      });

      await tx.activity.create({
        data: {
          id: crypto.randomUUID(),
          kind: "visit",
          tone: "sage",
          title: "Visit approved",
          detail: visit.id,
          time: "Just now",
          at: new Date(),
          caseId: visit.caseId,
        },
      });

      return tx.visit.findUnique({ where: { id: visit.id }, include: { evidence: true, grievances: true } });
    }).catch((err: Error) => {
      if (err.message === "visit_conflict") {
        throw Object.assign(err, { statusCode: 409, code: "visit_conflict" });
      }
      throw err;
    });

    return { visit: serializeVisit(result!) };
  });
}

/* --- Serialization ------------------------------------------------------ */

type VisitWithRelations = Prisma.VisitGetPayload<{
  include: { evidence: true; grievances: true; case?: true };
}>;

function serializeVisit(visit: VisitWithRelations) {
  return {
    id: visit.id,
    caseId: visit.caseId,
    assignedTo: visit.assignedTo,
    scheduledFor: visit.scheduledFor.toISOString(),
    status: visit.status,
    form: visit.form,
    summary: visit.summary,
    startedAt: visit.startedAt?.toISOString() ?? null,
    submittedAt: visit.submittedAt?.toISOString() ?? null,
    reviewedAt: visit.reviewedAt?.toISOString() ?? null,
    returnedAt: visit.returnedAt?.toISOString() ?? null,
    returnReason: visit.returnReason,
    reviewedBy: visit.reviewedBy,
    synced: visit.synced,
    version: visit.version,
    evidence: visit.evidence.map(serializeEvidence),
    grievances: visit.grievances.map(serializeGrievance),
    ...("case" in visit && visit.case ? {
      case: {
        id: visit.case.id,
        name: visit.case.name,
        household: visit.case.household,
        project: visit.case.project,
        location: visit.case.location,
      },
    } : {}),
  };
}

function serializeEvidence(e: {
  id: string; kind: string; category: string | null; label: string;
  mimeType: string; sizeBytes: number; capturedAt: Date;
  provenance: Prisma.JsonValue | null; legibilityStatus: string | null; legibilityNote: string | null;
}) {
  return {
    id: e.id,
    kind: e.kind,
    category: e.category,
    label: e.label,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    capturedAt: e.capturedAt.toISOString(),
    provenance: e.provenance,
    legibilityStatus: e.legibilityStatus,
    legibilityNote: e.legibilityNote,
    // No dataUrl. The client renders via GET /api/visits/:id/evidence/:eid.
  };
}

function serializeGrievance(g: {
  id: string; raisedAt: Date; raisedBy: string; description: string;
  category: string; categoryOther: string | null; status: string;
  resolutionOwner: string | null; dueDate: Date | null;
  resolution: string | null; resolvedAt: Date | null;
}) {
  return {
    id: g.id,
    raisedAt: g.raisedAt.toISOString(),
    raisedBy: g.raisedBy,
    description: g.description,
    category: g.category,
    categoryOther: g.categoryOther,
    status: g.status,
    resolutionOwner: g.resolutionOwner,
    dueDate: g.dueDate?.toISOString() ?? null,
    resolution: g.resolution,
    resolvedAt: g.resolvedAt?.toISOString() ?? null,
  };
}
