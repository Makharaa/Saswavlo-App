import type { DrivingTracePoint, GpsSample, RouteDraft } from "../types/domain";
import { compileDrivingRoute, replayDrivingTrace } from "./driving-evaluator";
export interface TraceReviewFrame {
  observedAt: number;
  raw: GpsSample | null;
  sample: GpsSample | null;
  accepted: boolean;
  matched: { lng: number; lat: number } | null;
  quality: string;
  reason: string | null;
  progressPercent: number;
}
export function buildTraceReview(route: RouteDraft, trace: DrivingTracePoint[], mode: "real" | "simulation") {
  const frames: TraceReviewFrame[] = [];
  const compiled = compileDrivingRoute(route);
  replayDrivingTrace(compiled, trace, mode, true, (point, state) => frames.push({ observedAt: point.observedAt, raw: point.raw,
    sample: point.sample, accepted: point.accepted, matched: point.accepted ? state.match?.point ?? null : null,
    quality: state.quality, reason: state.reason, progressPercent: compiled.total > 0 ? state.progressMeters / compiled.total * 100 : 0 }));
  return frames;
}
export function traceReasonLabel(reason: string | null) {
  const labels: Record<string, string> = { poor_accuracy: "GPS-ის სიზუსტე არასაკმარისია", impossible_jump: "არარეალური გადაადგილება", duplicate: "განმეორებული მონაცემი",
    out_of_order: "მონაცემის დრო არასწორ რიგშია", stale: "GPS მონაცემი მოძველებულია", hidden: "გვერდი ფონურ რეჟიმშია", paused: "სესია დაპაუზებულია",
    invalid: "მონაცემი არასწორია", unavailable: "GPS დროებით მიუწვდომელია", heading_uncertain: "მიმართულება დაუზუსტებელია", speed_uncertain: "სიჩქარე დაუზუსტებელია", waiting: "GPS-ის მოლოდინი" };
  return reason ? labels[reason] ?? "მონაცემი არასაკმარისია" : "სანდო მონაცემი";
}
