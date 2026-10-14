import type { GpsSample } from "../types/domain";
import { bearingDegrees, haversineMeters } from "./geo";

export type GpsRejectReason = "invalid" | "poor_accuracy" | "impossible_jump" | "duplicate" | "out_of_order" | "stale";
export interface GpsFilterOptions {
  smoothing: boolean;
  staleAfterMs: number;
  jumpSpeedKmh: number;
  maxAcceptedAccuracyMeters: number | null;
}
export interface GpsFilterState {
  raw: GpsSample | null;
  filtered: GpsSample | null;
  anchor: GpsSample | null;
  lastTimestamp: number | null;
}
export const DEFAULT_GPS_FILTER: GpsFilterOptions = {
  smoothing: true, staleAfterMs: 8_000, jumpSpeedKmh: 220, maxAcceptedAccuracyMeters: 35,
};
export function createGpsFilterState(): GpsFilterState {
  return { raw: null, filtered: null, anchor: null, lastTimestamp: null };
}
function headingBlend(previous: number | null, next: number | null, alpha: number) {
  if (next == null) return null;
  if (previous == null) return next;
  const delta = ((next - previous + 540) % 360) - 180;
  return (previous + delta * alpha + 360) % 360;
}

/** Derivation uses raw fixes, never a smoothed fix as the measurement origin. */
export function filterGpsSample(
  state: GpsFilterState, raw: GpsSample, observedAt: number,
  options: GpsFilterOptions = DEFAULT_GPS_FILTER,
): { state: GpsFilterState; sample: GpsSample | null; reason: GpsRejectReason | null } {
  const reject = (reason: GpsRejectReason) => ({ state, sample: null, reason });
  if (!Number.isFinite(raw.lng) || Math.abs(raw.lng) > 180 || !Number.isFinite(raw.lat) || Math.abs(raw.lat) > 90 ||
      !Number.isFinite(raw.timestamp) || raw.timestamp <= 0 || raw.accuracy == null || !Number.isFinite(raw.accuracy) || raw.accuracy < 0 ||
      (raw.speedMps != null && (!Number.isFinite(raw.speedMps) || raw.speedMps < 0 || raw.speedMps > 220 / 3.6)) ||
      (raw.heading != null && (!Number.isFinite(raw.heading) || raw.heading < 0 || raw.heading >= 360))) return reject("invalid");
  if (raw.timestamp > observedAt + 1_000 || observedAt - raw.timestamp > options.staleAfterMs) return reject("stale");
  if (state.lastTimestamp != null && raw.timestamp <= state.lastTimestamp) return reject(raw.timestamp === state.lastTimestamp ? "duplicate" : "out_of_order");
  if (options.maxAcceptedAccuracyMeters != null && raw.accuracy > options.maxAcceptedAccuracyMeters) return reject("poor_accuracy");

  const previous = state.raw;
  const gap = previous ? (raw.timestamp - previous.timestamp) / 1000 : Infinity;
  if (previous && gap > 0 && gap < 12) {
    const displacement = haversineMeters(previous, raw);
    const allowance = Math.max(25, (raw.accuracy + (previous.accuracy ?? 35)) * 1.5);
    if (displacement > allowance && displacement / gap > options.jumpSpeedKmh / 3.6) return reject("impossible_jump");
    if (raw.speedMps != null && previous.speedMps != null && gap <= 8) {
      const reportedTravel = Math.max(raw.speedMps, previous.speedMps) * gap * 1.8;
      if (displacement > Math.max(25, reportedTravel + raw.accuracy + (previous.accuracy ?? 35) + 8)) return reject("impossible_jump");
    }
  }

  let anchor = gap > options.staleAfterMs / 1000 ? raw : state.anchor ?? previous ?? raw;
  const anchorAge = (raw.timestamp - anchor.timestamp) / 1000;
  const displacement = haversineMeters(anchor, raw);
  const noise = Math.max(4, Math.hypot(raw.accuracy, anchor.accuracy ?? 35) * 1.5);
  let speedMps = raw.speedMps;
  let heading = raw.heading;
  let speedSource: GpsSample["speedSource"] = speedMps == null ? "unknown" : "device";
  let headingSource: GpsSample["headingSource"] = heading == null ? "unknown" : "device";
  let speedConfidence: GpsSample["speedConfidence"] = speedMps == null ? "unknown" : "high";
  let headingConfidence: GpsSample["headingConfidence"] = heading != null && (speedMps ?? 0) >= 5 / 3.6 ? "high" : "unknown";

  if (anchorAge >= 1 && displacement > noise) {
    if (speedMps == null) {
      speedMps = Math.min(220 / 3.6, displacement / anchorAge);
      speedSource = "derived"; speedConfidence = "high";
    }
    if (heading == null && speedMps >= 5 / 3.6) {
      heading = bearingDegrees(anchor, raw);
      headingSource = "derived"; headingConfidence = "high";
    }
    anchor = raw;
  } else if (anchorAge >= 3 && speedMps == null) {
    // Small drift is not reliable evidence of either motion or a full stop.
    speedMps = 0; speedSource = "derived"; speedConfidence = "low";
  }
  if (anchorAge > 10 || (raw.speedMps != null && raw.speedMps < 1)) anchor = raw;
  if (headingConfidence !== "high") heading = null;

  let sample: GpsSample = { ...raw, speedMps, heading, speedSource, headingSource, speedConfidence, headingConfidence };
  if (options.smoothing && state.filtered && gap <= options.staleAfterMs / 1000) {
    const alpha = (speedMps ?? 0) >= 12 ? 0.78 : raw.accuracy <= 8 ? 0.68 : raw.accuracy <= 15 ? 0.5 : 0.34;
    sample = { ...sample,
      lng: state.filtered.lng + (raw.lng - state.filtered.lng) * alpha,
      lat: state.filtered.lat + (raw.lat - state.filtered.lat) * alpha,
      heading: headingBlend(state.filtered.heading, heading, (speedMps ?? 0) >= 8 ? 0.68 : 0.42),
    };
    // A reported zero must remain zero so position smoothing cannot hide a stop.
    const deviceStopped = raw.speedMps != null && raw.speedMps < 0.8;
    const wasStopped = previous?.speedMps != null && previous.speedMps < 0.8;
    const heldDisplacement = haversineMeters(state.filtered, raw);
    if ((deviceStopped && wasStopped) || (speedConfidence !== "high" && heldDisplacement <= Math.max(4, Math.min(15, raw.accuracy * 0.8)))) {
      // Hold position without upgrading an uncertain derived speed to a reliable stop.
      sample.lng = state.filtered.lng;
      sample.lat = state.filtered.lat;
    } else if (deviceStopped) {
      // The first stop fix must reach the real stop location, without smoothing lag.
      sample.lng = raw.lng;
      sample.lat = raw.lat;
    }
  }
  return { state: { raw, filtered: sample, anchor, lastTimestamp: raw.timestamp }, sample, reason: null };
}
