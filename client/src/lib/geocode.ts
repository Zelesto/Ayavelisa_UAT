/* =========================================================================
   lib/geocode.ts
   Client helper that calls /api/geocode/reverse. Offline-safe: when the
   network is down, it returns null and the caller should keep the raw GPS
   reading, marking the address "pending". The queued visit submit carries
   the lat/lng and the server can enrich it later.
   ========================================================================= */

import { api, ApiError } from "./api";

export type ReverseGeocode = {
  formatted: string | null;
  village: string | null;
  ward: string | null;
  municipality: string | null;
  province: string | null;
  country: string | null;
  postcode: string | null;
  approximate: true;
  provider: "nominatim";
  fetchedAt: string;
  raw: Record<string, string> | null;
};

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseGeocode | null> {
  try {
    return await api.post<ReverseGeocode>("/api/geocode/reverse", { lat, lng });
  } catch (e) {
    // 502 = provider unavailable; treat as "no address right now".
    // 401 = session expired; caller should handle.
    if (e instanceof ApiError && e.status === 502) return null;
    if (e instanceof ApiError && e.status === 401) throw e;
    return null;
  }
}

/**
 * Merge a reverse-geocode result into the VisitForm location fields.
 * Only fills fields that are currently blank; never overwrites what the
 * fieldworker typed. The `locationSource` is set to "externally_confirmed"
 * only if the fieldworker hasn't already chosen a source.
 */
export function applyGeocodeToForm(
  form: import("./types").VisitForm,
  geocode: ReverseGeocode,
): import("./types").VisitForm {
  if (!form.gps) return form;

  const next = { ...form };

  if (!next.villageObserved.trim() && geocode.village) {
    next.villageObserved = geocode.village;
  }
  if (!next.wardObserved.trim() && geocode.ward) {
    next.wardObserved = geocode.ward;
  }
  if (!next.municipalityObserved.trim() && geocode.municipality) {
    next.municipalityObserved = geocode.municipality;
  }

  // Only downgrade the source to externally_confirmed if the fieldworker
  // hasn't stated their own source. "declared" or "observed" always wins.
  if (next.locationSource === "declared" && next.villageObserved && geocode.village) {
    next.locationSource = "externally_confirmed";
  }

  if (!next.locationDiscrepancyNote.trim() && geocode.formatted) {
    next.locationDiscrepancyNote =
      `Approximate address from GPS: ${geocode.formatted}`;
  }

  return next;
}
