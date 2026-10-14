import type { GpsSample } from "../types/domain";
import type { RoadTraceMatch } from "../utils/road-trace-match";

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || "Map request failed");
  return body as T;
}

type SnapOptions = { heading?: number; radiusMeters?: number };
type RouteOptions = {
  radiuses?: number[];
  bearings?: ({ bearing: number; tolerance: number } | null)[];
  hints?: (string | null)[];
};

export const mapEngineService = {
  match(samples: GpsSample[], options: { hints?: (string | null)[]; signal?: AbortSignal } = {}) {
    return fetch("/api/map/match", {
      method: "POST", signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: samples.map(({ lng, lat, accuracy, timestamp }) => ({ lng, lat, accuracy, timestamp })), hints: options.hints }),
    }).then(r => parse<RoadTraceMatch>(r));
  },
  snap(lng: number, lat: number, options: SnapOptions = {}) {
    return fetch("/api/map/snap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lng, lat, ...options }),
    }).then((r) => parse<{ coordinate: [number, number]; distance: number; hint?: string }>(r));
  },
  route(waypoints: [number, number][], options: RouteOptions = {}) {
    return fetch("/api/map/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypoints, ...options }),
    }).then((r) => parse<{ coordinates: [number, number][]; distanceMeters: number }>(r));
  },
  routeLeg(endpoints: [[number, number], [number, number]], options: { targetHint?: string } = {}) {
    // An editor anchor at a junction has no known departure bearing. Keep the
    // selected road position, and let the router evaluate available turns.
    return mapEngineService.route(endpoints, {
      radiuses: [3, 3],
      hints: options.targetHint ? [null, options.targetHint] : undefined,
    });
  },
};
