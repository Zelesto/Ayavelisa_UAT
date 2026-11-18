/* =========================================================================
   lib/offlineQueue.ts
   IndexedDB-backed queue for two things only:
     1. Pending evidence uploads (blob + metadata) when the fieldworker is
        offline at capture time.
     2. Pending visit submissions (the form payload) when offline at submit.

   Every entry has a client-generated id that matches the server's
   idempotency key (VisitEvidence.id / VisitGrievance.id). Retries are safe.

   Everything else — case edits, intakes, blockers — is online-only and
   goes through apiFetch directly. Don't queue them here.
   ========================================================================= */

export type PendingEvidence = {
  kind: "evidence";
  evidenceId: string;       // client-generated, idempotency key
  visitId: string;
  file: Blob;               // compressed JPEG/PNG/PDF blob
  meta: {
    kind: "photo" | "signature" | "document";
    category?: string;
    label: string;
    capturedAt: string;
    provenance?: Record<string, unknown>;
  };
  queuedAt: string;
  attempts: number;
  lastError: string | null;
};

export type PendingVisitSubmit = {
  kind: "visit-submit";
  visitId: string;
  version: number;
  form: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  grievances: Array<Record<string, unknown>>;
  submittedAt: string;
  queuedAt: string;
  attempts: number;
  lastError: string | null;
};

export type QueueEntry = PendingEvidence | PendingVisitSubmit;

const DB_NAME = "ayavelisa-queue";
const DB_VERSION = 1;
const STORE = "entries";
const MAX_ATTEMPTS = 5;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("kind", "kind", { unique: false });
        store.createIndex("visitId", "visitId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open queue database"));
  });
  return dbPromise;
}

function entryKey(entry: QueueEntry): string {
  return entry.kind === "evidence"
    ? `evidence:${entry.evidenceId}`
    : `visit-submit:${entry.visitId}`;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Queue transaction failed"));
  });
}

/* --- Public API --------------------------------------------------------- */

export async function enqueue(entry: QueueEntry): Promise<void> {
  const key = entryKey(entry);
  const stored = { ...entry, key, queuedAt: entry.queuedAt ?? new Date().toISOString() };
  await tx("readwrite", (store) => store.put(stored));
}

export async function dequeue(entry: QueueEntry): Promise<void> {
  await tx("readwrite", (store) => store.delete(entryKey(entry)));
}

export async function listPending(): Promise<QueueEntry[]> {
  const all = await tx<QueueEntry[]>("readonly", (store) => store.getAll() as IDBRequest<QueueEntry[]>);
  // IndexedDB round-trips lose the `key` field — strip it so callers see clean objects.
  return all.map((e) => {
    const { key: _key, ...rest } = e as QueueEntry & { key?: string };
    return rest as QueueEntry;
  });
}

export async function listPendingForVisit(visitId: string): Promise<QueueEntry[]> {
  const all = await listPending();
  return all.filter((e) => e.visitId === visitId);
}

export async function countPending(): Promise<number> {
  return tx<number>("readonly", (store) => store.count());
}

/**
 * Update an entry after a failed attempt. Bumps attempts and stores the error.
 * Entries that exceed MAX_ATTEMPTS stay in the queue but are skipped by the
 * flusher until a manual retry — that's intentional: don't silently drop the
 * fieldworker's photo because the network flaked 5 times.
 */
export async function markAttemptFailed(entry: QueueEntry, error: string): Promise<void> {
  const updated: QueueEntry = { ...entry, attempts: entry.attempts + 1, lastError: error };
  await enqueue(updated);
}

export function isExhausted(entry: QueueEntry): boolean {
  return entry.attempts >= MAX_ATTEMPTS;
}

export function isExhaustedForUserRetry(entry: QueueEntry): boolean {
  return entry.attempts >= MAX_ATTEMPTS;
}

/**
 * Reset an exhausted entry to attempts=0 so the flusher will try again.
 * Called when the user taps "Retry" on a stuck item.
 */
export async function resetAttempts(entry: QueueEntry): Promise<void> {
  await enqueue({ ...entry, attempts: 0, lastError: null });
}

/** Clear everything. Used by tests and by "sign out" if you add it. */
export async function clearQueue(): Promise<void> {
  await tx("readwrite", (store) => store.clear());
}
