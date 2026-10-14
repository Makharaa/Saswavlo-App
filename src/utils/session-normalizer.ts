import type { DrivingSessionResult, RouteDraft } from "../types/domain";
import { haversineMeters } from "./geo";
import { compileDrivingRoute, replayDrivingTrace } from "./driving-evaluator";

export function normalizeDrivingSession(input: DrivingSessionResult, snapshot?: RouteDraft | null): DrivingSessionResult {
  if (snapshot && input.trace !== undefined) {
    const replay = replayDrivingTrace(compileDrivingRoute(snapshot), input.trace, input.mode, input.traceComplete === true && input.trace.length > 0);
    return { ...input, routeVersion: input.routeVersion ?? null,
      durationSeconds: Math.max(0, Math.round(((input.mode === "simulation" ? input.trace.at(-1)?.evaluationTime ?? input.finishedAt : input.finishedAt) - input.startedAt) / 1000)),
      distanceMeters: replay.state.distanceMeters, maxSpeedKmh: replay.state.maxSpeedKmh,
      checkpointsCompleted: replay.state.completed.length, checkpointsTotal: snapshot.checkpoints.length,
      speedingEvents: replay.events.filter((event) => event.type === "speeding").length,
      offRouteEvents: replay.events.filter((event) => event.type === "off_route").length,
      events: [{ type: "session_started", timestamp: input.startedAt }, ...replay.events, { type: "session_finished", timestamp: input.finishedAt }],
      evaluation: replay.evaluation,
    };
  }
  // Older queued sessions lack complete fixes. Preserve history without
  // presenting those client events as a replayed assessment.
  const ordered = [...input.events].sort((a, b) => a.timestamp - b.timestamp);
  const checkpointLimit = snapshot?.checkpoints.length ?? input.checkpointsTotal;
  let next = 0;
  const events = ordered.filter((event) => {
    if (event.type !== "checkpoint") return true;
    if (event.checkpointIndex !== next || next >= checkpointLimit) return false;
    next += 1; return true;
  });
  const positions = events.filter((event) => event.type === "position" && event.lng != null && event.lat != null);
  let distance = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const a = positions[index - 1]; const b = positions[index];
    const seconds = (b.timestamp - a.timestamp) / 1000;
    if (seconds <= 0) continue;
    const leg = haversineMeters({ lng: a.lng!, lat: a.lat! }, { lng: b.lng!, lat: b.lat! });
    if (leg / seconds <= 220 / 3.6) distance += leg;
  }
  const speeds = events.filter((event) => (event.type === "position" || event.type === "speeding") && event.value != null && event.value >= 0).map((event) => event.value!);
  return { ...input, routeVersion: input.routeVersion ?? null,
    durationSeconds: Math.max(0, Math.round((input.finishedAt - input.startedAt) / 1000)),
    distanceMeters: positions.length > 1 ? distance : input.distanceMeters,
    maxSpeedKmh: speeds.length ? Math.min(220, Math.max(...speeds)) : input.maxSpeedKmh,
    speedingEvents: events.filter((event) => event.type === "speeding").length,
    offRouteEvents: events.filter((event) => event.type === "off_route").length,
    checkpointsCompleted: snapshot ? next : Math.min(input.checkpointsCompleted, checkpointLimit), checkpointsTotal: checkpointLimit,
    events, evaluation: { version: 0, status: "legacy", rejectedSamples: 0, missedCheckpoints: 0, uncertainCheckpoints: 0,
      wrongDirectionEvents: events.filter((event) => event.type === "wrong_direction").length },
  };
}
