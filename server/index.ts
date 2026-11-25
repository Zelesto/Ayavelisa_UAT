import Fastify from "fastify";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { Prisma, PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import { registerVisitRoutes } from "./routes/visits.js";
import { registerGeocodeRoutes } from "./routes/geocode.js";


const prisma = new PrismaClient();
const DEFAULT_BRANCH_ID = "eastern-cape-delivery";
const STATE_ID = "workspace";
const app = Fastify({
  logger: true,
  bodyLimit: 50 * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === "true",
});
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const bootstrapAdminEmails = new Set(
  (process.env.SUPABASE_BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const AccountRole = z.enum(["admin", "fieldworker", "supervisor", "reviewer"]);
type AccountRole = z.infer<typeof AccountRole>;
type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: AccountRole;
};

async function ensureDefaultBranch() {
  await prisma.branch.upsert({
    where: { id: DEFAULT_BRANCH_ID },
    create: { id: DEFAULT_BRANCH_ID, name: "Eastern Cape delivery" },
    update: {},
  });
  await prisma.branchConfiguration.upsert({
    where: { branchId: DEFAULT_BRANCH_ID },
    create: {
      id: `config-${DEFAULT_BRANCH_ID}`,
      branchId: DEFAULT_BRANCH_ID,
      data: {
        title: "Individual subsidy",
        version: "2.3",
        effectiveOn: "2026-10-01",
        owner: "Ayavelisa programme lead",
        eligibilityRules: [],
      },
      updatedBy: "system",
    },
    update: {},
  });
  await prisma.appState.updateMany({
    where: { id: STATE_ID, branchId: null },
    data: { branchId: DEFAULT_BRANCH_ID },
  });

  const users = await prisma.user.findMany({
    select: { id: true, branchMemberships: { select: { branchId: true, isDefault: true } } },
  });
  for (const user of users) {
    if (user.branchMemberships.length === 0) {
      await prisma.userBranch.create({
        data: { userId: user.id, branchId: DEFAULT_BRANCH_ID, isDefault: true },
      });
    } else if (!user.branchMemberships.some((membership) => membership.isDefault)) {
      await prisma.userBranch.update({
        where: { userId_branchId: { userId: user.id, branchId: user.branchMemberships[0].branchId } },
        data: { isDefault: true },
      });
    }
  }
}

await ensureDefaultBranch();

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    branchId: string | null;
  }
}

if (process.env.NODE_ENV === "production" && (!supabase || bootstrapAdminEmails.size === 0)) {
  throw new Error("Production requires Supabase URL, anon key, and at least one bootstrap admin email.");
}

const SaveStateBody = z.object({
  version: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
});
const BranchConfigurationBody = z.object({
  version: z.number().int().nonnegative(),
  data: z.object({
    title: z.string().trim().min(2).max(160),
    version: z.string().trim().min(1).max(40),
    effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    owner: z.string().trim().min(2).max(120),
    eligibilityRules: z.array(z.object({
      id: z.string().min(1).max(80),
      label: z.string().trim().min(2).max(160),
      description: z.string().trim().max(1000),
      required: z.boolean(),
      evidenceTypes: z.array(z.string().trim().min(1).max(80)).max(12),
    })).max(100),
  }),
});
const WorkspaceCase = z.object({
  id: z.string().min(1),
  name: z.string(),
  household: z.string(),
  project: z.string(),
  location: z.string(),
  source: z.string(),
  verification: z.string(),
  verificationTone: z.string(),
  subsidy: z.string(),
  subsidyTone: z.string(),
  readiness: z.string(),
  nextAction: z.string(),
  updated: z.string(),
  members: z.number().int(),
  site: z.string(),
  sources: z.array(z.record(z.string(), z.unknown())).optional(),
  intakeId: z.string().nullable().optional(),
  latestVisitSummary: z.record(z.string(), z.unknown()).nullable().optional(),
  archivedAt: z.string().datetime().nullable().optional(),
});
const WorkspaceVisit = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  assignedTo: z.string().min(1),
  scheduledFor: z.string().datetime(),
  status: z.enum(["assigned", "in_progress", "captured", "returned", "approved"]),
  form: z.record(z.string(), z.unknown()).nullable().optional(),
  summary: z.record(z.string(), z.unknown()).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
  reviewedAt: z.string().datetime().nullable().optional(),
  returnedAt: z.string().datetime().nullable().optional(),
  returnReason: z.string().nullable().optional(),
  reviewedBy: z.string().nullable().optional(),
  synced: z.boolean().optional(),
});
const WorkspaceBlocker = z.object({
  id: z.string().min(1),
  label: z.string(),
  detail: z.string(),
  action: z.string(),
  primary: z.enum(["request", "assign"]),
  status: z.enum(["open", "requested", "assigned", "resolved"]),
});
const InviteUserBody = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(120).optional(),
  role: AccountRole,
  branchIds: z.array(z.string().min(1)).min(1).optional(),
  defaultBranchId: z.string().min(1).optional(),
}).refine((value) =>
  value.defaultBranchId === undefined || value.branchIds?.includes(value.defaultBranchId) === true,
);
const UpdateUserBody = z.object({
  role: AccountRole.optional(),
  active: z.boolean().optional(),
  branchIds: z.array(z.string().min(1)).min(1).optional(),
  defaultBranchId: z.string().min(1).optional(),
}).refine((value) =>
  value.role !== undefined || value.active !== undefined || value.branchIds !== undefined || value.defaultBranchId !== undefined,
).refine((value) => value.defaultBranchId === undefined || value.branchIds?.includes(value.defaultBranchId) === true);

const editableStateKeys: Record<AccountRole, ReadonlySet<string> | null> = {
  admin: null,
  supervisor: null,
  reviewer: new Set([
    "cases", "visits", "blockers", "activities", "sync", "auditLog",
    "intakes", "beneficiaryLeads", "leadImportBatches",
  ]),
  fieldworker: new Set([
    "visits", "intakes", "beneficiaryLeads", "leadImportBatches",
    "sync", "activities",
  ]),
};

function localDevelopmentUser(personaHeader: string | string[] | undefined): AuthenticatedUser {
  const persona = z.enum(["fieldworker", "supervisor", "reviewer"]).catch("fieldworker")
    .parse(Array.isArray(personaHeader) ? personaHeader[0] : personaHeader);
  const users = {
    fieldworker: { id: "Lindiwe Ndlovu", name: "Lindiwe Ndlovu", role: "fieldworker" as const },
    supervisor: { id: "Thandi Ndlovu", name: "Thandi Ndlovu", role: "supervisor" as const },
    reviewer: { id: "Sipho Mahlangu", name: "Sipho Mahlangu", role: "reviewer" as const },
  };
  return { ...users[persona], email: `${persona}@local.ayavelisa.test` };
}

async function syncWorkspaceEntities(
  transaction: Prisma.TransactionClient,
  state: Record<string, unknown>,
  branchId: string,
) {
  const parsedCases = z.array(WorkspaceCase).safeParse(state.cases ?? []);
  if (!parsedCases.success) {
    throw Object.assign(new Error("invalid_workspace_cases"), {
      statusCode: 400, code: "invalid_workspace_cases", issues: parsedCases.error.issues,
    });
  }
  const parsedVisits = z.array(WorkspaceVisit).safeParse(state.visits ?? []);
  if (!parsedVisits.success) {
    throw Object.assign(new Error("invalid_workspace_visits"), {
      statusCode: 400, code: "invalid_workspace_visits", issues: parsedVisits.error.issues,
    });
  }

  const cases = parsedCases.data;
  const visits = parsedVisits.data;
  const caseIds = new Set(cases.map((record) => record.id));
  const existingCases = new Set((await transaction.caseRecord.findMany({
    where: { id: { in: [...caseIds] } },
    select: { id: true },
  })).map((record) => record.id));
  const branchCases = await transaction.branchCase.findMany({
    where: { caseId: { in: [...caseIds] } },
    select: { caseId: true, branchId: true },
  });
  const crossBranchCase = branchCases.find((record) => record.branchId !== branchId);
  if (crossBranchCase) {
    throw Object.assign(new Error("case_id_in_another_branch"), {
      statusCode: 409, code: "case_id_in_another_branch", field: crossBranchCase.caseId,
    });
  }
  if (branchCases.length === 0 && branchId !== DEFAULT_BRANCH_ID) {
    const unassignedExistingCase = cases.find((record) => existingCases.has(record.id));
    if (unassignedExistingCase) {
      throw Object.assign(new Error("case_id_in_another_branch"), {
        statusCode: 409, code: "case_id_in_another_branch", field: unassignedExistingCase.id,
      });
    }
  }

  for (const record of cases) {
    const caseData = {
      name: record.name,
      household: record.household,
      project: record.project,
      location: record.location,
      source: record.source,
      verification: record.verification,
      verificationTone: record.verificationTone,
      subsidy: record.subsidy,
      subsidyTone: record.subsidyTone,
      readiness: record.readiness,
      nextAction: record.nextAction,
      updated: record.updated,
      members: record.members,
      site: record.site,
      sources: record.sources as Prisma.InputJsonValue | undefined ?? Prisma.DbNull,
      intakeId: record.intakeId ?? null,
      latestVisitSummary: record.latestVisitSummary as Prisma.InputJsonValue | undefined ?? Prisma.DbNull,
      archivedAt: record.archivedAt ? new Date(record.archivedAt) : null,
    };
    await transaction.caseRecord.upsert({
      where: { id: record.id },
      create: { id: record.id, ...caseData },
      update: caseData,
    });
  }

  if (cases.length > 0) {
    await transaction.branchCase.createMany({
      skipDuplicates: true,
      data: cases.map((record) => ({ branchId, caseId: record.id })),
    });
  }
  await transaction.branchCase.deleteMany({
    where: {
      branchId,
      ...(caseIds.size > 0 ? { caseId: { notIn: [...caseIds] } } : {}),
    },
  });

  const rawBlockers = state.blockers && typeof state.blockers === "object" && !Array.isArray(state.blockers)
    ? state.blockers as Record<string, unknown>
    : {};
  const parsedBlockers: Array<z.infer<typeof WorkspaceBlocker> & { caseId: string }> = [];
  for (const [caseId, rawList] of Object.entries(rawBlockers)) {
    if (!caseIds.has(caseId)) continue;
    const parsedList = z.array(WorkspaceBlocker).safeParse(rawList);
    if (!parsedList.success) {
      throw Object.assign(new Error("invalid_workspace_blockers"), {
        statusCode: 400, code: "invalid_workspace_blockers", field: caseId, issues: parsedList.error.issues,
      });
    }
    parsedBlockers.push(...parsedList.data.map((record) => ({ ...record, caseId })));
  }
  const blockerIds = [...new Set(parsedBlockers.map((blocker) => blocker.id))];
  const existingBlockers = blockerIds.length
    ? await transaction.blocker.findMany({
        where: { id: { in: blockerIds } },
        select: { id: true, caseId: true },
      })
    : [];
  const conflictingBlocker = existingBlockers.find((existing) =>
    parsedBlockers.find((blocker) => blocker.id === existing.id)?.caseId !== existing.caseId,
  );
  if (conflictingBlocker) {
    throw Object.assign(new Error("blocker_id_in_use"), {
      statusCode: 409, code: "blocker_id_in_use", field: conflictingBlocker.id,
    });
  }
  for (const blocker of parsedBlockers) {
    await transaction.blocker.upsert({
      where: { id: blocker.id },
      create: blocker,
      update: {
        label: blocker.label,
        detail: blocker.detail,
        action: blocker.action,
        primary: blocker.primary,
        status: blocker.status,
      },
    });
  }
  if (caseIds.size > 0) {
    await transaction.blocker.deleteMany({
      where: {
        caseId: { in: [...caseIds] },
        ...(blockerIds.length > 0 ? { id: { notIn: blockerIds } } : {}),
      },
    });
  }

  const knownCaseIds = new Set([...existingCases, ...caseIds]);
  const invalidVisit = visits.find((record) => !knownCaseIds.has(record.caseId));
  if (invalidVisit) {
    throw Object.assign(new Error("visit_case_not_found"), {
      statusCode: 400, code: "visit_case_not_found", field: invalidVisit.caseId,
    });
  }
  const visitIds = new Set(visits.map((record) => record.id));
  const existingVisits = new Set((await transaction.visit.findMany({
    where: { id: { in: [...visitIds] } },
    select: { id: true },
  })).map((record) => record.id));
  const newVisits = visits.filter((record) => !existingVisits.has(record.id));

  if (newVisits.length > 0) {
    await transaction.visit.createMany({
      skipDuplicates: true,
      data: newVisits.map((record) => ({
        id: record.id,
        caseId: record.caseId,
        assignedTo: record.assignedTo,
        scheduledFor: new Date(record.scheduledFor),
        status: record.status,
        form: record.form as Prisma.InputJsonValue | undefined ?? Prisma.DbNull,
        summary: record.summary as Prisma.InputJsonValue | undefined ?? Prisma.DbNull,
        startedAt: record.startedAt ? new Date(record.startedAt) : null,
        submittedAt: record.submittedAt ? new Date(record.submittedAt) : null,
        reviewedAt: record.reviewedAt ? new Date(record.reviewedAt) : null,
        returnedAt: record.returnedAt ? new Date(record.returnedAt) : null,
        returnReason: record.returnReason ?? null,
        reviewedBy: record.reviewedBy ?? null,
        synced: record.synced ?? false,
      })),
    });
  }
}

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 25 },
});

/* --- Global error handler ------------------------------------------------ */
/* Every route throws either a plain Error or one with a `code`/`statusCode`
   attached. Convert it to a stable JSON shape so the client's ApiError can
   parse it. Never leak stack traces in production. */
app.setErrorHandler((error, request, reply) => {
  const routeError: Error & {
    statusCode?: number;
    status?: number;
    code?: string;
    issues?: unknown;
    field?: unknown;
    sections?: unknown;
    limit?: number;
  } = error instanceof Error
    ? error as Error & {
        statusCode?: number;
        status?: number;
        code?: string;
        issues?: unknown;
        field?: unknown;
        sections?: unknown;
        limit?: number;
      }
    : new Error(String(error));
  const statusCode =
    (typeof routeError.statusCode === "number" ? routeError.statusCode : undefined)
    ?? routeError.status
    ?? 500;

  const code =
    routeError.code ??
    (statusCode === 500 ? "internal_error" : routeError.name ?? "error");

  if (statusCode >= 500) {
    request.log.error({ err: routeError, code, requestId: request.id }, "Unhandled route error");
  } else {
    request.log.warn({ err: routeError.message, code, requestId: request.id }, "Handled route error");
  }

  const body: Record<string, unknown> = { error: code, requestId: request.id };
  const issues = routeError.issues;
  if (issues) body.issues = issues;
  const field = routeError.field;
  if (field) body.field = field;
  const sections = routeError.sections;
  if (sections) body.sections = sections;
  const limit = routeError.limit;
  if (limit !== undefined) body.limit = limit;

  // Never send the raw message for 5xx.
  if (statusCode < 500 && routeError.message && routeError.message !== code) {
    body.message = routeError.message;
  }

  return reply.code(statusCode).send(body);
});

app.decorateRequest("authUser", null);
app.decorateRequest("branchId", null);
app.addHook("preHandler", async (request, reply) => {
  const route = request.url.split("?")[0];
  if (!route.startsWith("/api/") || route === "/api/health") return;
  if (!supabase) {
    if (process.env.NODE_ENV !== "production") {
      request.authUser = localDevelopmentUser(request.headers["x-dev-persona"]);
      return;
    }
    return reply.code(503).send({ error: "authentication_unavailable" });
  }

  const authorization = request.headers.authorization;
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return reply.code(401).send({ error: "unauthorized" });

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error) {
    request.log.warn({ status: error.status }, "Supabase access-token validation failed");
    return reply.code(error.status === 401 ? 401 : 503)
      .send({ error: error.status === 401 ? "unauthorized" : "authentication_unavailable" });
  }
  if (!data.user) return reply.code(401).send({ error: "unauthorized" });

  const email = data.user.email?.trim().toLowerCase();
  if (!email) return reply.code(403).send({ error: "account_email_required" });

  let account = await prisma.user.findUnique({ where: { id: data.user.id } });
  if (!account && bootstrapAdminEmails.has(email)) {
    try {
      account = await prisma.user.upsert({
        where: { id: data.user.id },
        create: {
          id: data.user.id,
          email,
          name: data.user.user_metadata?.full_name?.toString() || email,
          role: "admin",
          active: true,
        },
        update: {},
      });
    } catch (error) {
      request.log.error({ err: error }, "Could not provision bootstrap administrator");
      return reply.code(503).send({ error: "account_provisioning_failed" });
    }
  }
  if (!account?.email || account.email.toLowerCase() !== email) {
    return reply.code(403).send({ error: "account_not_invited" });
  }
  if (!account.active) return reply.code(403).send({ error: "account_inactive" });
  if (bootstrapAdminEmails.has(email) && account.role === "admin") {
    const membershipCount = await prisma.userBranch.count({ where: { userId: account.id } });
    if (membershipCount === 0) {
      await prisma.userBranch.create({
        data: { userId: account.id, branchId: DEFAULT_BRANCH_ID, isDefault: true },
      });
    }
  }
  const role = AccountRole.safeParse(account.role);
  if (!role.success) {
    request.log.error({ userId: account.id }, "Account has an unsupported role");
    return reply.code(403).send({ error: "account_role_invalid" });
  }
  request.authUser = {
    id: account.id,
    email,
    name: account.name,
    role: role.data,
  };
});

app.addHook("preHandler", async (request, reply) => {
  const route = request.url.split("?")[0];
  if (route !== "/api/state" && route !== "/api/overview" && route !== "/api/configuration" && route !== "/api/visits" && !route.startsWith("/api/visits/")) return;
  const branchHeader = request.headers["x-branch-id"];
  const branchId = Array.isArray(branchHeader) ? branchHeader[0] : branchHeader;
  if (!branchId) return reply.code(400).send({ error: "branch_selection_required" });
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, active: true } });
  if (!branch?.active) return reply.code(404).send({ error: "branch_not_found" });
  const isLocalDemoUser = request.authUser?.email.endsWith("@local.ayavelisa.test") ?? false;
  if (!isLocalDemoUser) {
    const membership = await prisma.userBranch.findUnique({
      where: { userId_branchId: { userId: request.authUser!.id, branchId } },
      select: { userId: true },
    });
    if (!membership) return reply.code(403).send({ error: "branch_access_denied" });
  }
  request.branchId = branchId;
});

app.get("/api/health", async (request, reply) => {
  const health: Record<string, unknown> = { ok: true, database: "connected", version: process.env.npm_package_version ?? "0.1.0" };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    request.log.error({ err: error }, "Database health check failed");
    health.ok = false;
    health.database = "unavailable";
  }
  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.storage.getBucket("visit-evidence");
      health.storage = error ? "unavailable" : "connected";
      if (error && health.ok) { health.ok = false; }
    } catch {
      health.storage = "unavailable";
    }
  } else {
    health.storage = "not_configured";
  }
  return reply.code(health.ok ? 200 : 503).send(health);
});

app.get("/api/me", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (!request.authUser) {
    if (process.env.NODE_ENV !== "production") return { user: null };
    return reply.code(401).send({ error: "unauthorized" });
  }
  return { user: request.authUser };
});

app.patch("/api/me", async (request, reply) => {
  const actor = request.authUser;
  if (!actor) return reply.code(401).send({ error: "unauthorized" });
  const parsed = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_profile", issues: parsed.error.issues });
  const updated = await prisma.user.update({
    where: { id: actor.id },
    data: { name: parsed.data.name },
    select: { id: true, email: true, name: true, role: true },
  });
  const role = AccountRole.safeParse(updated.role);
  if (!role.success) return reply.code(403).send({ error: "account_role_invalid" });
  return { user: { ...updated, email: updated.email ?? actor.email, role: role.data } };
});

app.get("/api/configuration", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const configuration = await prisma.branchConfiguration.findUnique({
    where: { branchId: request.branchId! },
  });
  return { data: configuration?.data ?? null, version: configuration?.version ?? 0 };
});

app.put("/api/configuration", async (request, reply) => {
  const actor = request.authUser;
  if (!actor) return reply.code(401).send({ error: "unauthorized" });
  if (actor.role !== "admin" && actor.role !== "supervisor") {
    return reply.code(403).send({ error: "configuration_edit_forbidden" });
  }
  const parsed = BranchConfigurationBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_configuration", issues: parsed.error.issues });

  const branchId = request.branchId!;
  const current = await prisma.branchConfiguration.findUnique({ where: { branchId } });
  if ((current && current.version !== parsed.data.version) || (!current && parsed.data.version !== 0)) {
    return reply.code(409).send({ error: "configuration_conflict", version: current?.version ?? 0 });
  }

  if (!current) {
    try {
      const created = await prisma.branchConfiguration.create({
        data: {
          id: crypto.randomUUID(),
          branchId,
          data: parsed.data.data,
          version: 1,
          updatedBy: actor.id,
        },
      });
      return { data: created.data, version: created.version };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const latest = await prisma.branchConfiguration.findUnique({ where: { branchId } });
        return reply.code(409).send({ error: "configuration_conflict", version: latest?.version ?? 0 });
      }
      throw error;
    }
  }

  const updated = await prisma.branchConfiguration.updateMany({
    where: { branchId, version: parsed.data.version },
    data: { data: parsed.data.data, version: { increment: 1 }, updatedBy: actor.id },
  });
  if (updated.count !== 1) {
    const latest = await prisma.branchConfiguration.findUnique({ where: { branchId } });
    return reply.code(409).send({ error: "configuration_conflict", version: latest?.version ?? 0 });
  }
  const saved = await prisma.branchConfiguration.findUniqueOrThrow({ where: { branchId } });
  return { data: saved.data, version: saved.version };
});

app.get("/api/branches/mine", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const actor = request.authUser;
  if (!actor) return reply.code(401).send({ error: "unauthorized" });
  const memberships = actor.email.endsWith("@local.ayavelisa.test")
    ? await prisma.branch.findMany({ where: { active: true }, orderBy: { name: "asc" } })
    : (await prisma.userBranch.findMany({
        where: { userId: actor.id, branch: { active: true } },
        include: { branch: true },
        orderBy: [{ isDefault: "desc" }, { branch: { name: "asc" } }],
      })).map((membership) => ({ ...membership.branch, isDefault: membership.isDefault }));
  if (!memberships.length) return reply.code(403).send({ error: "no_branches_assigned" });
  return {
    branches: memberships.map((branch) => ({
      id: branch.id,
      name: branch.name,
      isDefault: "isDefault" in branch ? branch.isDefault : branch.id === DEFAULT_BRANCH_ID,
    })),
  };
});

app.get("/api/admin/branches", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (request.authUser?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  const branches = await prisma.branch.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  return { branches };
});

app.post("/api/admin/branches", async (request, reply) => {
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  const parsed = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_branch", issues: parsed.error.issues });
  const name = parsed.data.name;
  const id = crypto.randomUUID();
  try {
    const branch = await prisma.$transaction(async (transaction) => {
      const currentDefault = await transaction.userBranch.findFirst({
        where: { userId: actor.id, isDefault: true },
        select: { branchId: true },
      });
      const created = await transaction.branch.create({ data: { id, name } });
      await transaction.userBranch.create({
        data: { userId: actor.id, branchId: id, isDefault: !currentDefault },
      });
      await transaction.branchConfiguration.create({
        data: {
          id: `config-${id}`,
          branchId: id,
          data: {
            title: "",
            version: "1.0",
            effectiveOn: "",
            owner: actor.name,
            eligibilityRules: [],
          },
          updatedBy: actor.id,
        },
      });
      return created;
    });
    return reply.code(201).send({ branch });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "branch_name_already_exists" });
    }
    request.log.error({ err: error }, "Could not create branch");
    return reply.code(500).send({ error: "branch_creation_failed" });
  }
});

app.patch<{ Params: { id: string } }>("/api/admin/branches/:id", async (request, reply) => {
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  const parsed = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_branch", issues: parsed.error.issues });
  try {
    const branch = await prisma.branch.update({
      where: { id: request.params.id },
      data: { name: parsed.data.name },
    });
    return { branch };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "branch_name_already_exists" });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return reply.code(404).send({ error: "branch_not_found" });
    }
    request.log.error({ err: error, branchId: request.params.id }, "Could not update branch");
    return reply.code(500).send({ error: "branch_update_failed" });
  }
});

app.get("/api/admin/users", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (request.authUser?.role !== "admin") {
    return reply.code(403).send({ error: "admin_required" });
  }
  const users = await prisma.user.findMany({
    where: { email: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, email: true, name: true, role: true, active: true, createdAt: true,
      branchMemberships: {
        where: { branch: { active: true } },
        select: { branchId: true, isDefault: true, branch: { select: { name: true } } },
      },
    },
  });
  return {
    users: users.map(({ branchMemberships, ...user }) => ({
      ...user,
      branchIds: branchMemberships.map((membership) => membership.branchId),
      defaultBranchId: branchMemberships.find((membership) => membership.isDefault)?.branchId ?? null,
      branches: branchMemberships.map((membership) => ({ id: membership.branchId, name: membership.branch.name })),
    })),
  };
});

async function findSupabaseUserByEmail(email: string) {
  if (!supabaseAdmin) return null;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  throw new Error("Supabase account search exceeded the pagination limit");
}

function getSupabaseEmailConfirmed(authUser: { email_confirmed_at?: string | null }) {
  return Boolean(authUser.email_confirmed_at);
}

async function createManagedUser(
  actor: AuthenticatedUser,
  authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> },
  email: string,
  name: string | undefined,
  role: AccountRole,
  branchIds: string[],
  defaultBranchId: string,
  action: "invite" | "link_existing",
) {
  return prisma.$transaction(async (transaction) => {
    const created = await transaction.user.create({
      data: {
        id: authUser.id,
        email,
        name: name ?? authUser.user_metadata?.full_name?.toString() ?? email,
        role,
        active: true,
      },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    });
    await transaction.userBranch.createMany({
        data: branchIds.map((branchId) => ({
          userId: created.id,
          branchId,
          isDefault: branchId === defaultBranchId,
        })),
    });
    await transaction.userAudit.create({
      data: {
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        subjectUserId: created.id,
        action,
        after: { id: created.id, email: created.email, name: created.name, role: created.role, active: created.active },
      },
    });
    return {
      ...created,
      branchIds,
      defaultBranchId,
    };
  });
}

app.post("/api/admin/users", async (request, reply) => {
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  const parsed = InviteUserBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_user", issues: parsed.error.issues });
  }
  if (!supabaseAdmin) return reply.code(503).send({ error: "user_invites_unavailable" });

  const email = parsed.data.email.toLowerCase();
  const branchIds = [...new Set(parsed.data.branchIds ?? [
    (request.headers["x-branch-id"] as string | undefined) ?? DEFAULT_BRANCH_ID,
  ])];
  const defaultBranchId = parsed.data.defaultBranchId ?? branchIds[0];
  if (!branchIds.includes(defaultBranchId)) return reply.code(400).send({ error: "default_branch_must_be_assigned" });
  const activeBranches = await prisma.branch.count({ where: { id: { in: branchIds }, active: true } });
  if (activeBranches !== branchIds.length) return reply.code(400).send({ error: "invalid_branch_assignment" });
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) return reply.code(409).send({ error: "account_already_managed" });

  let existingAuthUser: Awaited<ReturnType<typeof findSupabaseUserByEmail>>;
  try {
    existingAuthUser = await findSupabaseUserByEmail(email);
  } catch (lookupError) {
    request.log.error({ err: lookupError }, "Could not check for an existing Supabase account");
    return reply.code(502).send({ error: "existing_auth_account_lookup_failed" });
  }

  if (existingAuthUser?.id) {
    try {
      const user = await createManagedUser(actor, existingAuthUser, email, parsed.data.name, parsed.data.role, branchIds, defaultBranchId, "link_existing");
      return reply.code(201).send({ user, linkedExisting: true });
    } catch (linkError) {
      request.log.error({ err: linkError, authUserId: existingAuthUser.id }, "Could not link existing Supabase account");
      return reply.code(502).send({ error: "existing_auth_account_link_failed" });
    }
  }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: parsed.data.name ?? email },
  });
  if (error || !data.user?.id) {
    request.log.warn({ status: error?.status, code: error?.code }, "Supabase invite failed");
    const errorCode = error?.code === "over_email_send_rate_limit"
      ? "email_rate_limited"
      : error?.code === "email_address_invalid"
        ? "email_delivery_not_configured"
        : "invite_failed";
    return reply.code(502).send({ error: errorCode });
  }

  try {
    const user = await createManagedUser(actor, data.user, email, parsed.data.name, parsed.data.role, branchIds, defaultBranchId, "invite");
    return reply.code(201).send({ user });
  } catch (error) {
    request.log.error({ err: error, invitedUserId: data.user.id }, "Invite sent but account setup failed");
    return reply.code(502).send({ error: "invite_sent_account_setup_failed" });
  }
});

app.post<{ Params: { id: string } }>("/api/admin/users/:id/resend-access", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  if (!supabaseAdmin || !supabase) return reply.code(503).send({ error: "user_email_unavailable" });

  const account = await prisma.user.findUnique({ where: { id: request.params.id } });
  if (!account?.email) return reply.code(404).send({ error: "account_not_found" });
  if (!account.active) return reply.code(409).send({ error: "account_inactive" });

  const { data, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(account.id);
  if (lookupError || !data.user?.email) {
    request.log.error({ status: lookupError?.status, code: lookupError?.code }, "Could not find account in Supabase Auth");
    return reply.code(502).send({ error: "auth_account_not_found" });
  }

  const email = data.user.email.trim().toLowerCase();
  const sendResult = getSupabaseEmailConfirmed(data.user)
    ? await supabase.auth.resetPasswordForEmail(email)
    : await supabase.auth.resend({ type: "signup", email });

  if (sendResult.error) {
    request.log.warn({ status: sendResult.error.status, code: sendResult.error.code }, "Could not send account access email");
    const errorCode = sendResult.error.code === "over_email_send_rate_limit"
      ? "email_rate_limited"
      : "access_email_failed";
    return reply.code(502).send({ error: errorCode });
  }

  try {
    await prisma.userAudit.create({
      data: {
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        subjectUserId: account.id,
        action: getSupabaseEmailConfirmed(data.user) ? "password_recovery_sent" : "confirmation_resent",
        after: { email, confirmed: getSupabaseEmailConfirmed(data.user) },
      },
    });
  } catch (auditError) {
    request.log.error({ err: auditError, subjectUserId: account.id }, "Access email sent but the action could not be audited");
    return reply.code(502).send({ error: "email_sent_audit_failed" });
  }
  return { sent: true, type: getSupabaseEmailConfirmed(data.user) ? "password_recovery" : "confirmation" };
});

app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  const parsed = UpdateUserBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_user_update", issues: parsed.error.issues });
  }
  if (request.params.id === actor.id && (parsed.data.active === false || parsed.data.role !== undefined && parsed.data.role !== "admin")) {
    return reply.code(400).send({ error: "cannot_remove_own_admin_access" });
  }
  const requestedBranchIds = parsed.data.branchIds ? [...new Set(parsed.data.branchIds)] : null;
  if (requestedBranchIds) {
    const activeBranches = await prisma.branch.count({ where: { id: { in: requestedBranchIds }, active: true } });
    if (activeBranches !== requestedBranchIds.length) return reply.code(400).send({ error: "invalid_branch_assignment" });
  }

  let accountToActivate: { id: string; email: string | null } | null = null;
  if (parsed.data.active === true) {
    try {
      accountToActivate = await prisma.user.findUnique({
        where: { id: request.params.id },
        select: { id: true, email: true },
      });
    } catch (lookupError) {
      request.log.error({ err: lookupError, userId: request.params.id }, "Could not load managed account for activation");
      return reply.code(503).send({ error: "account_lookup_failed" });
    }
  }
  if (parsed.data.active === true && !accountToActivate) {
    return reply.code(404).send({ error: "account_not_found" });
  }

  if (accountToActivate) {
    const activationEmail = accountToActivate.email;
    if (!activationEmail) return reply.code(404).send({ error: "account_not_found" });
    if (!supabaseAdmin) return reply.code(503).send({ error: "account_activation_unavailable" });
    try {
      const { data: authUser, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(request.params.id);
      if (lookupError || !authUser.user?.email) {
        request.log.error({ status: lookupError?.status, code: lookupError?.code }, "Could not find account in Supabase Auth for activation");
        return reply.code(502).send({ error: "auth_account_not_found" });
      }
      if (authUser.user.email.trim().toLowerCase() !== activationEmail.toLowerCase()) {
        request.log.error({ userId: request.params.id }, "Supabase and Ayavelisa account emails do not match");
        return reply.code(409).send({ error: "account_email_mismatch" });
      }
      if (!getSupabaseEmailConfirmed(authUser.user)) {
        const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(request.params.id, { email_confirm: true });
        if (confirmError) {
          request.log.error({ status: confirmError.status, code: confirmError.code }, "Could not confirm account email for administrator-approved access");
          return reply.code(502).send({ error: "account_confirmation_failed" });
        }
      }
    } catch (activationError) {
      request.log.error({ err: activationError, userId: request.params.id }, "Supabase activation request failed");
      return reply.code(502).send({ error: "account_confirmation_failed" });
    }
  }

  try {
    const updatedUser = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(78112026)) AS account_lock`;
      const current = await transaction.user.findUnique({ where: { id: request.params.id } });
      if (!current?.email) return null;
      const currentMemberships = await transaction.userBranch.findMany({
        where: { userId: current.id },
        select: { branchId: true, isDefault: true },
      });
      const branchIds = requestedBranchIds ?? currentMemberships.map((membership) => membership.branchId);
      if (branchIds.length === 0) throw new Error("branch_assignment_required");
      const defaultBranchId = parsed.data.defaultBranchId
        ?? currentMemberships.find((membership) => membership.isDefault && branchIds.includes(membership.branchId))?.branchId
        ?? branchIds[0];
      if (!branchIds.includes(defaultBranchId)) throw new Error("default_branch_must_be_assigned");

      const nextRole = parsed.data.role ?? current.role;
      const nextActive = parsed.data.active ?? current.active;
      if (current.role === "admin" && current.active && (nextRole !== "admin" || !nextActive)) {
        const activeAdmins = await transaction.user.count({
          where: { role: "admin", active: true, email: { not: null } },
        });
        if (activeAdmins <= 1) throw new Error("last_active_admin");
      }

      const updated = await transaction.user.update({
        where: { id: current.id },
        data: { role: nextRole, active: nextActive },
        select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
      });
      if (requestedBranchIds) {
        await transaction.userBranch.deleteMany({ where: { userId: current.id } });
        await transaction.userBranch.createMany({
          data: branchIds.map((branchId) => ({
            userId: current.id,
            branchId,
            isDefault: branchId === defaultBranchId,
          })),
        });
      }
      await transaction.userAudit.create({
        data: {
          id: crypto.randomUUID(),
          actorUserId: actor.id,
          subjectUserId: updated.id,
          action: parsed.data.active === true ? "administrator_approved_login" : "update",
          before: { role: current.role, active: current.active },
          after: {
            role: updated.role,
            active: updated.active,
            ...(parsed.data.active === true ? { emailConfirmed: true } : {}),
          },
        },
      });
      return {
        ...updated,
        branchIds,
        defaultBranchId,
      };
    });
    if (!updatedUser) return reply.code(404).send({ error: "account_not_found" });
    return { user: updatedUser, ...(parsed.data.active === true ? { loginAllowed: true } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message === "last_active_admin") {
      return reply.code(409).send({ error: "cannot_remove_last_active_admin" });
    }
    if (error instanceof Error && error.message === "branch_assignment_required") {
      return reply.code(409).send({ error: "branch_assignment_required" });
    }
    request.log.error({ err: error }, "Could not update account");
    return reply.code(503).send({ error: "account_update_failed" });
  }
});

app.delete<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
  const actor = request.authUser;
  if (actor?.role !== "admin") return reply.code(403).send({ error: "admin_required" });
  if (request.params.id === actor.id) return reply.code(400).send({ error: "cannot_delete_own_account" });
  if (!supabaseAdmin) return reply.code(503).send({ error: "account_deletion_unavailable" });

  try {
    const deletedUser = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(78112026)) AS account_lock`;
      const current = await transaction.user.findUnique({ where: { id: request.params.id } });
      if (!current?.email) return null;

      if (current.role === "admin" && current.active) {
        const activeAdmins = await transaction.user.count({
          where: { role: "admin", active: true, email: { not: null } },
        });
        if (activeAdmins <= 1) throw new Error("last_active_admin");
      }

      await transaction.userAudit.create({
        data: {
          id: crypto.randomUUID(),
          actorUserId: actor.id,
          subjectUserId: current.id,
          action: "delete",
          before: { id: current.id, email: current.email, name: current.name, role: current.role, active: current.active },
        },
      });

      await transaction.user.delete({ where: { id: current.id } });
      return { id: current.id, email: current.email };
    });

    if (!deletedUser) return reply.code(404).send({ error: "account_not_found" });

    // Supabase delete happens AFTER the DB commit. If it fails, the app row
    // is already gone, so log loudly for reconciliation rather than
    // rolling back the whole thing.
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(deletedUser.id);
    if (authDeleteError && authDeleteError.status !== 404) {
      request.log.error(
        { status: authDeleteError.status, code: authDeleteError.code, subjectUserId: deletedUser.id },
        "DB account deleted but Supabase Auth deletion failed; auth identity remains",
      );
      return reply.code(200).send({
        deleted: true,
        user: deletedUser,
        warning: "auth_identity_not_deleted",
      });
    }

    return { deleted: true, user: deletedUser };
  } catch (error) {
    if (error instanceof Error && error.message === "last_active_admin") {
      return reply.code(409).send({ error: "cannot_remove_last_active_admin" });
    }
    request.log.error({ err: error, subjectUserId: request.params.id }, "Could not delete managed account");
    throw error;
  }
});

/* --- Visit routes (Slice 1) ---------------------------------------------- */

await registerVisitRoutes(app, { prisma, supabaseAdmin });
await registerGeocodeRoutes(app);

/* --- Whole-workspace state (still used by the untouched pages) ----------- */

app.get("/api/overview", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const branchId = request.branchId!;
  const [branch, saved, visitsByStatus, caseRecords, openBlockerCount] = await Promise.all([
    prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true } }),
    prisma.appState.findUnique({ where: { branchId } }),
    prisma.visit.groupBy({
      by: ["status"],
      where: { case: { branches: { some: { branchId } } } },
      _count: { _all: true },
    }),
    prisma.caseRecord.findMany({
      where: { branches: { some: { branchId } }, archivedAt: null },
      select: { id: true, name: true, project: true, location: true, verification: true, subsidy: true, readiness: true, nextAction: true, updated: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.blocker.count({
      where: { status: { not: "resolved" }, case: { branches: { some: { branchId } }, archivedAt: null } },
    }),
  ]);
  const state = saved?.data && typeof saved.data === "object" && !Array.isArray(saved.data)
    ? saved.data as Record<string, unknown>
    : {};
  const activeCases = caseRecords;
  const visitCounts = Object.fromEntries(visitsByStatus.map((row) => [row.status, row._count._all]));
  const projectCounts = new Map<string, { name: string; cases: number; location: string; verified: number; subsidyApproved: number; ready: number }>();
  for (const record of activeCases) {
    const name = typeof record.project === "string" && record.project ? record.project : "Unassigned project";
    const current = projectCounts.get(name) ?? {
      name, cases: 0, location: typeof record.location === "string" ? record.location : "",
      verified: 0, subsidyApproved: 0, ready: 0,
    };
    current.cases += 1;
    if (/verified/i.test(String(record.verification ?? ""))) current.verified += 1;
    if (/approved/i.test(String(record.subsidy ?? ""))) current.subsidyApproved += 1;
    if (/ready for works/i.test(String(record.readiness ?? ""))) current.ready += 1;
    projectCounts.set(name, current);
  }
  const projects = [...projectCounts.values()].sort((a, b) => b.cases - a.cases).slice(0, 3);
  const actions = activeCases
    .filter((record) =>
      (typeof record.nextAction === "string" && record.nextAction && record.nextAction !== "Confirm builder pack")
      || /blocked|exception/i.test(String(record.readiness ?? "")),
    )
    .slice(0, 5)
    .map((record) => ({
      id: String(record.id ?? ""),
      name: String(record.name ?? ""),
      nextAction: String(record.nextAction ?? "Review case"),
      readiness: String(record.readiness ?? ""),
      updated: String(record.updated ?? ""),
    }));
  const recentActivities = Array.isArray(state.activities) ? state.activities.slice(0, 5) : [];
  const syncState = state.sync && typeof state.sync === "object" && !Array.isArray(state.sync)
    ? state.sync as Record<string, unknown>
    : {};
  const activityRows = recentActivities.length > 0
    ? recentActivities
    : await prisma.activity.findMany({
        where: { case: { branches: { some: { branchId } } } },
        orderBy: { at: "desc" },
        take: 5,
      });

  return {
    branch,
    counts: {
      households: activeCases.length,
      inFlight: activeCases.filter((record) => !/ready for works/i.test(String(record.readiness ?? ""))).length,
      completedVisits: visitCounts.approved ?? 0,
      exceptions: openBlockerCount + activeCases.filter((record) => /blocked|exception/i.test(String(record.readiness ?? ""))).length,
      totalVisits: Object.values(visitCounts).reduce((sum, count) => sum + count, 0),
      verified: activeCases.filter((record) => /verified/i.test(String(record.verification ?? ""))).length,
      subsidyApproved: activeCases.filter((record) => /approved/i.test(String(record.subsidy ?? ""))).length,
      ready: activeCases.filter((record) => /ready for works/i.test(String(record.readiness ?? ""))).length,
      needsAttention: activeCases.filter((record) => /blocked|exception/i.test(String(record.readiness ?? ""))).length,
    },
    projects,
    actions,
    activities: activityRows.map((activity) => {
      if ("at" in activity && activity.at instanceof Date) {
        return { ...activity, at: activity.at.toISOString() };
      }
      return activity;
    }),
    sync: {
      pendingUploads: typeof syncState.pendingUploads === "number" ? syncState.pendingUploads : 0,
      lastSync: typeof syncState.lastSync === "string" ? syncState.lastSync : null,
    },
  };
});

app.get("/api/state", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const branchId = request.branchId!;
  const saved = await prisma.appState.findUnique({ where: { branchId } });
  if (!saved) return { state: null, version: 0 };
  await prisma.$transaction((transaction) =>
    syncWorkspaceEntities(transaction, saved.data as Record<string, unknown>, branchId),
  );
  return { state: saved.data, version: saved.version };
});

app.put("/api/state", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  const parsed = SaveStateBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_state", issues: parsed.error.issues });
  }

  const branchId = request.branchId!;
  const current = await prisma.appState.findUnique({ where: { branchId } });
  const isLocalDemoUser = request.authUser?.email.endsWith("@local.ayavelisa.test") ?? false;
  const role = isLocalDemoUser ? undefined : request.authUser?.role;
  const editableKeys = role ? editableStateKeys[role] : null;
  if (current && editableKeys) {
    const previousState = current.data as Record<string, unknown>;
    const changedKeys = new Set([...Object.keys(previousState), ...Object.keys(parsed.data.state)]);
    const forbiddenChanges = [...changedKeys].filter((key) =>
      !editableKeys.has(key) && !isDeepStrictEqual(previousState[key], parsed.data.state[key]),
    );
    if (forbiddenChanges.length > 0) {
      return reply.code(403).send({ error: "role_cannot_change_workspace_sections", sections: forbiddenChanges });
    }
  }
  if ((current && current.version !== parsed.data.version) || (!current && parsed.data.version !== 0)) {
    return reply.code(409).send({
      error: "state_conflict",
      version: current?.version ?? 0,
    });
  }

  if (!current) {
    try {
      const created = await prisma.$transaction(async (transaction) => {
        const saved = await transaction.appState.create({
          data: { id: branchId, branchId, data: parsed.data.state as Prisma.InputJsonValue, version: 1 },
        });
        await syncWorkspaceEntities(transaction, parsed.data.state, branchId);
        return saved;
      });
      return { version: created.version };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const latest = await prisma.appState.findUnique({ where: { branchId } });
        return reply.code(409).send({ error: "state_conflict", version: latest?.version ?? 0 });
      }
      throw error;
    }
  }

  const updatedVersion = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.appState.updateMany({
      where: { branchId, version: parsed.data.version },
      data: {
        data: parsed.data.state as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) return null;
    await syncWorkspaceEntities(transaction, parsed.data.state, branchId);
    return parsed.data.version + 1;
  });
  if (updatedVersion === null) {
    const latest = await prisma.appState.findUnique({ where: { branchId } });
    return reply.code(409).send({ error: "state_conflict", version: latest?.version ?? 0 });
  }
  return { version: updatedVersion };
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, {
    root: path.resolve("dist"),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type("text/html").sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => prisma.$disconnect());
  });
}
