import { FieldRecordingBuffer } from "./field-recording";
import type { RecordingMatchRequest } from "./field-recording";
import type { RoadTraceMatch } from "./road-trace-match";

type MatchRequest = (request: RecordingMatchRequest, signal: AbortSignal) => Promise<RoadTraceMatch>;

/** Serial matching with generation checks: a late response cannot edit a new recording. */
export class FieldRecordingMatcher {
  generation = 0;
  matching = false;
  private abortController: AbortController | null = null;
  private pending: Promise<void> | null = null;

  constructor(public buffer: FieldRecordingBuffer, private requestMatch: MatchRequest, private onChange: () => void) {}

  invalidate() {
    this.generation += 1;
    this.abortController?.abort();
    this.pending = null;
    this.matching = false;
  }

  replace(buffer: FieldRecordingBuffer) {
    this.invalidate();
    this.buffer = buffer;
    this.onChange();
  }

  async process(finalize = false) {
    const token = this.generation;
    while (this.pending) {
      await this.pending;
      if (token !== this.generation) return;
    }
    if (token !== this.generation) return;
    for (let i = 0; i < (finalize ? 5 : 1); i += 1) {
      const current = this.buffer;
      const request = current.request(finalize);
      if (!request) return;
      const controller = new AbortController();
      this.abortController = controller;
      this.matching = true;
      this.onChange();
      const task = (async () => {
        try {
          const match = await this.requestMatch(request, controller.signal);
          if (token === this.generation) current.confirm(request, match);
        } catch {
          if (token === this.generation && !controller.signal.aborted) current.issue = "unavailable";
        } finally {
          if (token === this.generation) { this.matching = false; this.onChange(); }
        }
      })();
      this.pending = task;
      await task;
      if (this.pending === task) this.pending = null;
      if (token !== this.generation || (current.issue && current.issue !== "waiting")) return;
    }
  }
}
