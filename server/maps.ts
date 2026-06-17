// Google Maps routing for Mira. Uses the Routes API computeRoutes endpoint with
// optimizeWaypointOrder to put a day's stops in the most efficient driving order
// and report the drive time/distance of each leg. Addresses are passed straight
// through (no separate geocoding step needed).
//
// Needs GOOGLE_MAPS_API_KEY with the Routes API enabled.

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface OptimizedRoute {
  /** Optimized visiting order as indices into the input `stops` array. */
  order: number[];
  /** Drive legs in travel order: origin→stop, stop→stop, …, →destination. */
  legs: Array<{ durationSec: number; distanceMeters: number }>;
  totalDurationSec: number;
  totalDistanceMeters: number;
}

export function mapsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
}

/** Parse a protobuf duration string like "1316s" into seconds. */
function parseDuration(d: unknown): number {
  if (typeof d !== 'string') return 0;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
  return m ? Math.round(parseFloat(m[1])) : 0;
}

/**
 * Optimize a round trip: origin → (stops in best order) → origin.
 * `order` indexes into `stops`; `legs[0]` is origin→first stop, `legs[i]` is the
 * drive into the i-th visited stop, and the final leg is the return to origin.
 */
export async function optimizeRoute(origin: string, stops: string[]): Promise<OptimizedRoute> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  if (stops.length === 0) return { order: [], legs: [], totalDurationSec: 0, totalDistanceMeters: 0 };

  const body = {
    origin: { address: origin },
    destination: { address: origin }, // round trip back to the office
    intermediates: stops.map((address) => ({ address })),
    travelMode: 'DRIVE',
    optimizeWaypointOrder: stops.length > 1,
  };

  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Record<string, any>;
  if (!res.ok || json.error) {
    const msg = json?.error?.message || `Routes API HTTP ${res.status}`;
    throw new Error(msg);
  }
  const route = json.routes?.[0];
  if (!route) throw new Error('Routes API returned no route');

  const order: number[] =
    Array.isArray(route.optimizedIntermediateWaypointIndex) && route.optimizedIntermediateWaypointIndex.length
      ? route.optimizedIntermediateWaypointIndex
      : stops.map((_, i) => i);
  const legs = (route.legs ?? []).map((l: Record<string, unknown>) => ({
    durationSec: parseDuration(l.duration),
    distanceMeters: typeof l.distanceMeters === 'number' ? l.distanceMeters : 0,
  }));
  return {
    order,
    legs,
    totalDurationSec: parseDuration(route.duration),
    totalDistanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : 0,
  };
}
