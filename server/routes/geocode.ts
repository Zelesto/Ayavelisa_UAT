/* =========================================================================
   server/routes/geocode.ts
   Reverse-geocode a GPS coordinate into an approximate South African address.
   Uses Nominatim (OpenStreetMap) — free, no API key, 1 req/sec policy.

   The result is explicitly labelled approximate. It is a convenience for
   the reviewer and the case record; it never overrides the fieldworker's
   manual village/ward observation.
   ========================================================================= */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
  ?? "Ayavelisa-HumanSettlements/0.1 (ops@ayavelisa.example)";
const TIMEOUT_MS = 5000;

const ReverseBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}).strict();

type NominatimResponse = {
  display_name?: string;
  address?: Record<string, string>;
  lat?: string;
  lon?: string;
};

/* --- Throttle: 1 request per second, shared across all callers ---------- */

let lastCallAt = 0;
let queue: Promise<void> = Promise.resolve();

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastCallAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/* --- Address extraction ------------------------------------------------- */

function pick(
  addr: Record<string, string> | undefined,
  keys: string[],
): string | null {
  if (!addr) return null;
  for (const k of keys) {
    const v = addr[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalise(display: string | undefined, addr: Record<string, string> | undefined) {
  // Prefer the structured fields; fall back to display_name components.
  const village = pick(addr, ["village", "hamlet", "suburb", "neighbourhood", "town"]);
  const ward = pick(addr, ["city_district", "suburb", "county", "municipality"]);
  const municipality = pick(addr, ["city", "municipality", "state_district"]);
  const province = pick(addr, ["state", "region"]);
  const country = pick(addr, ["country"]);
  const postcode = pick(addr, ["postcode"]);

  return {
    formatted: display ?? null,
    village,
    ward,
    municipality,
    province,
    country,
    postcode,
    approximate: true as const,
    provider: "nominatim" as const,
  };
}

/* --- Route registration ------------------------------------------------- */

export async function registerGeocodeRoutes(app: FastifyInstance) {
  app.post("/api/geocode/reverse", async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send({ error: "unauthorized" });

    const parsed = ReverseBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_coordinates", issues: parsed.error.issues });
    }

    const { lat, lng } = parsed.data;
    const url = `${NOMINATIM_URL}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=jsonv2&addressdetails=1&accept-language=en`;

    try {
      const result = await throttle(async () => {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          return { ok: false as const, status: response.status };
        }
        const json = await response.json() as NominatimResponse;
        return { ok: true as const, json };
      });

      if (!result.ok) {
        request.log.warn({ lat, lng, status: result.status }, "Nominatim returned non-OK");
        return reply.code(502).send({ error: "geocode_provider_failed" });
      }

      const normalised = normalise(result.json.display_name, result.json.address);
      return {
        ...normalised,
        raw: result.json.address ?? null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      request.log.warn({ err: error, lat, lng }, "Reverse geocode request failed");
      return reply.code(502).send({ error: "geocode_unavailable" });
    }
  });
}
