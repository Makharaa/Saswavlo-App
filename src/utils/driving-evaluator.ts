import type { DrivingEvent, DrivingTracePoint, GpsSample, RouteCheckpoint, RouteDraft, SessionEvaluation } from "../types/domain";
import { bearingDegrees, densifyRoute, haversineMeters, nearestPointOnRouteRange, routeCumulativeDistances } from "./geo";
import type { NearestRoutePoint } from "./geo";
import { headingDifference, speedLimitAtRouteIndex } from "./route-engine";
import { createGpsFilterState, filterGpsSample } from "./gps-filter";

export const EVALUATION_VERSION = 2;
export const MAX_TRACE_POINTS = 20_000;
type Direction = "forward" | "reverse" | "stationary" | "uncertain";
type CheckpointPhase = "approaching" | "announced" | "stopping" | "departing";
interface CompiledCheckpoint {
  checkpoint: RouteCheckpoint;
  distance: number;
  pathIndex: number;
  outgoingBearing: number;
  departureDistance: number;
}
export interface CompiledDrivingRoute {
  source: RouteDraft;
  path: [number, number][];
  cumulative: number[];
  originalCumulative: number[];
  total: number;
  checkpoints: CompiledCheckpoint[];
}
export interface EvaluationState {
  activeCheckpointIndex: number;
  completed: number[];
  missed: number[];
  uncertain: number[];
  // Deterministic instruction requests; successful playback is tracked by
  // the live speech-delivery queue, not inferred from GPS evaluation.
  announced: number[];
  checkpoint: { phase: CheckpointPhase; approachSeen: boolean; nearSeen: boolean; stopSince: number | null; discontinuity: boolean };
  progressMeters: number;
  match: NearestRoutePoint | null;
  direction: Direction;
  quality: "usable" | "uncertain" | "paused";
  reason: string | null;
  currentSpeedLimit: number | null;
  speedKmh: number;
  distanceMeters: number;
  maxSpeedKmh: number;
  lastTime: number | null;
  lastPosition: GpsSample | null;
  gap: boolean;
  /** Consecutive consistent but lower-accuracy fixes, never proof on their own. */
  weakFixStreak: number;
  // Unlike dwell/penalty clocks, this anchor survives rejected/hidden fixes.
  matchingAnchor: { time: number; progressMeters: number; speedMps: number } | null;
  speedingSince: number | null;
  speedingActive: boolean;
  offRouteSince: number | null;
  offRouteActive: boolean;
  reverseSince: number | null;
  reverseActive: boolean;
  rejectedSamples: number;
  atFinish: boolean;
}
function newCheckpoint(): EvaluationState["checkpoint"] {
  return { phase: "approaching", approachSeen: false, nearSeen: false, stopSince: null, discontinuity: false };
}
export function createEvaluationState(): EvaluationState {
  return { activeCheckpointIndex: 0, completed: [], missed: [], uncertain: [], announced: [], checkpoint: newCheckpoint(),
    progressMeters: 0, match: null, direction: "uncertain", quality: "paused", reason: "waiting", currentSpeedLimit: null,
    speedKmh: 0, distanceMeters: 0, maxSpeedKmh: 0, lastTime: null, lastPosition: null, gap: false, weakFixStreak: 0, matchingAnchor: null,
    speedingSince: null, speedingActive: false, offRouteSince: null, offRouteActive: false,
    reverseSince: null, reverseActive: false, rejectedSamples: 0, atFinish: false };
}

export function indexAtDistance(cumulative: readonly number[], distance: number): number {
  let low = 0;
  let high = Math.max(0, cumulative.length - 1);
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cumulative[mid] < distance) low = mid + 1;
    else high = mid;
  }
  return low;
}
function pointAtDistance(path: [number, number][], cumulative: number[], distance: number) {
  const i = indexAtDistance(cumulative, Math.max(0, distance));
  const coord = path[Math.min(i, path.length - 1)] ?? [0, 0];
  return { lng: coord[0], lat: coord[1] };
}
function pathBearing(route: CompiledDrivingRoute, from: number, to: number) {
  return bearingDegrees(pointAtDistance(route.path, route.cumulative, from), pointAtDistance(route.path, route.cumulative, to));
}

/** Immutable per-route index. Per-fix matching scans only a distance window. */
export function compileDrivingRoute(source: RouteDraft): CompiledDrivingRoute {
  const path = densifyRoute(source.coordinates, 6);
  const cumulative = routeCumulativeDistances(path);
  const originalCumulative = routeCumulativeDistances(source.coordinates);
  const route: CompiledDrivingRoute = { source, path, cumulative, originalCumulative, total: cumulative.at(-1) ?? 0, checkpoints: [] };
  let previousIndex = 0;
  route.checkpoints = [...source.checkpoints].sort((a, b) => a.orderIndex - b.orderIndex).map((checkpoint) => {
    const hint = checkpoint.routeCoordinateIndex;
    const coord = hint == null ? null : source.coordinates[hint];
    const match = nearestPointOnRouteRange(checkpoint, source.coordinates, previousIndex, Math.max(0, source.coordinates.length - 2), originalCumulative);
    const distance = coord && hint != null && hint >= previousIndex && haversineMeters(checkpoint, { lng: coord[0], lat: coord[1] }) <= 50
      ? originalCumulative[hint] : match.distanceAlongMeters;
    previousIndex = indexAtDistance(originalCumulative, distance);
    const departureDistance = Math.min(route.total, distance + (checkpoint.evaluation?.departureMeters ?? 15));
    return { checkpoint, distance, pathIndex: indexAtDistance(cumulative, distance), departureDistance,
      outgoingBearing: pathBearing(route, distance + 4, Math.min(route.total, distance + 24)) };
  });
  return route;
}

function matchDrivingPosition(
  route: CompiledDrivingRoute, state: EvaluationState, sample: GpsSample,
  time: number, headingReliable: boolean, accuracy: number
) {
  const anchor = state.matchingAnchor;
  const initial = anchor == null;
  const seconds = anchor ? Math.max(0, (time - anchor.time) / 1000) : 1;
  const recovering = !initial && (state.gap || seconds > 3);
  const reachable = Math.max(45,
    Math.max(sample.speedMps ?? 0, anchor?.speedMps ?? 0, recovering ? 10 : 0) *
      Math.min(seconds || 1, 600) * 1.8 + accuracy * 2 + (recovering ? 20 : 0));
  const start = { lng: route.path[0][0], lat: route.path[0][1] };
  const startDistance = haversineMeters(sample, start);
  const nearStart = startDistance <= 180 + accuracy;
  // A nearby finish/repeated visit must never become the initial position
  // just because its geometry or noisy device heading is a closer match.
  const parked = sample.speedMps != null && sample.speedConfidence !== "low" && sample.speedConfidence !== "unknown" && sample.speedMps <= 3 / 3.6;
  if (!initial && parked && state.direction === "stationary" && state.match && state.lastPosition && !recovering &&
      haversineMeters(sample, state.lastPosition) <= Math.max(3, accuracy)) {
    // Repeated parked fixes must not creep into a later street visit. A new
    // moving fix or recovery after a gap is still matched normally.
    return { match: state.match, recovering, ambiguous: false };
  }
  const initialLimit = parked || startDistance <= Math.max(25, accuracy * 2) ? Math.max(20, startDistance + accuracy)
    : Math.max(200, startDistance * 2 + accuracy * 2 + 40);
  const from = initial ? 0 : Math.max(0, state.progressMeters - (recovering ? reachable : 24));
  const to = initial ? nearStart ? Math.min(route.total, initialLimit) : route.total
    : Math.min(route.total, state.progressMeters + reachable);
  const candidates: { distance: number; along: number; difference: number | null }[] = [];
  const match = nearestPointOnRouteRange(sample, route.path,
    Math.max(0, indexAtDistance(route.cumulative, from) - 1),
    Math.min(route.path.length - 2, Math.max(0, indexAtDistance(route.cumulative, to) - 1)), route.cumulative,
    (segment, distance, along) => {
      // Segment windows alone include the whole boundary segment. Keep
      // its projection from exceeding the reachable distance as well.
      if (along > to + 0.01) return 1_000_000 + distance;
      const a = route.path[segment], b = route.path[segment + 1];
      const bearing = bearingDegrees({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
      const difference = headingReliable ? headingDifference(sample.heading!, bearing) : null;
      candidates.push({ distance, along, difference });
      const onRoad = distance <= Math.max(18, accuracy * 1.5);
      return distance + (onRoad && difference != null ? difference / 180 * (recovering ? 40 : 12) : 0) +
        Math.max(0, along - state.progressMeters) * (initial || recovering ? 0.03 : 0.02);
    });
  let ambiguous = false;
  if (recovering || initial) {
    const plausible = candidates.filter((item) =>
      item.distance <= Math.min(Math.max(18, accuracy * 1.5), match.distance + Math.max(2, accuracy)) &&
      // An opposite segment still ahead of the known anchor may be the
      // current outbound visit, not evidence the car already reached a
      // later return visit. Treat that overlap as ambiguous after an outage.
      (item.difference == null || item.difference <= 85 || item.along >= state.progressMeters - 24));
    // Dense adjacent segments are one visit. Separate plausible visits
    // cannot be distinguished by this fix; retain reliable progress.
    ambiguous = plausible.some((item) => Math.abs(item.along - match.distanceAlongMeters) > 60);
  }
  return { match, recovering, ambiguous };
}

/** Same transition is used live, in simulation and during server replay. */
export function evaluateDrivingPoint(route: CompiledDrivingRoute, previous: EvaluationState, point: DrivingTracePoint): {
  state: EvaluationState; events: DrivingEvent[]; instructions: number[];
} {
  let state: EvaluationState = { ...previous, checkpoint: { ...previous.checkpoint }, atFinish: false };
  const events: DrivingEvent[] = [];
  const instructions: number[] = [];
  const sample = point.sample;
  const time = point.evaluationTime ?? point.observedAt;
  const pause = (reason: string) => {
    state = { ...state, quality: "paused", reason, gap: true, lastTime: null, lastPosition: null,
      speedingSince: null, speedingActive: false, offRouteSince: null, offRouteActive: false,
      reverseSince: null, reverseActive: false,
      checkpoint: { ...state.checkpoint, stopSince: null, discontinuity: true }, weakFixStreak: 0,
      rejectedSamples: state.rejectedSamples + (point.reason && point.reason !== "hidden" && point.reason !== "paused" ? 1 : 0) };
    return { state, events, instructions };
  };
  if (!point.visible) return pause("hidden");
  if (!point.accepted || !sample) return pause(point.reason ?? "waiting");
  if (sample.accuracy == null || sample.accuracy > 35 || sample.accuracy < 0) return pause("poor_accuracy");
  if (point.observedAt - sample.timestamp > 8_000 || sample.timestamp > point.observedAt + 1_000) return pause("stale");
  if (state.lastTime != null && time <= state.lastTime) return { state: previous, events, instructions };
  if (route.path.length < 2) return pause("route_empty");

  const gapMs = state.lastTime == null ? null : time - state.lastTime;
  const speedKnown = sample.speedMps != null && sample.speedConfidence !== "unknown";
  const speedReliable = speedKnown && sample.speedConfidence !== "low";
  const speed = Math.max(0, (sample.speedMps ?? 0) * 3.6);
  const headingReliable = sample.heading != null && sample.headingConfidence !== "low" && sample.headingConfidence !== "unknown" && speed >= 5;
  const accuracy = sample.accuracy;
  const { match, recovering, ambiguous } = matchDrivingPosition(route, state, sample, time, headingReliable, accuracy);
  const tangent = pathBearing(route, Math.max(0, match.distanceAlongMeters - 6), Math.min(route.total, match.distanceAlongMeters + 12));
  const difference = headingReliable ? headingDifference(sample.heading!, tangent) : null;
  const direction: Direction = ambiguous ? "uncertain" : speedReliable && speed <= 3 ? "stationary"
    : difference == null ? "uncertain" : difference <= 85 ? "forward" : difference >= 110 ? "reverse" : "uncertain";
  const onRoute = match.distance <= Math.max(18, accuracy * 1.5);
  // A single weak GPS fix must NEVER activate a turn. Three consecutive
  // forward, on-path fixes may provisionally establish confidence if the
  // measured track hugs the route and the device reports a useful heading.
  // This does not claim lane-level positioning accuracy.
  const previousMatch = state.match;
  const weakCandidate = accuracy > 20 && accuracy <= 35 && onRoute && !ambiguous &&
    headingReliable && difference != null && difference <= 35 && match.distance <= 8 &&
    (state.matchingAnchor != null || haversineMeters(sample, { lng: route.path[0][0], lat: route.path[0][1] }) <= 25) &&
    (previousMatch == null || (match.distanceAlongMeters >= previousMatch.distanceAlongMeters - 8 &&
      match.distanceAlongMeters <= previousMatch.distanceAlongMeters +
        Math.max(30, (sample.speedMps ?? 0) * Math.max(1, (gapMs ?? 1000) / 1000) * 1.8 + accuracy)));
  state.weakFixStreak = weakCandidate ? previous.weakFixStreak + 1 : 0;
  const spatialReliable = accuracy <= 20 || (weakCandidate && state.weakFixStreak >= 3);
  // A sparse valid fix is not the same as a GPS outage. Only preserve
  // continuous instruction evaluation when the route progression is physically
  // plausible and both speed and travel direction are trustworthy.
  const continuityTrusted = gapMs != null && gapMs <= 8_000 && !state.gap &&
    speedReliable && headingReliable && onRoute && !ambiguous && spatialReliable &&
    difference != null && difference <= 55 && previousMatch != null &&
    match.distanceAlongMeters >= previousMatch.distanceAlongMeters - 8 &&
    match.distanceAlongMeters - previousMatch.distanceAlongMeters <=
      Math.max(30, (sample.speedMps ?? 0) * (gapMs / 1000) * 1.8 + accuracy * 2);
  const discontinuity = state.gap || (gapMs != null && gapMs > 3_000 && !continuityTrusted);
  state.match = match;
  state.direction = direction;
  state.speedKmh = speed;
  state.quality = !ambiguous && spatialReliable && (direction !== "uncertain" || speed <= 3) ? "usable" : "uncertain";
  state.reason = ambiguous ? "route_ambiguous" : !spatialReliable ? "poor_accuracy" : direction === "uncertain" ? "heading_uncertain" : !speedReliable ? "speed_uncertain" : null;
  if (spatialReliable && onRoute && (direction === "forward" || direction === "stationary")) {
    state.progressMeters = Math.max(state.progressMeters, match.distanceAlongMeters);
    state.matchingAnchor = { time, progressMeters: state.progressMeters, speedMps: sample.speedMps ?? 0 };
  }
  if (discontinuity) {
    state.speedingSince = null; state.speedingActive = false; state.offRouteSince = null; state.offRouteActive = false;
    state.reverseSince = null; state.reverseActive = false;
    state.checkpoint.stopSince = null; state.checkpoint.discontinuity = true;
  }
  if (speedReliable) state.maxSpeedKmh = Math.max(state.maxSpeedKmh, speed);
  if (state.lastPosition && !discontinuity && speedReliable && speed >= 3 && gapMs != null) {
    const distance = haversineMeters(state.lastPosition, sample);
    if (distance <= Math.max(20, speed / 3.6 * gapMs / 1000 * 2 + accuracy)) state.distanceMeters += distance;
  }
  state.lastPosition = sample;
  state.lastTime = time;
  state.gap = false;

  let active = route.checkpoints[state.activeCheckpointIndex];
  const routeIndex = indexAtDistance(route.originalCumulative, state.progressMeters);
  state.currentSpeedLimit = speedLimitAtRouteIndex(route.source.speedZones, routeIndex, null);
  if (active?.checkpoint.speedLimit != null && onRoute && direction !== "reverse" &&
      active.distance - state.progressMeters <= active.checkpoint.triggerMeters && active.distance >= state.progressMeters - 15) {
    state.currentSpeedLimit = state.currentSpeedLimit == null ? active.checkpoint.speedLimit : Math.min(state.currentSpeedLimit, active.checkpoint.speedLimit);
  }
  const event = (type: DrivingEvent["type"], note: string, extra: Partial<DrivingEvent> = {}) => {
    events.push({ type, timestamp: point.observedAt, lng: sample.lng, lat: sample.lat, note, ...extra });
  };
  if (speedReliable && state.currentSpeedLimit != null && speed > state.currentSpeedLimit + 3) {
    state.speedingSince ??= time;
    if (!state.speedingActive && time - state.speedingSince >= 3_000) {
      state.speedingActive = true;
      event("speeding", "სიჩქარის გადაჭარბება", { value: speed, limitValue: state.currentSpeedLimit });
    }
  } else if (!speedReliable || state.currentSpeedLimit == null || speed <= state.currentSpeedLimit + 1) {
    state.speedingSince = null; state.speedingActive = false;
  }
  if (match.distance > 40 + accuracy) {
    state.offRouteSince ??= time;
    if (!state.offRouteActive && time - state.offRouteSince >= 4_000) {
      state.offRouteActive = true; event("off_route", "მარშრუტიდან გადახვევა", { value: match.distance });
    }
  } else if (match.distance < 25 + accuracy) {
    state.offRouteSince = null; state.offRouteActive = false;
  }
  if (direction === "reverse" && onRoute && speed >= 8 && spatialReliable) {
    state.reverseSince ??= time;
    if (!state.reverseActive && time - state.reverseSince >= 2_000) {
      state.reverseActive = true; event("wrong_direction", "მარშრუტის საპირისპირო მიმართულებით მოძრაობა");
    }
  } else {
    state.reverseSince = null; state.reverseActive = false;
  }

  // Retire all markers crossed while GPS was absent before considering a
  // nearby instruction; unseen maneuvers cannot be certified.
  if (recovering && !ambiguous && spatialReliable && onRoute && (direction === "forward" || direction === "stationary")) {
    while (active && match.distanceAlongMeters > active.departureDistance + 20) {
      const index = state.activeCheckpointIndex;
      state.uncertain = [...state.uncertain, index];
      event("checkpoint_uncertain", `${active.checkpoint.title} — GPS-ის წყვეტისას გავლა ვერ დადასტურდა`, { checkpointIndex: index });
      state.activeCheckpointIndex += 1;
      state.checkpoint = newCheckpoint();
      active = route.checkpoints[state.activeCheckpointIndex];
    }
  }

  if (active && onRoute && !ambiguous && direction !== "reverse") {
    const checkpoint = active.checkpoint;
    const instructionOnly = checkpoint.evaluation?.instructionOnly === true;
    const remaining = active.distance - match.distanceAlongMeters;
    const straightDistance = haversineMeters(sample, checkpoint);
    if (spatialReliable && direction === "forward" && remaining >= 5 && remaining <= Math.max(checkpoint.triggerMeters, 40)) {
      state.checkpoint.approachSeen = true;
      if (!discontinuity) state.checkpoint.discontinuity = false;
    }
    if (spatialReliable && !discontinuity && remaining <= checkpoint.triggerMeters && remaining >= -12 &&
        (direction === "forward" || direction === "stationary") && !state.announced.includes(state.activeCheckpointIndex)) {
      state.announced = [...state.announced, state.activeCheckpointIndex];
      state.checkpoint.phase = "announced";
      instructions.push(state.activeCheckpointIndex);
    }
    const radius = checkpoint.type === "stop" && !instructionOnly ? checkpoint.evaluation?.stopRadiusMeters ?? 12 : 20;
    const near = spatialReliable && Math.abs(remaining) <= radius && straightDistance <= radius + accuracy;
    if (near) state.checkpoint.nearSeen = true;
    let complete = false;
    if (instructionOnly) {
      // Imported advance warnings identify where to speak, not where the
      // advertised turn happens. Certify passage without turn/stop grading.
      complete = spatialReliable && near && !discontinuity &&
        ((direction === "forward" && speed >= 5 && remaining <= 5) ||
        (direction === "stationary" && state.checkpoint.approachSeen && remaining <= 2));
    } else if (checkpoint.type === "stop") {
      if (near && accuracy <= radius && speedReliable && speed <= 3) {
        state.checkpoint.phase = "stopping";
        state.checkpoint.stopSince ??= time;
        complete = time - state.checkpoint.stopSince >= (checkpoint.evaluation?.stopSeconds ?? 2) * 1000;
      } else state.checkpoint.stopSince = null;
    } else if (checkpoint.type === "left" || checkpoint.type === "right") {
      if (state.checkpoint.approachSeen && remaining <= 0) state.checkpoint.phase = "departing";
      complete = spatialReliable && state.checkpoint.approachSeen && state.checkpoint.nearSeen &&
        match.distanceAlongMeters >= active.departureDistance && direction === "forward" && headingReliable &&
        headingDifference(sample.heading!, active.outgoingBearing) <= 65 && speed >= 5 && !state.checkpoint.discontinuity;
    } else {
      complete = spatialReliable && near && ((direction === "forward" && speed >= 5 && remaining <= 5) ||
        (direction === "stationary" && state.checkpoint.approachSeen && remaining <= 2));
    }
    if (complete) {
      const index = state.activeCheckpointIndex;
      state.completed = [...state.completed, index];
      event("checkpoint", checkpoint.title, { checkpointIndex: index });
      state.activeCheckpointIndex += 1;
      state.checkpoint = newCheckpoint();
    } else if (!ambiguous && match.distanceAlongMeters > active.departureDistance + 20 && (direction === "forward" || direction === "uncertain")) {
      const index = state.activeCheckpointIndex;
      const unknown = instructionOnly || !spatialReliable || !speedReliable || !headingReliable || state.checkpoint.discontinuity || !state.checkpoint.approachSeen;
      if (unknown) state.uncertain = [...state.uncertain, index];
      else state.missed = [...state.missed, index];
      event(unknown ? "checkpoint_uncertain" : "checkpoint_missed",
        unknown ? `${checkpoint.title} — საკმარისი სანდო მონაცემი არ დაფიქსირდა` : `${checkpoint.title} — დავალების შესრულება არ დადასტურდა`,
        { checkpointIndex: index });
      state.activeCheckpointIndex += 1;
      state.checkpoint = newCheckpoint();
    }
  }
  state.atFinish = !ambiguous && state.activeCheckpointIndex >= route.checkpoints.length && onRoute && direction !== "reverse" &&
    state.progressMeters >= route.total - 15 && haversineMeters(sample, pointAtDistance(route.path, route.cumulative, route.total)) <= 20 + accuracy;
  return { state, events, instructions };
}

/** Raw device fixes are independently filtered; client checkpoint flags are ignored. */
export function replayDrivingTrace(route: CompiledDrivingRoute, trace: DrivingTracePoint[], mode: "real" | "simulation", complete = true,
  onFrame?: (point: DrivingTracePoint, state: EvaluationState) => void) {
  let state = createEvaluationState();
  let filter = createGpsFilterState();
  const events: DrivingEvent[] = [];
  let lastPosition: GpsSample | null = null;
  for (const original of trace) {
    let point = original;
    if (mode === "real" && original.raw) {
      const filtered = filterGpsSample(filter, original.raw, original.observedAt);
      filter = filtered.state;
      point = { ...original, sample: filtered.sample, accepted: filtered.sample != null, reason: filtered.reason, evaluationTime: undefined };
    } else if (mode === "real" && original.accepted) {
      point = { ...original, accepted: false, sample: null, reason: "invalid" };
    }
    const update = evaluateDrivingPoint(route, state, point);
    state = update.state;
    onFrame?.(point, state);
    events.push(...update.events);
    if (point.accepted && point.visible && point.sample && state.quality !== "paused" &&
        (!lastPosition || haversineMeters(lastPosition, point.sample) >= 12)) {
      lastPosition = point.sample;
      events.push({ type: "position", timestamp: point.observedAt, lng: point.sample.lng, lat: point.sample.lat, value: state.speedKmh });
    }
  }
  const evaluation: SessionEvaluation = { version: EVALUATION_VERSION, status: complete ? "replayed" : "incomplete",
    rejectedSamples: state.rejectedSamples, uncertainCheckpoints: state.uncertain.length,
    missedCheckpoints: state.missed.length, wrongDirectionEvents: events.filter((event) => event.type === "wrong_direction").length };
  return { state, events, evaluation, filterState: filter };
}
