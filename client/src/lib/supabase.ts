import { createClient } from "@supabase/supabase-js";
import { attachActiveBranch } from "./branches";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function attachDevelopmentPersona(headers: Headers) {
  if (!import.meta.env.DEV || supabase) return;
  const rawState = window.localStorage.getItem("ayavelisa:field:v2");
  let persona = "fieldworker";
  if (rawState) {
    try {
      const savedPersona = (JSON.parse(rawState) as { persona?: unknown }).persona;
      if (savedPersona === "fieldworker" || savedPersona === "supervisor" || savedPersona === "reviewer") {
        persona = savedPersona;
      }
    } catch {
      // Keep local demo requests on the least-privileged persona.
    }
  }
  headers.set("X-Dev-Persona", persona);
}

export async function authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  attachDevelopmentPersona(headers);
  attachActiveBranch(headers);
  if (supabase) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session) throw new Error("Your session has expired. Sign in again to continue.");
    headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  return fetch(input, { ...init, headers });
}
