import type { CompiledDrivingRoute, EvaluationState } from "./driving-evaluator";
import { indexAtDistance } from "./driving-evaluator";
import { bearingDegrees, haversineMeters } from "./geo";
import { speedLimitAtRouteIndex } from "./route-engine";

/** Playback speed changes the display clock, never the simulated maneuver. */
export function nextSimulationStep(route: CompiledDrivingRoute, state: EvaluationState, index: number) {
  const checkpoint = route.checkpoints[state.activeCheckpointIndex];
  const stopIndex = checkpoint?.checkpoint.type === "stop" && !checkpoint.checkpoint.evaluation?.instructionOnly && checkpoint.pathIndex >= index ? checkpoint.pathIndex : null;
  const stationary = stopIndex != null && index === stopIndex;
  const next = stationary ? index : Math.min(index + 1, stopIndex ?? route.path.length);
  if (next >= route.path.length) return null;
  const coordinate = route.path[next];
  const previous = route.path[index] ?? route.path[0];
  const routeIndex = indexAtDistance(route.originalCumulative, route.cumulative[next]);
  const limit = speedLimitAtRouteIndex(route.source.speedZones, routeIndex, null);
  const speedKmh = stationary ? 0 : Math.min(34 + ((next * 3) % 8), limit == null ? 35 : Math.max(5, limit - 2));
  const leg = haversineMeters({ lng: previous[0], lat: previous[1] }, { lng: coordinate[0], lat: coordinate[1] });
  return { index: next, coordinate, speedKmh, elapsed: stationary ? 500 : Math.max(100, Math.round(leg / (speedKmh / 3.6) * 1000)),
    heading: stationary ? null : bearingDegrees({ lng: previous[0], lat: previous[1] }, { lng: coordinate[0], lat: coordinate[1] }) };
}
