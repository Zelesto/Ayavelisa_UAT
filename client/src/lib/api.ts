/* =========================================================================
   lib/api.ts
   Single HTTP entry point. Every /api call in the client goes through here.
   - Attaches the Supabase bearer token
   - Refreshes the token if it's within 60s of expiry
   - Retries once on 401 after a refresh
   - Parses the server's structured error body into an ApiError
   - Surfaces requestId from the server (for UAT bug reports)
   ========================================================================= */

import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(code);
    this.name = "ApiError";
  }

  /** Human-readable fallback for toasts. Prefer a per-code map in the UI. */
  get message(): string {
    const map: Record<string, string> = {
      unauthorized: "Your session has expired. Sign in again.",
      account_not_invited: "This account has not been invited.",
      account_inactive: "This account is inactive.",
      admin_required: "Administrator access is required.",
      role_cannot_change_workspace_sections: "You do not have permission to edit that section.",
      state_conflict: "Someone else saved changes. Reload to get the latest version.",
      state_too_large: "This workspace is too large to sync. Contact your administrator.",
      invalid_state: "The data sent was invalid.",
      invalid_user: "The user details were invalid.",
      invalid_user_update: "The user update was invalid.",
      not_found: "Not found.",
      internal_error: "Something went wrong. Please try again.",
      visit_not_found: "Visit not found.",
      visit_not_editable: "This visit can no longer be edited.",
      evidence_too_large: "This file is too large (max 10MB).",
      evidence_type_unsupported: "Only JPEG, PNG, WebP or PDF files are accepted.",
      evidence_upload_failed: "Could not upload the evidence file.",
      grievance_not_found: "Grievance not found.",
      submission_incomplete: "The visit is missing required information.",
    };
    return map[this.code] ?? this.code.replace(/_/g, " ");
  }
}

type ApiFetchInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | null;
};

function isJsonBody(body: unknown): body is Record<string, unknown> {
  return (
    body !== null &&
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof ArrayBuffer)
  );
}

async function getAccessToken(forceRefresh = false): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getSession();
  if (error) throw new ApiError("session_error", 401, { message: error.message });

  let session = data.session;
  if (!session) throw new ApiError("unauthorized", 401);

  // Refresh if within 60s of expiry, or if the caller asked us to.
  const expiresAt = session.expires_at ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (forceRefresh || expiresAt - now < 60) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshed.session) {
      throw new ApiError("unauthorized", 401, { message: refreshError?.message });
    }
    session = refreshed.session;
  }
  return session.access_token;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let details: unknown;
  let requestId: string | undefined;
  try {
    const body = await response.json() as { error?: string; issues?: unknown; sections?: unknown; requestId?: string };
    if (body?.error) code = body.error;
    if (body?.issues) details = body.issues;
    else if (body?.sections) details = { sections: body.sections };
    requestId = body?.requestId;
  } catch {
    // Non-JSON error body. Fall through with the HTTP-derived code.
  }
  return new ApiError(code, response.status, details, requestId);
}

async function doFetch(path: string, init: ApiFetchInit, forceRefresh: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = await getAccessToken(forceRefresh);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let body: BodyInit | null | undefined = init.body as BodyInit | null | undefined;
  if (isJsonBody(init.body)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }

  return fetch(path, { ...init, headers, body });
}

export async function apiFetch<T = void>(path: string, init: ApiFetchInit = {}): Promise<T> {
  // Don't refresh on the first attempt unless the token is close to expiry —
  // getAccessToken handles the 60s window. The retry below handles a 401.
  let response = await doFetch(path, init, false);
  if (response.status === 401) {
    response = await doFetch(path, init, true);
  }
  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return await response.json() as T;
}

/* --- Convenience verbs --------------------------------------------------- */

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: Record<string, unknown> | FormData) =>
    apiFetch<T>(path, { method: "POST", body: body as BodyInit | Record<string, unknown> | undefined }),
  patch: <T>(path: string, body: Record<string, unknown>) =>
    apiFetch<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: Record<string, unknown>) =>
    apiFetch<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};

/** Upload evidence as multipart. Kept separate because FormData body is not JSON. */
export async function uploadEvidence<T>(path: string, formData: FormData): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: formData });
}

/** Absolute URL for an evidence image (server 302-redirects to a signed URL). */
export function evidenceUrl(visitId: string, evidenceId: string): string {
  return `/api/visits/${encodeURIComponent(visitId)}/evidence/${encodeURIComponent(evidenceId)}`;
}
