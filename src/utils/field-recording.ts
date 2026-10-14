import type { DrivingTracePoint, GpsSample } from "../types/domain";
import { haversineMeters } from "./geo";
import { confirmRoadSection, MAX_FIELD_ACCURACY_METERS, MAX_ROAD_MATCH_FIXES } from "./road-trace-match";
import type { RoadCoordinate, RoadTraceMatch } from "./road-trace-match";

export type FieldRecordingIssue = "accuracy" | "jump" | "stationary" | "waiting" | "ambiguous" | "gap" | "detour" | "unavailable" | null;
export const fieldRecordingIssueLabel = (issue: FieldRecordingIssue) => ({
  accuracy: "GPS არაზუსტია — დადასტურებული პოზიცია შენარჩუნებულია",
  jump: "GPS ხტომა გამოტოვებულია — პოზიციას ვამოწმებთ",
  stationary: "გაჩერება — პოზიცია სტაბილურია",
  waiting: "გზას ვაზუსტებთ — ბოლო წერტილები ჯერ მოწმდება",
  ambiguous: "გზის განშტოებას ვამოწმებთ — დაელოდე ან გააგრძელე რამდენიმე მეტრი",
  gap: "GPS მონაკვეთი დაიკარგა — გამოტოვებული გზა არ შეერთდება",
  detour: "საეჭვო შემოვლა გამოტოვებულია — გზა მოწმდება",
  unavailable: "გზაზე მიბმა მიუწვდომელია — GPS ჩანაწერი შენარჩუნებულია",
}[issue ?? "waiting"]);

type FieldGpsObservation = DrivingTracePoint & { recordingReason?: string };
export type FieldRecordingSnapshot = {
  version: 1;
  fixes: GpsSample[];
  confirmedIndex: number | null;
  roadSample: GpsSample | null;
  roadHint?: string;
  observations: FieldGpsObservation[];
  observationsComplete: boolean;
  acceptedSamples: number;
  rejectedSamples: number;
  gap: boolean;
  excludedTailAt?: number;
};
export type RecordingMatchRequest = {
  samples: GpsSample[];
  hints: (string | null)[];
  startIndex: number;
  anchorIndex: number | null;
  anchorTimestamp: number | null;
  anchorCoordinate: RoadCoordinate | null;
  finalize: boolean;
};

/** The confirmed prefix is immutable. Only the small pending window is matched. */
export class FieldRecordingBuffer {
  points: RoadCoordinate[];
  fixes: GpsSample[] = [];
  confirmedIndex: number | null = null;
  roadSample: GpsSample | null = null;
  roadHint: string | undefined;
  observations: FieldGpsObservation[] = [];
  observationsComplete = true;
  acceptedSamples = 0;
  rejectedSamples = 0;
  issue: FieldRecordingIssue = "waiting";
  gap = false;
  stationaryCount = 0;
  excludedTailAt: number | undefined;
  private lastObservedAt = -Infinity;
  private lastFixTimestamp = -Infinity;

  constructor(points: RoadCoordinate[] = [], snapshot?: FieldRecordingSnapshot) {
    this.points = points.map(c => [...c]);
    if (snapshot?.version === 1 && Array.isArray(snapshot.fixes) && Array.isArray(snapshot.observations)) {
      this.fixes = [...snapshot.fixes];
      this.confirmedIndex = snapshot.confirmedIndex;
      this.roadSample = snapshot.roadSample;
      this.roadHint = snapshot.roadHint;
      this.observations = [...snapshot.observations];
      this.observationsComplete = snapshot.observationsComplete;
      this.acceptedSamples = snapshot.acceptedSamples;
      this.rejectedSamples = snapshot.rejectedSamples;
      this.gap = snapshot.gap;
      this.excludedTailAt = snapshot.excludedTailAt;
      this.issue = this.gap ? "gap" : "waiting";
      this.lastFixTimestamp = this.fixes.at(-1)?.timestamp ?? -Infinity;
      this.lastObservedAt = this.observations.at(-1)?.observedAt ?? -Infinity;
    }
  }

  get pendingCount() { return Math.max(0, this.fixes.length - (this.confirmedIndex == null ? 0 : this.confirmedIndex + 1)); }

  snapshot(): FieldRecordingSnapshot {
    return { version: 1, fixes: [...this.fixes], confirmedIndex: this.confirmedIndex, roadSample: this.roadSample,
      roadHint: this.roadHint, observations: [...this.observations], observationsComplete: this.observationsComplete,
      acceptedSamples: this.acceptedSamples, rejectedSamples: this.rejectedSamples, gap: this.gap, excludedTailAt: this.excludedTailAt };
  }

  /** Start or resume at the last recorded location; never bridge a moved phone. */
  rebaseAt(sample: GpsSample): boolean {
    const last = this.points.at(-1);
    if (!last || this.pendingCount > 0 || sample.accuracy == null || sample.accuracy > MAX_FIELD_ACCURACY_METERS ||
        haversineMeters(sample, { lng: last[0], lat: last[1] }) > 25) return false;
    const anchor = { ...sample, lng: last[0], lat: last[1], accuracy: 3, timestamp: Math.floor(sample.timestamp / 1000) * 1000 - 1000 };
    this.fixes = [anchor];
    this.confirmedIndex = 0;
    this.roadSample = { ...anchor, timestamp: sample.timestamp };
    this.roadHint = undefined;
    this.gap = false;
    this.issue = "stationary";
    this.lastFixTimestamp = anchor.timestamp;
    return true;
  }

  /** Explicit user choice. Keep discarded measurements in the diagnostic journal. */
  finishConfirmedPart() {
    this.fixes = this.confirmedIndex == null ? [] : this.fixes.slice(0, this.confirmedIndex + 1);
    this.gap = false;
    this.issue = null;
    this.excludedTailAt = Date.now();
  }

  ingest(observation: DrivingTracePoint): boolean {
    if (observation.observedAt <= this.lastObservedAt) return false;
    this.lastObservedAt = observation.observedAt;
    const journalEntry: FieldGpsObservation = { ...observation, recordingReason: "pending" };
    this.observations.push(journalEntry);
    if (this.observations.length > 6000) {
      this.observations.shift();
      this.observationsComplete = false;
    }
    const raw = observation.raw;
    const reject = (issue: FieldRecordingIssue) => {
      journalEntry.recordingReason = `rejected_${issue}`;
      this.rejectedSamples += 1; this.issue = issue; return true;
    };
    if (!observation.visible || !observation.accepted || !raw || raw.accuracy == null || raw.accuracy > MAX_FIELD_ACCURACY_METERS) {
      return reject(observation.reason === "impossible_jump" ? "jump" : "accuracy");
    }
    if (Math.floor(raw.timestamp / 1000) <= Math.floor(this.lastFixTimestamp / 1000)) {
      journalEntry.recordingReason = "duplicate_second"; return true;
    }
    this.lastFixTimestamp = raw.timestamp;
    if (this.gap) return reject("gap");
    const previous = this.fixes.at(-1);
    if (previous) {
      const distance = haversineMeters(previous, raw);
      const seconds = Math.max(1, (raw.timestamp - previous.timestamp) / 1000);
      const noise = Math.max(8, Math.min(25, (previous.accuracy ?? 10) + raw.accuracy));
      const deviceStopped = raw.speedMps != null && raw.speedMps < 0.8 &&
        (previous.speedMps != null && previous.speedMps < 0.8 || this.stationaryCount > 0);
      const belowNoise = distance < Math.max(3, Math.min(12, raw.accuracy * 0.6));
      if (deviceStopped && distance > noise) return reject("jump");
      if ((deviceStopped && distance <= noise) || belowNoise) {
        journalEntry.recordingReason = "stationary";
        this.stationaryCount += 1;
        if (this.pendingCount === 0 && this.roadSample) {
          this.roadSample = { ...raw, lng: this.roadSample.lng, lat: this.roadSample.lat, heading: null };
          if (seconds > 10) this.rebaseAt(raw);
        }
        if (this.pendingCount === 0) this.issue = "stationary";
        return true;
      }
      const measuredSpeed = Math.max(raw.speedMps ?? 0, previous.speedMps ?? 0);
      const maximumTravel = raw.speedMps != null && previous.speedMps != null
        ? measuredSpeed * seconds * 1.8 + noise + 8
        : 190 / 3.6 * seconds + noise;
      if (seconds <= 10 && distance > Math.max(25, maximumTravel)) return reject("jump");
      if (seconds > 15) { this.gap = true; return reject("gap"); }
    } else if (this.points.length) {
      if (!this.rebaseAt(raw)) { this.gap = true; return reject("gap"); }
    }
    this.fixes.push(raw);
    this.acceptedSamples += 1;
    this.stationaryCount = 0;
    if (this.issue !== "unavailable" && this.issue !== "ambiguous" && this.issue !== "detour") this.issue = "waiting";
    return true;
  }

  request(finalize = false): RecordingMatchRequest | null {
    if ((!finalize && this.gap) || this.pendingCount === 0) return null;
    const startIndex = Math.max(0, (this.confirmedIndex ?? 0) - 3);
    const samples = this.fixes.slice(startIndex, startIndex + MAX_ROAD_MATCH_FIXES).map(s => ({ ...s }));
    if (samples.length < 3 || (!finalize && this.pendingCount < 3)) return null;
    const anchorIndex = this.confirmedIndex == null ? null : this.confirmedIndex - startIndex;
    const hints: (string | null)[] = samples.map(() => null);
    const anchorCoordinate: RoadCoordinate | null = this.roadSample ? [this.roadSample.lng, this.roadSample.lat] : null;
    if (anchorIndex != null && anchorCoordinate) {
      samples[anchorIndex] = { ...samples[anchorIndex], lng: anchorCoordinate[0], lat: anchorCoordinate[1], accuracy: 3 };
      hints[anchorIndex] = this.roadHint ?? null;
    }
    return { samples, hints, startIndex, anchorIndex,
      anchorTimestamp: this.confirmedIndex == null ? null : this.fixes[this.confirmedIndex].timestamp,
      anchorCoordinate, finalize: finalize && startIndex + samples.length === this.fixes.length };
  }

  confirm(request: RecordingMatchRequest, match: RoadTraceMatch): boolean {
    const result = confirmRoadSection(request.samples, match, request.anchorIndex, request.anchorCoordinate, request.finalize);
    if (!result.section) { this.issue = result.reason; return false; }
    const { section } = result;
    if (request.anchorTimestamp !== (this.confirmedIndex == null ? null : this.fixes[this.confirmedIndex].timestamp)) return false;
    const last = this.points.at(-1);
    if (last && haversineMeters({ lng: last[0], lat: last[1] }, { lng: section.coordinates[0][0], lat: section.coordinates[0][1] }) > 3) {
      this.issue = "gap"; return false;
    }
    this.points.push(...(last ? section.coordinates.slice(1) : section.coordinates));
    const endpointIndex = request.startIndex + section.endIndex;
    const raw = this.fixes[endpointIndex];
    const matchedFixes = new Map(request.samples.map((sample, i) => [sample.timestamp, match.tracepoints[i] != null]));
    for (const observation of this.observations) {
      if (observation.recordingReason === "pending" && observation.raw && observation.raw.timestamp <= raw.timestamp) {
        observation.recordingReason = matchedFixes.get(observation.raw.timestamp) ? "confirmed" : "match_outlier";
      }
    }
    this.roadSample = { ...raw, lng: section.endpoint.coordinate[0], lat: section.endpoint.coordinate[1] };
    this.roadHint = section.endpoint.hint;
    this.confirmedIndex = endpointIndex;
    const discard = Math.max(0, endpointIndex - 3);
    this.fixes = this.fixes.slice(discard);
    this.confirmedIndex -= discard;
    this.issue = this.pendingCount ? "waiting" : null;
    return true;
  }
}
