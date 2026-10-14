import type { GpsSample } from "../types/domain";
import { haversineMeters, nearestPointOnRoute, routeLengthMeters } from "./geo";

export type RoadCoordinate = [number, number];
export type RoadTracePoint = {
  coordinate: RoadCoordinate;
  matchingIndex: number;
  waypointIndex: number;
  alternatives: number;
  hint?: string;
};
export type RoadTraceMatch = {
  tracepoints: (RoadTracePoint | null)[];
  matchings: { confidence: number; legs: RoadCoordinate[][] }[];
};
export type RoadMatchFix = Pick<GpsSample, "lng" | "lat" | "accuracy" | "timestamp">;
export const MAX_ROAD_MATCH_FIXES = 32;
export const MAX_FIELD_ACCURACY_METERS = 35;

const point = ([lng, lat]: RoadCoordinate) => ({ lng, lat });
const validCoordinate = (v: unknown): v is RoadCoordinate => Array.isArray(v) && v.length === 2 &&
  Number.isFinite(v[0]) && Math.abs(v[0]) <= 180 && Number.isFinite(v[1]) && Math.abs(v[1]) <= 90;

/** OSRM timestamps use whole seconds. Never send duplicate or reordered fixes. */
export function validRoadMatchFixes(value: unknown): value is RoadMatchFix[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_ROAD_MATCH_FIXES) return false;
  let second = -Infinity;
  for (const fix of value) {
    if (!fix || !validCoordinate([fix.lng, fix.lat]) || !Number.isFinite(fix.accuracy) ||
        fix.accuracy < 0 || fix.accuracy > MAX_FIELD_ACCURACY_METERS ||
        !Number.isFinite(fix.timestamp) || fix.timestamp <= 0 || fix.timestamp > 8_640_000_000_000_000) return false;
    const next = Math.floor(fix.timestamp / 1000);
    if (next <= second) return false;
    second = next;
  }
  return true;
}

/** Keep per-leg geometry: nearest projection on a whole trace loses repeated road visits. */
export function parseRoadTraceMatch(body: unknown, fixes: RoadMatchFix[]): RoadTraceMatch {
  const data = body as { code?: unknown; tracepoints?: unknown; matchings?: unknown } | null;
  if (data?.code !== "Ok" || !Array.isArray(data.tracepoints) || data.tracepoints.length !== fixes.length ||
      !Array.isArray(data.matchings) || !data.matchings.length || data.matchings.length > fixes.length) {
    throw new Error("გზის დამთხვევის პასუხი არასწორია.");
  }
  let vertices = 0;
  const matchings = data.matchings.map((entry) => {
    if (!entry || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1 ||
        !Array.isArray(entry.legs) || !entry.legs.length || entry.legs.length >= fixes.length) {
      throw new Error("გზის დამთხვევის მონაკვეთი არასწორია.");
    }
    const legs = entry.legs.map((leg: { steps?: unknown }) => {
      if (!Array.isArray(leg?.steps) || !leg.steps.length || leg.steps.length > 500) throw new Error("გზის მოსახვევები მიუწვდომელია.");
      const coordinates: RoadCoordinate[] = [];
      for (const step of leg.steps) {
        const part = step?.geometry?.coordinates;
        if (!Array.isArray(part) || !part.length) throw new Error("გზის geometry მიუწვდომელია.");
        for (const coordinate of part) {
          if (!validCoordinate(coordinate) || ++vertices > 20_000) throw new Error("გზის geometry არასწორია.");
          const previous = coordinates.at(-1);
          if (previous && coordinate === part[0] && haversineMeters(point(previous), point(coordinate)) > 2) {
            throw new Error("გზის მონაკვეთი გაწყვეტილია.");
          }
          if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
        }
      }
      if (coordinates.length === 1) coordinates.push([...coordinates[0]]);
      return coordinates;
    });
    return { confidence: entry.confidence as number, legs: legs as RoadCoordinate[][] };
  });
  const tracepoints = data.tracepoints.map((entry, i): RoadTracePoint | null => {
    if (entry == null) return null;
    if (!validCoordinate(entry.location) || !Number.isInteger(entry.matchings_index) ||
        !Number.isInteger(entry.waypoint_index) || !Number.isInteger(entry.alternatives_count) || entry.alternatives_count < 0 ||
        entry.matchings_index < 0 || entry.matchings_index >= matchings.length || entry.waypoint_index < 0 ||
        entry.waypoint_index > matchings[entry.matchings_index].legs.length ||
        haversineMeters(fixes[i], point(entry.location)) > Math.max(15, (fixes[i].accuracy ?? 0) * 1.5)) {
      throw new Error("GPS წერტილი გზას სანდოდ ვერ დაემთხვა.");
    }
    return { coordinate: entry.location, matchingIndex: entry.matchings_index, waypointIndex: entry.waypoint_index,
      alternatives: entry.alternatives_count, hint: typeof entry.hint === "string" && entry.hint.length <= 1024 ? entry.hint : undefined };
  });
  return { tracepoints, matchings };
}

export type ConfirmedRoadSection = {
  coordinates: RoadCoordinate[];
  startIndex: number;
  endIndex: number;
  endpoint: RoadTracePoint;
};

/** Two later fixes resolve branches before their geometry becomes permanent. */
export function confirmRoadSection(
  samples: GpsSample[], match: RoadTraceMatch, anchorIndex: number | null,
  anchorCoordinate: RoadCoordinate | null, finalize: boolean,
): { section: ConfirmedRoadSection | null; reason: "waiting" | "ambiguous" | "gap" | "detour" | null } {
  const lastAllowed = samples.length - 1 - (finalize ? 0 : 2);
  let endIndex = lastAllowed;
  while (endIndex >= 0 && (!match.tracepoints[endIndex] || match.tracepoints[endIndex]!.alternatives > 0)) endIndex -= 1;
  // Finishing must not silently discard an uncertain tail.
  if (finalize && endIndex !== lastAllowed) return { section: null, reason: "ambiguous" };
  if (endIndex < 1 || (anchorIndex != null && endIndex <= anchorIndex)) return { section: null, reason: "waiting" };
  const endpoint = match.tracepoints[endIndex]!;
  const matching = match.matchings[endpoint.matchingIndex];
  if (!matching || matching.confidence < 0.8) return { section: null, reason: "ambiguous" };
  const startIndex = anchorIndex ?? match.tracepoints.findIndex(p => p != null);
  const start = match.tracepoints[startIndex];
  if (!start || start.matchingIndex !== endpoint.matchingIndex || start.waypointIndex >= endpoint.waypointIndex) {
    return { section: null, reason: "gap" };
  }
  if (anchorCoordinate && haversineMeters(point(anchorCoordinate), point(start.coordinate)) > 3) {
    return { section: null, reason: "ambiguous" };
  }
  let previousIndex = startIndex;
  let previousWaypoint = start.waypointIndex;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const current = match.tracepoints[i];
    if (!current) continue; // A single outlier may be omitted by OSRM.
    if (current.matchingIndex !== endpoint.matchingIndex || current.waypointIndex !== previousWaypoint + 1 ||
        samples[i].timestamp - samples[previousIndex].timestamp > 15_000) return { section: null, reason: "gap" };
    previousIndex = i;
    previousWaypoint = current.waypointIndex;
  }
  const coordinates: RoadCoordinate[] = [];
  for (let i = start.waypointIndex; i < endpoint.waypointIndex; i += 1) {
    const leg = matching.legs[i];
    if (!leg?.length || (coordinates.length && haversineMeters(point(coordinates.at(-1)!), point(leg[0])) > 2)) {
      return { section: null, reason: "gap" };
    }
    for (const c of leg) {
      const previous = coordinates.at(-1);
      if (!previous || previous[0] !== c[0] || previous[1] !== c[1]) coordinates.push([...c]);
    }
  }
  if (coordinates.length < 2 || haversineMeters(point(coordinates[0]), point(start.coordinate)) > 3 ||
      haversineMeters(point(coordinates.at(-1)!), point(endpoint.coordinate)) > 3) return { section: null, reason: "gap" };
  const evidence = samples.slice(startIndex, endIndex + 1);
  const measuredLength = routeLengthMeters(evidence.map(s => [s.lng, s.lat]));
  const accuracy = Math.max(...evidence.map(s => s.accuracy ?? MAX_FIELD_ACCURACY_METERS));
  let deviceDistance = 0;
  for (let i = 1; i < evidence.length; i += 1) {
    const a = evidence[i - 1], b = evidence[i];
    if (a.speedMps != null && b.speedMps != null) deviceDistance += (a.speedMps + b.speedMps) / 2 * (b.timestamp - a.timestamp) / 1000;
  }
  if (routeLengthMeters(coordinates) > Math.max(30, Math.max(measuredLength, deviceDistance) * 1.65 + accuracy * 2) ||
      coordinates.some(c => nearestPointOnRoute(point(c), evidence.map(s => [s.lng, s.lat])).distance > Math.max(18, accuracy * 1.5))) {
    return { section: null, reason: "detour" };
  }
  return { section: { coordinates, startIndex, endIndex, endpoint }, reason: null };
}
