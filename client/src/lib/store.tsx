/* =========================================================================
   lib/store.ts
   Hybrid store: visits are backed by Postgres via /api/visits/*, everything
   else still goes through the whole-workspace /api/state blob. Slice 2 will
   migrate cases, Slice 3 intakes.
   ========================================================================= */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Activity, Blocker, CaseRecord, Evidence, Intake, Persona, SeedKind, StoreState, VerifyNowResult, Visit, VisitForm,
} from "./types";
import { api, ApiError, uploadEvidence } from "./api";
import {
  enqueue, dequeue, listPending, markAttemptFailed, isExhausted, resetAttempts, type QueueEntry,
} from "./offlineQueue";
import { seedFor } from "./seeders";
import { emptyIntake } from "./intake";
import { authorizedFetch } from "./supabase";
import { useAuth } from "@/components/AuthGate";
import { ROLE_LABELS, rolePersona, userInitials } from "./auth";
import { ACTIVE_BRANCH_STORAGE_KEY, type Branch } from "./branches";

const KEY = "ayavelisa:field:v2";
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const USERS: Record<Persona, { name: string; role: string; initials: string }> = {
  fieldworker: { name: "Lindiwe Ndlovu", role: "Fieldworker · Ndlovu Ext. 2", initials: "LN" },
  supervisor: { name: "Thandi Ndlovu", role: "Verification supervisor", initials: "TN" },
  reviewer: { name: "Sipho Mahlangu", role: "Project reviewer", initials: "SM" },
};

type Ctx = StoreState & {
  currentUser: { name: string; role: string; initials: string };
  isOnline: boolean; isSyncing: boolean;
  databaseStatus: "loading" | "connected" | "saving" | "error";
  databaseError: string | null;
  retryDatabase: () => Promise<void>;
  branches: Branch[];
  activeBranch: Branch | null;
  activeBranchId: string | null;
  branchesLoading: boolean;
  branchError: string | null;
  selectBranch: (branchId: string) => void;
  refreshBranches: (options?: { keepActive?: boolean }) => Promise<void>;
  setPersona: (p: Persona) => void;
  setSeed: (s: SeedKind) => void;
  resetDemo: () => void;
  createCase: (draft: Pick<CaseRecord, "name" | "household" | "project" | "location" | "source" | "members" | "site">) => CaseRecord;
  updateCaseRecord: (id: string, patch: Partial<CaseRecord>) => void;
  archiveCase: (id: string) => void;
  restoreCase: (id: string) => void;
  assignCases: (ids: string[], assignee: string) => void;
  runVerifyNowChecks: (ids: string[]) => VerifyNowResult[];
  markDepartmentPacketExported: (id: string) => void;

  /* Visit mutations — all async now. */
  startVisit: (id: string) => Promise<void>;
  saveVisitForm: (id: string, form: VisitForm) => Promise<void>;
  addEvidence: (id: string, ev: { evidenceId: string; file: Blob } & Omit<Evidence, "id">) => Promise<void>;
  removeEvidence: (id: string, evId: string) => Promise<void>;
  submitVisit: (id: string) => Promise<void>;
  returnVisit: (id: string, reason: string) => Promise<void>;
  approveVisit: (id: string) => Promise<void>;

  runSync: () => Promise<void>;
  requestBlocker: (c: string, b: string) => void;
  assignBlocker: (c: string, b: string) => void;
  resolveBlocker: (c: string, b: string) => void;
  createIntakeDraft: () => Intake;
  saveIntake: (i: Intake) => void;
  submitIntake: (id: string) => void;
  approveIntake: (id: string) => CaseRecord | null;
  returnIntake: (id: string, reason: string) => void;
  linkIntake: (id: string, caseId: string, reason: string) => void;
  discardIntake: (id: string) => void;

  /* New for Slice 1. */
  visitsFromApi: Visit[];
  visitsLoaded: boolean;
  visitsLoading: boolean;
  visitsError: ApiError | null;
  pendingQueueCount: number;
  refreshVisits: (opts?: { caseId?: string }) => Promise<void>;
  refreshPendingQueue: () => Promise<void>;
  retryStuckItem: (entry: QueueEntry) => Promise<void>;
};

const StoreContext = createContext<Ctx | null>(null);

const isDatabaseAvailable = (status: Ctx["databaseStatus"]) => status === "connected" || status === "saving";

function load(storageKey = KEY): StoreState {
  if (typeof window === "undefined") return seedFor("mid_day");
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return seedFor("mid_day");
    const p = JSON.parse(raw) as Partial<StoreState>;
    const base = seedFor(p.seedKind ?? "mid_day");
    return {
      cases: Array.isArray(p.cases) ? p.cases : base.cases,
      blockers: p.blockers ?? base.blockers,
      activities: Array.isArray(p.activities) ? p.activities : base.activities,
      sync: p.sync ?? base.sync,
      visits: Array.isArray(p.visits) ? p.visits : base.visits,
      persona: p.persona ?? base.persona,
      seedKind: p.seedKind ?? base.seedKind,
      auditLog: Array.isArray(p.auditLog) ? p.auditLog : [],
      importBatches: Array.isArray(p.importBatches) ? p.importBatches : [],
      submissionBatches: Array.isArray(p.submissionBatches) ? p.submissionBatches : [],
      enrolments: Array.isArray(p.enrolments) ? p.enrolments : [],
      workUnits: Array.isArray(p.workUnits) ? p.workUnits : [],
      claims: Array.isArray(p.claims) ? p.claims : [],
      changeRequests: Array.isArray(p.changeRequests) ? p.changeRequests : [],
      issuedReports: Array.isArray(p.issuedReports) ? p.issuedReports : [],
      conflicts: Array.isArray(p.conflicts) ? p.conflicts : [],
      handovers: Array.isArray(p.handovers) ? p.handovers : [],
      intakes: Array.isArray(p.intakes) ? p.intakes : [],
      leadImportBatches: Array.isArray(p.leadImportBatches) ? p.leadImportBatches : [],
      beneficiaryLeads: Array.isArray(p.beneficiaryLeads) ? p.beneficiaryLeads : [],
    };
  } catch { return seedFor("mid_day"); }
}

function nextIntakeId(all: Intake[], branchId: string): string {
  const year = new Date().getFullYear();
  const max = all.reduce((m, i) => { const n = Number(i.id.split("-")[2]); return Number.isFinite(n) && n > m ? n : m; }, 0);
  const suffix = branchId === "eastern-cape-delivery" ? "" : `-${branchId.slice(0, 6).toUpperCase()}`;
  return `INT-${year}-${String(max + 1).padStart(4, "0")}${suffix}`;
}

/** Convert an API Visit into the client Visit shape + version. */
function visitFromApi(raw: any): Visit & { version: number } {
  return {
    id: raw.id,
    caseId: raw.caseId,
    assignedTo: raw.assignedTo,
    scheduledFor: raw.scheduledFor,
    status: raw.status,
    form: raw.form,
    summary: raw.summary ?? null,
    evidence: (raw.evidence ?? []).map((e: any) => ({
      id: e.id,
      kind: e.kind,
      category: e.category,
      label: e.label,
      mimeType: e.mimeType,
      sizeBytes: e.sizeBytes,
      capturedAt: e.capturedAt,
      provenance: e.provenance,
      legibilityStatus: e.legibilityStatus,
      legibilityNote: e.legibilityNote,
    })),
    startedAt: raw.startedAt,
    submittedAt: raw.submittedAt,
    reviewedAt: raw.reviewedAt,
    returnedAt: raw.returnedAt,
    returnReason: raw.returnReason,
    reviewedBy: raw.reviewedBy,
    synced: raw.synced,
    version: raw.version,
  } as Visit & { version: number };
}

function upsertVisitLocal(list: Visit[], updated: Visit): Visit[] {
  const idx = list.findIndex((v) => v.id === updated.id);
  if (idx === -1) return [updated, ...list];
  const next = list.slice();
  next[idx] = updated;
  return next;
}

const versionOf = (v: Visit | undefined): number => (v as any)?.version ?? 1;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(load);
  const { user, protectedMode } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchIdState] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchError, setBranchError] = useState<string | null>(null);
  const persona = user ? rolePersona(user.role) : state.persona;
  const currentUser = user
    ? { name: user.name, role: ROLE_LABELS[user.role], initials: userInitials(user.name, user.email) }
    : USERS[state.persona];
  const activeBranch = branches.find((branch) => branch.id === activeBranchId) ?? null;

  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [databaseStatus, setDatabaseStatusState] = useState<"loading" | "connected" | "saving" | "error">("loading");
  const [databaseError, setDatabaseError] = useState<string | null>(null);

  const [visitsFromApi, setVisitsFromApi] = useState<Visit[]>([]);
  const [visitsLoaded, setVisitsLoaded] = useState(false);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [visitsError, setVisitsError] = useState<ApiError | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const flushInProgress = useRef(false);

  const databaseVersion = useRef(0);
  const activeBranchIdRef = useRef<string | null>(activeBranchId);
  activeBranchIdRef.current = activeBranchId;
  const databaseStatusRef = useRef(databaseStatus);
  const saveTimer = useRef<number | null>(null);
  const writeInProgress = useRef(false);
  const manualSyncInProgress = useRef(false);
  const pendingState = useRef<StoreState | null>(null);
  const lastSavedState = useRef<StoreState | null>(null);
  const refreshVisitsAfterStateSave = useRef<() => Promise<void>>(async () => undefined);

  const setDatabaseStatus = useCallback((status: "loading" | "connected" | "saving" | "error", error: string | null = null) => {
    databaseStatusRef.current = status;
    setDatabaseStatusState(status);
    setDatabaseError(error);
  }, []);

  const refreshBranches = useCallback(async (options?: { keepActive?: boolean }) => {
    setBranchesLoading(true);
    setBranchError(null);
    const previousBranchId = options?.keepActive ? activeBranchIdRef.current : null;
    try {
      const response = await authorizedFetch("/api/branches/mine");
      const result = await response.json() as { branches?: Branch[]; error?: string };
      if (!response.ok || !result.branches?.length) {
        throw new Error(result.error ?? "No active branches are assigned to your account. Ask an administrator to assign a branch.");
      }
      setBranches(result.branches);
      if (result.branches.length === 1) {
        const onlyBranch = result.branches[0];
        setActiveBranchIdState(onlyBranch.id);
        window.localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, onlyBranch.id);
      } else if (previousBranchId && result.branches.some((branch) => branch.id === previousBranchId)) {
        setActiveBranchIdState(previousBranchId);
        window.localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, previousBranchId);
      } else {
        setActiveBranchIdState(null);
        window.localStorage.removeItem(ACTIVE_BRANCH_STORAGE_KEY);
      }
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : "Could not load your branches.");
      setDatabaseStatus("error", error instanceof Error ? error.message : "Could not load your branches.");
    } finally {
      setBranchesLoading(false);
    }
  }, [setDatabaseStatus]);

  const selectBranch = useCallback((branchId: string) => {
    if (!branches.some((branch) => branch.id === branchId) || branchId === activeBranchId) return;
    setActiveBranchIdState(branchId);
    window.localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, branchId);
    databaseVersion.current = 0;
    pendingState.current = null;
    lastSavedState.current = null;
    setDatabaseStatus("loading");
  }, [activeBranchId, branches, setDatabaseStatus]);

  useEffect(() => { void refreshBranches(); }, [refreshBranches]);

  /* --- /api/state blob ---------------------------------------------------- */

  useEffect(() => {
    if (branchesLoading || !activeBranchId) return;
    const controller = new AbortController();
    const initialize = async () => {
      setDatabaseStatus("loading");
      try {
        const response = await authorizedFetch("/api/state", { signal: controller.signal });
        if (!response.ok) throw new Error(`Database connection failed (${response.status})`);
        const result = await response.json() as { state: StoreState | null; version: number };
        databaseVersion.current = result.version;
        if (result.state) {
          lastSavedState.current = result.state;
          setState(result.state);
        } else {
          lastSavedState.current = null;
          const cacheKey = `${KEY}:${activeBranchId}`;
          const cachedState = window.localStorage.getItem(cacheKey);
          setState(cachedState
            ? load(cacheKey)
            : seedFor(protectedMode ? "empty" : "mid_day"));
        }
        setDatabaseStatus("connected");
      } catch (error) {
        if (controller.signal.aborted) return;
        setDatabaseStatus("error", error instanceof Error ? error.message : "Could not connect to the database");
      }
    };
    void initialize();
    return () => controller.abort();
  }, [activeBranchId, branchesLoading, protectedMode, setDatabaseStatus]);

  useEffect(() => {
    const up = () => setIsOnline(true); const down = () => setIsOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  useEffect(() => {
    const storageKey = activeBranchId ? `${KEY}:${activeBranchId}` : KEY;
    try { window.localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { console.warn("localStorage quota exceeded"); }
  }, [activeBranchId, state]);

  useEffect(() => {
    if (!activeBranchId || (databaseStatus !== "connected" && databaseStatus !== "saving") || state === lastSavedState.current) return;
    pendingState.current = state;
    if (databaseStatus === "connected") {
      setDatabaseStatus("saving");
      return;
    }
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);

    const flush = async () => {
      if (writeInProgress.current || manualSyncInProgress.current || !isDatabaseAvailable(databaseStatusRef.current)) return;
      writeInProgress.current = true;
      try {
        while (pendingState.current && isDatabaseAvailable(databaseStatusRef.current)) {
          const snapshot = pendingState.current;
          pendingState.current = null;
          const response = await authorizedFetch("/api/state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: snapshot, version: databaseVersion.current }),
          });
          if (response.status === 409) {
            throw new Error("Shared data changed elsewhere. Reload the page to load the latest database state.");
          }
          if (!response.ok) throw new Error(`Could not save to the database (${response.status})`);
          const result = await response.json() as { version: number };
          databaseVersion.current = result.version;
          const previousState = lastSavedState.current;
          lastSavedState.current = snapshot;
          if (snapshot.visits.some((visit) => !previousState?.visits.some((savedVisit) => savedVisit.id === visit.id))) {
            void refreshVisitsAfterStateSave.current();
          }
        }
        if (databaseStatusRef.current === "saving") setDatabaseStatus("connected");
      } catch (error) {
        pendingState.current = pendingState.current ?? state;
        setDatabaseStatus("error", error instanceof Error ? error.message : "Could not save to the database");
      } finally {
        writeInProgress.current = false;
        if (pendingState.current && !manualSyncInProgress.current && isDatabaseAvailable(databaseStatusRef.current)) {
          saveTimer.current = window.setTimeout(() => void flush(), 0);
        }
      }
    };

    saveTimer.current = window.setTimeout(() => void flush(), 500);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [activeBranchId, state, databaseStatus, setDatabaseStatus]);

  const retryDatabase = useCallback(async () => {
    if (!activeBranchId) {
      await refreshBranches();
      return;
    }
    setDatabaseStatus("loading");
    try {
      const response = await authorizedFetch("/api/state");
      if (!response.ok) throw new Error(`Database connection failed (${response.status})`);
      const result = await response.json() as { state: StoreState | null; version: number };
      if (result.version !== databaseVersion.current) {
        throw new Error("The database has newer shared data. Reload the page to load it before saving again.");
      }
      setDatabaseStatus("connected");
    } catch (error) {
      setDatabaseStatus("error", error instanceof Error ? error.message : "Could not reconnect to the database");
    }
  }, [activeBranchId, refreshBranches, setDatabaseStatus]);

  const act = (kind: Activity["kind"], tone: Activity["tone"], title: string, detail: string): Activity => ({
    id: uid(), kind, tone, title, detail, time: "Just now", at: new Date().toISOString(),
  });

  /* --- Persona / seed ---------------------------------------------------- */

  const setPersona = useCallback((nextPersona: Persona) => {
    if (!user) setState((s) => ({ ...s, persona: nextPersona }));
  }, [user]);
  const setSeed = useCallback((seedKind: SeedKind) => setState(() => seedFor(seedKind)), []);
  const resetDemo = useCallback(() => setState((s) => seedFor(s.seedKind)), []);

  /* --- Case CRUD (still on the blob) ------------------------------------- */

  const createCase = useCallback((draft: Pick<CaseRecord, "name" | "household" | "project" | "location" | "source" | "members" | "site">) => {
    const year = new Date().getFullYear();
    const max = state.cases.reduce((highest, item) => {
      const [prefix, itemYear, sequence] = item.id.split("-");
      const number = prefix === "AY" && Number(itemYear) === year ? Number(sequence) : 0;
      return Number.isFinite(number) ? Math.max(highest, number) : highest;
    }, 0);
    const created: CaseRecord = {
      ...draft,
      id: `AY-${year}-${String(max + 1).padStart(4, "0")}${activeBranchId && activeBranchId !== "eastern-cape-delivery" ? `-${activeBranchId.slice(0, 6).toUpperCase()}` : ""}`,
      verification: "Awaiting review",
      verificationTone: "warning",
      subsidy: "Not started",
      subsidyTone: "neutral",
      readiness: "Not started",
      nextAction: "Complete field verification",
      updated: "Just now",
    };
    setState((s) => ({
      ...s,
      cases: [created, ...s.cases],
      activities: [act("action", "blue", "Case created", created.id), ...s.activities].slice(0, 40),
      auditLog: [{
        id: uid(), at: new Date().toISOString(), actor: currentUser.name, persona,
        action: "create", entity: "case", entityId: created.id, before: null, after: created, reason: null,
      }, ...s.auditLog],
    }));
    return created;
  }, [state.cases, currentUser.name, persona, activeBranchId]);

  const updateCaseRecord = useCallback((id: string, patch: Partial<CaseRecord>) => setState((s) => {
    const before = s.cases.find((item) => item.id === id);
    if (!before) throw new Error(`Case ${id} was not found`);
    const after = { ...before, ...patch, id, updated: "Just now" };
    return {
      ...s,
      cases: s.cases.map((item) => item.id === id ? after : item),
      activities: [act("action", "sand", "Case updated", id), ...s.activities].slice(0, 40),
      auditLog: [{
        id: uid(), at: new Date().toISOString(), actor: currentUser.name, persona,
        action: "update", entity: "case", entityId: id, before, after, reason: null,
      }, ...s.auditLog],
    };
  }), [currentUser.name, persona]);

  const archiveCase = useCallback((id: string) => setState((s) => {
    const before = s.cases.find((item) => item.id === id);
    if (!before) throw new Error(`Case ${id} was not found`);
    const after = { ...before, archivedAt: new Date().toISOString(), updated: "Just now" };
    return {
      ...s,
      cases: s.cases.map((item) => item.id === id ? after : item),
      activities: [act("action", "coral", "Case archived", id), ...s.activities].slice(0, 40),
      auditLog: [{
        id: uid(), at: new Date().toISOString(), actor: currentUser.name, persona,
        action: "archive", entity: "case", entityId: id, before, after, reason: null,
      }, ...s.auditLog],
    };
  }), [currentUser.name, persona]);

  const restoreCase = useCallback((id: string) => setState((s) => {
    const before = s.cases.find((item) => item.id === id);
    if (!before) throw new Error(`Case ${id} was not found`);
    const after = { ...before, archivedAt: null, updated: "Just now" };
    return {
      ...s,
      cases: s.cases.map((item) => item.id === id ? after : item),
      activities: [act("action", "sage", "Case restored", id), ...s.activities].slice(0, 40),
      auditLog: [{
        id: uid(), at: new Date().toISOString(), actor: currentUser.name, persona,
        action: "restore", entity: "case", entityId: id, before, after, reason: null,
      }, ...s.auditLog],
    };
  }), [currentUser.name, persona]);

  const assignCases = useCallback((ids: string[], assignee: string) => setState((s) => ({
    ...s,
    cases: s.cases.map((item) => ids.includes(item.id) && !item.archivedAt ? { ...item, assignedTo: assignee, updated: "Just now" } : item),
    activities: [act("action", "blue", "Cases assigned", `${ids.length} case(s) · ${assignee}`), ...s.activities].slice(0, 40),
  })), []);

  const runVerifyNowChecks = useCallback((ids: string[]) => {
    const selected = new Set(ids);
    const matchingCases = state.cases.filter((item) => selected.has(item.id));
    const now = new Date().toISOString();
    const checks: VerifyNowResult[] = matchingCases.map(() => ({
      id: uid(),
      provider: "VerifyNow",
      status: "not_configured",
      outcome: "not_run",
      reference: "",
      summary: "VerifyNow API is not configured. No external identity check was performed.",
      checkedAt: now,
      checkedBy: currentUser.name,
      simulated: false,
    }));
    const checkByCase = new Map(matchingCases.map((item, index) => [item.id, checks[index]]));
    setState((s) => ({
      ...s,
      cases: s.cases.map((item) => {
        const check = checkByCase.get(item.id);
        return check ? { ...item, verifyNowChecks: [...(item.verifyNowChecks ?? []), check], updated: "Just now" } : item;
      }),
      activities: [act("verify", "sand", "VerifyNow requested", `${checks.length} case(s) · integration not configured`), ...s.activities].slice(0, 40),
    }));
    return checks;
  }, [state.cases, currentUser.name]);

  const markDepartmentPacketExported = useCallback((id: string) => {
    updateCaseRecord(id, { departmentPacketExportedAt: new Date().toISOString() });
  }, [updateCaseRecord]);

  /* --- Visits: load ------------------------------------------------------ */

  const refreshVisits = useCallback(async (opts?: { caseId?: string }) => {
    setVisitsLoading(true);
    setVisitsError(null);
    try {
      const query = opts?.caseId ? `?caseId=${encodeURIComponent(opts.caseId)}` : "";
      const result = await api.get<{ visits: any[] }>(`/api/visits${query}${query ? "&" : "?"}limit=200`);
      setVisitsFromApi(result.visits.map((v) => visitFromApi(v)));
      setVisitsLoaded(true);
    } catch (e) {
      setVisitsError(e instanceof ApiError ? e : new ApiError("network_error", 0));
    } finally {
      setVisitsLoading(false);
    }
  }, []);
  refreshVisitsAfterStateSave.current = refreshVisits;

  const refreshPendingQueue = useCallback(async () => {
    const pending = await listPending();
    setPendingQueueCount(pending.length);
  }, []);

  useEffect(() => {
    if (databaseStatus !== "connected" && databaseStatus !== "saving") return;
    void refreshVisits();
    void refreshPendingQueue();
  }, [databaseStatus, refreshVisits, refreshPendingQueue]);

  /* --- Visits: mutations ------------------------------------------------- */

  const startVisit = useCallback(async (id: string) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);
    const startedAt = current.startedAt ?? new Date().toISOString();
    const result = await api.patch<any>(`/api/visits/${id}`, {
      version: versionOf(current),
      status: "in_progress",
      startedAt,
    });
    setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
  }, [visitsFromApi]);

  const saveVisitForm = useCallback(async (id: string, form: VisitForm) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);
    const result = await api.patch<any>(`/api/visits/${id}`, {
      version: versionOf(current),
      form: form as unknown as Record<string, unknown>,
    });
    setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
  }, [visitsFromApi]);

  const addEvidence = useCallback(async (
    id: string,
    ev: { evidenceId: string; file: Blob } & Omit<Evidence, "id">,
  ) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);

    // Optimistic placeholder so the UI shows progress.
    const placeholder: Evidence = {
      id: ev.evidenceId,
      kind: ev.kind,
      category: ev.category,
      label: ev.label,
      mimeType: ev.mimeType,
      sizeBytes: ev.sizeBytes,
      capturedAt: ev.capturedAt,
      provenance: ev.provenance,
      legibilityStatus: ev.legibilityStatus,
      legibilityNote: ev.legibilityNote,
    };
    setVisitsFromApi((list) =>
      list.map((v) => v.id === id ? { ...v, evidence: [...v.evidence, placeholder] } : v),
    );

    const queueEntry = {
      kind: "evidence" as const,
      evidenceId: ev.evidenceId,
      visitId: id,
      file: ev.file,
      meta: {
        kind: ev.kind,
        category: ev.category,
        label: ev.label,
        capturedAt: ev.capturedAt,
        provenance: ev.provenance as Record<string, unknown> | undefined,
      },
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    };

    if (!isOnline) {
      await enqueue(queueEntry);
      await refreshPendingQueue();
      return;
    }

    try {
      const fd = new FormData();
      fd.append("file", ev.file, `${ev.evidenceId}.jpg`);
      fd.append("id", ev.evidenceId);
      fd.append("kind", ev.kind);
      if (ev.category) fd.append("category", ev.category);
      fd.append("label", ev.label);
      fd.append("capturedAt", ev.capturedAt);
      if (ev.provenance) fd.append("provenance", JSON.stringify(ev.provenance));

      const result = await uploadEvidence<{ evidence: any }>(`/api/visits/${id}/evidence`, fd);
      setVisitsFromApi((list) =>
        list.map((v) => {
          if (v.id !== id) return v;
          const others = v.evidence.filter((e) => e.id !== ev.evidenceId);
          return { ...v, evidence: [...others, result.evidence] };
        }),
      );
    } catch (e) {
      // Network/5xx → queue it and keep the placeholder.
      if (e instanceof ApiError && e.status >= 500) {
        await enqueue(queueEntry);
        await refreshPendingQueue();
        return;
      }
      // Anything else (413, 415, 409, 403) → roll back the placeholder.
      setVisitsFromApi((list) =>
        list.map((v) => v.id === id ? { ...v, evidence: v.evidence.filter((e) => e.id !== ev.evidenceId) } : v),
      );
      throw e;
    }
  }, [visitsFromApi, isOnline, refreshPendingQueue]);

  const removeEvidence = useCallback(async (id: string, evId: string) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);

    setVisitsFromApi((list) =>
      list.map((v) => v.id === id ? { ...v, evidence: v.evidence.filter((e) => e.id !== evId) } : v),
    );

    try {
      await api.delete(`/api/visits/${id}/evidence/${evId}`);
    } catch (e) {
      setVisitsFromApi((list) => upsertVisitLocal(list, current));
      throw e;
    }
  }, [visitsFromApi]);

  const submitVisit = useCallback(async (id: string) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);
    const form = current.form;
    if (!form) throw new ApiError("submission_incomplete", 400, { reason: "form missing" });

    const grievances = (form.grievances ?? []).map((g) => ({
      id: g.id,
      raisedAt: g.raisedAt,
      raisedBy: g.raisedBy,
      description: g.description,
      category: g.category,
      categoryOther: g.categoryOther,
      status: g.status,
      resolutionOwner: g.resolutionOwner,
      dueDate: g.dueDate,
      resolution: g.resolution,
      resolvedAt: g.resolvedAt,
    }));

    const submittedAt = new Date().toISOString();
    const payload = {
      version: versionOf(current),
      form: form as unknown as Record<string, unknown>,
      summary: (current.summary ?? null) as Record<string, unknown> | null,
      grievances,
      submittedAt,
    };

    const queueEntry = {
      kind: "visit-submit" as const,
      visitId: id,
      ...payload,
      queuedAt: submittedAt,
      attempts: 0,
      lastError: null,
    };

    if (!isOnline) {
      await enqueue(queueEntry);
      setVisitsFromApi((list) =>
        list.map((v) => v.id === id ? { ...v, status: "captured", submittedAt, synced: false } : v),
      );
      await refreshPendingQueue();
      return;
    }

    try {
      const result = await api.post<any>(`/api/visits/${id}/submit`, payload);
      setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
    } catch (e) {
      if (e instanceof ApiError && e.status >= 500) {
        await enqueue(queueEntry);
        setVisitsFromApi((list) =>
          list.map((v) => v.id === id ? { ...v, status: "captured", submittedAt, synced: false } : v),
        );
        await refreshPendingQueue();
        return;
      }
      throw e;
    }
  }, [visitsFromApi, isOnline, refreshPendingQueue]);

  const updateCaseAfterVisitReview = useCallback((visit: Visit, status: "returned" | "approved", reason?: string) => {
    const approved = status === "approved";
    setState((s) => {
      if (!s.cases.some((item) => item.id === visit.caseId)) return s;
      const updatedCase: Partial<CaseRecord> = approved
        ? {
            verification: "Field review approved",
            verificationTone: "success",
            readiness: "Ready for department",
            nextAction: "Prepare department handoff packet",
          }
        : {
            verification: "Returned for correction",
            verificationTone: "warning",
            readiness: "Review returned",
            nextAction: "Correct visit and resubmit",
          };
      return {
        ...s,
        cases: s.cases.map((item) =>
          item.id === visit.caseId ? { ...item, ...updatedCase, updated: "Just now" } : item,
        ),
        activities: [
          act(
            "visit",
            approved ? "sage" : "coral",
            approved ? "Visit approved" : "Visit returned",
            approved ? visit.id : `${visit.id} · ${(reason ?? "").slice(0, 60)}`,
          ),
          ...s.activities,
        ].slice(0, 40),
      };
    });
  }, []);

  const returnVisit = useCallback(async (id: string, reason: string) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);
    const result = await api.post<any>(`/api/visits/${id}/return`, { version: versionOf(current), reason });
    setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
    updateCaseAfterVisitReview(current, "returned", reason);
  }, [visitsFromApi, updateCaseAfterVisitReview]);

  const approveVisit = useCallback(async (id: string) => {
    const current = visitsFromApi.find((v) => v.id === id);
    if (!current) throw new ApiError("visit_not_found", 404);
    const result = await api.post<any>(`/api/visits/${id}/approve`, { version: versionOf(current) });
    setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
    updateCaseAfterVisitReview(current, "approved");
  }, [visitsFromApi, updateCaseAfterVisitReview]);

  /* --- Offline flusher --------------------------------------------------- */

  const flushQueue = useCallback(async () => {
    if (flushInProgress.current || !isOnline) return;
    flushInProgress.current = true;
    try {
      const pending = await listPending();
      for (const entry of pending) {
        if (isExhausted(entry)) continue;
        try {
          if (entry.kind === "evidence") {
            const fd = new FormData();
            fd.append("file", entry.file, `${entry.evidenceId}.jpg`);
            fd.append("id", entry.evidenceId);
            fd.append("kind", entry.meta.kind);
            if (entry.meta.category) fd.append("category", entry.meta.category);
            fd.append("label", entry.meta.label);
            fd.append("capturedAt", entry.meta.capturedAt);
            if (entry.meta.provenance) fd.append("provenance", JSON.stringify(entry.meta.provenance));

            const result = await uploadEvidence<{ evidence: any }>(`/api/visits/${entry.visitId}/evidence`, fd);
            setVisitsFromApi((list) =>
              list.map((v) => {
                if (v.id !== entry.visitId) return v;
                const others = v.evidence.filter((e) => e.id !== entry.evidenceId);
                return { ...v, evidence: [...others, result.evidence] };
              }),
            );
            await dequeue(entry);
          } else {
            const result = await api.post<any>(`/api/visits/${entry.visitId}/submit`, {
              version: entry.version,
              form: entry.form,
              summary: entry.summary,
              grievances: entry.grievances,
              submittedAt: entry.submittedAt,
            });
            setVisitsFromApi((list) => upsertVisitLocal(list, visitFromApi(result.visit)));
            await dequeue(entry);
          }
        } catch (e) {
          const msg = e instanceof ApiError ? e.code : (e instanceof Error ? e.message : "unknown");
          await markAttemptFailed(entry, msg);
          // 401: session gone, stop the whole flush.
          if (e instanceof ApiError && e.status === 401) break;
          // 409: version moved — drop this submit and refresh so the user re-submits.
          if (e instanceof ApiError && e.status === 409) {
            await dequeue(entry);
            await refreshVisits();
          }
        }
      }
      await refreshPendingQueue();
    } finally {
      flushInProgress.current = false;
    }
  }, [isOnline, refreshPendingQueue, refreshVisits]);

  useEffect(() => {
    if (!isOnline) return;
    void flushQueue();
  }, [isOnline, flushQueue]);

  const retryStuckItem = useCallback(async (entry: QueueEntry) => {
    await resetAttempts(entry);
    if (isOnline) await flushQueue();
  }, [isOnline, flushQueue]);

  /* --- runSync (still the blob, but now nudges the visit queue too) ------ */

  const runSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      if (databaseStatusRef.current === "error" || databaseStatusRef.current === "loading") {
        throw new Error(databaseError ?? "Database is not connected");
      }
      manualSyncInProgress.current = true;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      while (writeInProgress.current) await new Promise((resolve) => window.setTimeout(resolve, 25));
      pendingState.current = null;
      const nextState: StoreState = {
        ...state,
        visits: state.visits.map((visit) => ({
          ...visit,
          synced: visit.status === "captured" ? true : visit.synced,
        })),
        sync: {
          pendingUploads: 0,
          lastSync: new Date().toISOString(),
          runs: state.sync.runs + 1,
        },
        activities: [act("sync", "sage", "Sync complete", "All captured visits saved to the shared database"), ...state.activities].slice(0, 40),
      };
      writeInProgress.current = true;
      const response = await authorizedFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: nextState, version: databaseVersion.current }),
      });
      if (response.status === 409) {
        throw new Error("Shared data changed elsewhere. Reload the page to load the latest database state.");
      }
      if (!response.ok) throw new Error(`Could not save to the database (${response.status})`);
      const result = await response.json() as { version: number };
      databaseVersion.current = result.version;
      lastSavedState.current = nextState;
      setState(nextState);

      // Flush any pending visit evidence/submits too.
      await flushQueue();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Database sync failed";
      setDatabaseStatus("error", message);
      throw error;
    } finally {
      manualSyncInProgress.current = false;
      writeInProgress.current = false;
      setIsSyncing(false);
    }
  }, [state, databaseError, setDatabaseStatus, flushQueue]);

  /* --- Blockers (still blob) --------------------------------------------- */

  const setBlocker = useCallback((caseId: string, blockerId: string, status: Blocker["status"], verb: string) => {
    setState((s) => {
      const list = s.blockers[caseId] ?? [];
      if (!list.find((b) => b.id === blockerId)) return s;
      const updated = list.map((b) => b.id === blockerId ? { ...b, status } : b);
      const open = updated.filter((b) => b.status !== "resolved");
      const cases = s.cases.map((c) => c.id === caseId ? { ...c, readiness: open.length === 0 ? "Ready for works" : `Blocked · ${open.length} gate${open.length > 1 ? "s" : ""}`, nextAction: open.length === 0 ? "Confirm builder pack" : open[0].action, updated: "Just now" } : c);
      return { ...s, blockers: { ...s.blockers, [caseId]: updated }, cases, activities: [act("gate", status === "resolved" ? "sage" : "sand", verb, caseId), ...s.activities].slice(0, 40) };
    });
  }, []);
  const requestBlocker = useCallback((c: string, b: string) => setBlocker(c, b, "requested", "Gate requested"), [setBlocker]);
  const assignBlocker = useCallback((c: string, b: string) => setBlocker(c, b, "assigned", "Gate assigned"), [setBlocker]);
  const resolveBlocker = useCallback((c: string, b: string) => setBlocker(c, b, "resolved", "Gate resolved"), [setBlocker]);

  /* --- Intakes (still blob, Slice 3 migrates) ---------------------------- */

  const createIntakeDraft = useCallback((): Intake => {
    let created: Intake | null = null;
    setState((s) => {
      const id = nextIntakeId(s.intakes, activeBranchId ?? "eastern-cape-delivery");
      created = emptyIntake(id, currentUser.name);
      return { ...s, intakes: [created, ...s.intakes], activities: [act("intake", "sand", "Intake draft started", id), ...s.activities].slice(0, 40) };
    });
    if (!created) created = emptyIntake(nextIntakeId(state.intakes, activeBranchId ?? "eastern-cape-delivery"), currentUser.name);
    return created;
  }, [state.intakes, currentUser.name, activeBranchId]);

  const saveIntake = useCallback((i: Intake) => setState((s) => ({ ...s, intakes: s.intakes.map((x) => x.id === i.id ? i : x) })), []);

  const submitIntake = useCallback((id: string) => setState((s) => ({ ...s, intakes: s.intakes.map((i) => i.id === id ? { ...i, status: "submitted" as const, submittedAt: new Date().toISOString() } : i), activities: [act("intake", "blue", "Intake submitted for review", id), ...s.activities].slice(0, 40) })), []);

  const returnIntake = useCallback((id: string, reason: string) => setState((s) => ({ ...s, intakes: s.intakes.map((i) => i.id === id ? { ...i, status: "returned" as const, returnedAt: new Date().toISOString(), returnReason: reason, reviewedAt: new Date().toISOString(), reviewedBy: currentUser.name } : i), activities: [act("intake", "coral", "Intake returned", `${id} · ${reason.slice(0, 40)}`), ...s.activities].slice(0, 40) })), [currentUser.name]);

  const approveIntake = useCallback((id: string): CaseRecord | null => {
    let newCase: CaseRecord | null = null;
    setState((s) => {
      const intake = s.intakes.find((i) => i.id === id);
      if (!intake) return s;
      const year = new Date().getFullYear();
      const maxCase = s.cases.reduce((m, c) => { const n = Number(c.id.split("-")[2]); return Number.isFinite(n) && n > m ? n : m; }, 121);
      const suffix = activeBranchId && activeBranchId !== "eastern-cape-delivery" ? `-${activeBranchId.slice(0, 6).toUpperCase()}` : "";
      const caseId = `AY-${year}-${String(maxCase + 1).padStart(4, "0")}${suffix}`;
      const surname = intake.applicantSurname.trim();
      const locality = [intake.location.village, intake.location.ward].filter(Boolean).join(" · ");
      const sources = intake.programmes.map((p) => ({ listName: p.listName, reference: p.reference, importedAt: new Date().toISOString() }));
      newCase = {
        id: caseId,
        name: `${intake.applicantFirstName} ${intake.applicantSurname}`.trim(),
        household: `${surname} household`,
        project: "Ndlovu Extension Phase 2",
        location: locality || intake.location.municipality,
        source: intake.programmes[0]?.listName ?? "Field intake",
        verification: "Awaiting verification visit",
        verificationTone: "warning",
        subsidy: "Not started", subsidyTone: "neutral",
        readiness: "Not started",
        nextAction: "Complete field verification visit",
        updated: "Just now",
        members: intake.householdMembers.filter((m) => m.fullName.trim()).length || 1,
        site: "Unallocated",
        sources,
        intakeId: intake.id,
      };
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
      const maxVisit = s.visits.reduce((m, v) => { const n = Number(v.id.split("-")[2]); return Number.isFinite(n) && n > m ? n : m; }, 1000);
      const visit: Visit = {
        id: `V-${year}-${String(maxVisit + 1).padStart(4, "0")}${suffix}`,
        caseId, assignedTo: intake.capturedBy,
        scheduledFor: tomorrow.toISOString(),
        status: "assigned", form: null, evidence: [],
        startedAt: null, submittedAt: null, reviewedAt: null, returnedAt: null,
        returnReason: null, reviewedBy: null, synced: false,
      };
      return {
        ...s,
        cases: [newCase, ...s.cases],
        visits: [visit, ...s.visits],
        intakes: s.intakes.map((i) => i.id === id ? { ...i, status: "approved" as const, reviewedAt: new Date().toISOString(), reviewedBy: currentUser.name, createdCaseId: caseId } : i),
        activities: [act("intake", "sage", "Intake approved", `${id} → ${caseId}`), act("visit", "blue", "Verification visit scheduled", visit.id), ...s.activities].slice(0, 40),
      };
    });
    return newCase;
  }, [currentUser.name, activeBranchId]);

  const linkIntake = useCallback((id: string, caseId: string, reason: string) => setState((s) => ({ ...s, intakes: s.intakes.map((i) => i.id === id ? { ...i, status: "linked_to_existing" as const, linkedToCaseId: caseId, reviewedAt: new Date().toISOString(), reviewedBy: currentUser.name, duplicateResolution: "linked" as const, duplicateResolutionReason: reason } : i), activities: [act("intake", "sage", "Intake linked to existing case", `${id} → ${caseId}`), ...s.activities].slice(0, 40) })), [currentUser.name]);

  const discardIntake = useCallback((id: string) => setState((s) => ({ ...s, intakes: s.intakes.filter((i) => i.id !== id) })), []);

  /* --- Context value ----------------------------------------------------- */

  const value = useMemo<Ctx>(() => ({
    ...state, visits: visitsLoaded ? visitsFromApi : state.visits, persona, currentUser, isOnline, isSyncing,
    databaseStatus, databaseError, retryDatabase,
    branches, activeBranch, activeBranchId, branchesLoading, branchError, selectBranch, refreshBranches,
    setPersona, setSeed, resetDemo,
    startVisit, saveVisitForm, addEvidence, removeEvidence, submitVisit, returnVisit, approveVisit, runSync,
    createCase, updateCaseRecord, archiveCase, restoreCase, assignCases, runVerifyNowChecks, markDepartmentPacketExported,
    requestBlocker, assignBlocker, resolveBlocker,
    createIntakeDraft, saveIntake, submitIntake, approveIntake, returnIntake, linkIntake, discardIntake,
    visitsFromApi, visitsLoaded, visitsLoading, visitsError,
    pendingQueueCount, refreshVisits, refreshPendingQueue, retryStuckItem,
  }), [
    state, visitsFromApi, visitsLoaded, persona, currentUser, isOnline, isSyncing, databaseStatus, databaseError, retryDatabase,
    branches, activeBranch, activeBranchId, branchesLoading, branchError, selectBranch, refreshBranches,
    setPersona, setSeed, resetDemo,
    startVisit, saveVisitForm, addEvidence, removeEvidence, submitVisit, returnVisit, approveVisit, runSync,
    createCase, updateCaseRecord, archiveCase, restoreCase, assignCases, runVerifyNowChecks, markDepartmentPacketExported,
    requestBlocker, assignBlocker, resolveBlocker,
    createIntakeDraft, saveIntake, submitIntake, approveIntake, returnIntake, linkIntake, discardIntake,
    visitsFromApi, visitsLoaded, visitsLoading, visitsError,
    pendingQueueCount, refreshVisits, refreshPendingQueue, retryStuckItem,
  ]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
