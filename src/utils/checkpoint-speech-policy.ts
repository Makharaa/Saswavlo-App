import type { CompiledDrivingRoute, EvaluationState } from "./driving-evaluator";

/** Completion may occur on the same GPS frame as the timely voice request. */
export function checkpointSpeechInWindow(route: CompiledDrivingRoute, state: EvaluationState, index: number) {
  const marker = route.checkpoints[index];
  if (!marker || !state.match || state.missed.includes(index) || state.uncertain.includes(index)) return false;
  const remaining = marker.distance - state.match.distanceAlongMeters;
  return remaining >= -12 && remaining <= marker.checkpoint.triggerMeters;
}

/** Replay preserves request history, but cannot prove that a phone played it. */
export function checkpointSpeechToResume(state: EvaluationState): number | null {
  const index = state.activeCheckpointIndex;
  return state.announced.includes(index) && !state.completed.includes(index) &&
    !state.missed.includes(index) && !state.uncertain.includes(index) ? index : null;
}

export function resumedCheckpointSpeechDecision(route: CompiledDrivingRoute, previous: EvaluationState,
  current: EvaluationState, index: number): "wait" | "discard" | "retry" {
  const marker = route.checkpoints[index];
  if (!marker || current.activeCheckpointIndex !== index || current.completed.includes(index) ||
      current.missed.includes(index) || current.uncertain.includes(index)) return "discard";
  if (!current.match || current.quality !== "usable" || current.gap ||
      (current.direction !== "forward" && current.direction !== "stationary")) return "wait";
  const remaining = marker.distance - current.match.distanceAlongMeters;
  if (remaining < -12) return "discard";
  if (remaining > marker.checkpoint.triggerMeters || previous.gap || previous.quality !== "usable") return "wait";
  return "retry";
}
