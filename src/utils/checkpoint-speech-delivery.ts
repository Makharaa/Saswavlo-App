import type { GeorgianTtsVoice } from "../types/domain";

export type RecordedSpeechResult = {
  status: "played" | "missing" | "blocked" | "network" | "failed" | "cancelled";
  completion?: Promise<boolean>;
};
export type CheckpointSpeechStatus = {
  state: "idle" | "loading" | "playing" | "played" | "missing" | "blocked" | "network" | "failed";
  checkpointIndex: number | null;
  attempts: number;
};
export type CheckpointSpeechRequest = { index: number; text: string; voice?: GeorgianTtsVoice };

export interface CheckpointSpeechDeliveryOptions {
  /** Checks current location, direction and GPS quality immediately before playback. */
  isEligible(index: number): boolean;
  /** Session/window check, independent of temporary GPS quality. */
  isRelevant?(index: number): boolean;
  /**
   * Only for a clip whose play() already succeeded. Allows the last words of
   * a timely warning to finish after passing its start window; must still
   * reject an unsafe position/direction or inactive session.
   */
  canContinuePlayback?(index: number): boolean;
  onDelivered(index: number): void;
  onStatus?(status: CheckpointSpeechStatus): void;
}

interface DeliveryDependencies {
  play(request: CheckpointSpeechRequest, signal: AbortSignal): Promise<RecordedSpeechResult>;
  unlock(): Promise<boolean>;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * A live-delivery queue, separate from the evaluator's deterministic request history.
 * Only a successful play() promise acknowledges an instruction. There is never a
 * backlog of turns: a newer checkpoint replaces the old pending request.
 */
export function createSpeechDeliveryQueue(options: CheckpointSpeechDeliveryOptions, dependencies: DeliveryDependencies) {
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const maximumAgeMs = 20_000;
  const maximumAttempts = 3;
  let generation = 0;
  let pending: (CheckpointSpeechRequest & { createdAt: number; attempts: number; blocked: boolean }) | null = null;
  let abort: AbortController | null = null;
  let active: { index: number; controller: AbortController; startedAt: number } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStatus: CheckpointSpeechStatus = { state: "idle", checkpointIndex: null, attempts: 0 };
  const delivered = new Set<number>();
  const unavailable = new Map<number, CheckpointSpeechRequest>();

  function publish(state: CheckpointSpeechStatus["state"], index = pending?.index ?? null, attempts = pending?.attempts ?? 0) {
    currentStatus = { state, checkpointIndex: index, attempts };
    options.onStatus?.(currentStatus);
  }
  function interruptAttempt() {
    generation += 1;
    abort?.abort();
    abort = null;
    active?.controller.abort();
    active = null;
    if (retryTimer != null) clearTimer(retryTimer);
    retryTimer = null;
  }
  function relevant() {
    return pending != null && now() - pending.createdAt <= maximumAgeMs &&
      (options.isRelevant ?? options.isEligible)(pending.index);
  }
  function discard() {
    interruptAttempt();
    pending = null;
  }

  async function attempt() {
    if (!pending || abort || active || retryTimer != null || pending.blocked) return;
    if (!relevant()) { discard(); publish("idle"); return; }
    if (!options.isEligible(pending.index)) return;
    const request = pending;
    const run = ++generation;
    const controller = new AbortController();
    abort = controller;
    request.attempts += 1;
    publish("loading");
    let result: RecordedSpeechResult;
    try {
      result = await dependencies.play(request, controller.signal);
    } catch {
      result = { status: "network" };
    }
    if (run !== generation || pending !== request) return;
    abort = null;
    // The car can pass the marker or turn around while a file is loading.
    if (!relevant()) { controller.abort(); discard(); publish("idle"); return; }
    if (!options.isEligible(request.index)) {
      controller.abort();
      request.attempts = Math.max(0, request.attempts - 1);
      publish("idle");
      return;
    }
    if (result.status === "played") {
      if (result.completion) {
        active = { index: request.index, controller, startedAt: now() };
        publish("playing", request.index, request.attempts);
        void result.completion.then((finished) => {
          if (run !== generation || pending !== request) return;
          active = null;
          if (finished && !controller.signal.aborted) {
            delivered.add(request.index);
            pending = null;
            options.onDelivered(request.index);
            publish("played", request.index, request.attempts);
          } else if (!relevant()) {
            discard(); publish("idle");
          } else if (request.attempts >= maximumAttempts) {
            unavailable.set(request.index, request);
            pending = null;
            publish("failed", request.index, request.attempts);
          } else {
            publish("idle", request.index, request.attempts);
            if (options.isEligible(request.index)) void attempt();
          }
        }, () => {
          if (run !== generation || pending !== request) return;
          active = null;
          if (!relevant()) { discard(); publish("idle"); }
          else if (request.attempts < maximumAttempts && options.isEligible(request.index)) void attempt();
          else publish("failed", request.index, request.attempts);
        });
      } else {
        // Backward-compatible callback: only real media supplies completion.
        delivered.add(request.index);
        active = { index: request.index, controller, startedAt: now() };
        pending = null;
        options.onDelivered(request.index);
        publish("played", request.index, request.attempts);
      }
      return;
    }
    if (result.status === "blocked") {
      request.blocked = true;
      publish("blocked");
      return;
    }
    if (result.status === "missing" || result.status === "failed") {
      unavailable.set(request.index, request);
      pending = null;
      publish(result.status, request.index, request.attempts);
      return;
    }
    publish("network");
    if (request.attempts >= maximumAttempts) {
      unavailable.set(request.index, request);
      pending = null;
      return;
    }
    retryTimer = setTimer(() => { retryTimer = null; void attempt(); }, request.attempts === 1 ? 600 : 1_500);
  }

  function enqueue(index: number, text: string, voice?: GeorgianTtsVoice) {
    if (!text.trim() || delivered.has(index) || unavailable.has(index)) return;
    if (pending?.index === index) { update(); return; }
    discard();
    pending = { index, text: text.trim(), voice, createdAt: now(), attempts: 0, blocked: false };
    void attempt();
  }
  function update() {
    if (active && (now() - active.startedAt > 10_000 ||
        !(options.canContinuePlayback ? options.canContinuePlayback(active.index) :
          options.isEligible(active.index) && (options.isRelevant ?? options.isEligible)(active.index)))) {
      active.controller.abort();
      active = null;
    }
    if (!pending) return;
    if (!relevant()) { discard(); publish("idle"); return; }
    if (!options.isEligible(pending.index)) {
      // Suspend a still-relevant request through a brief GPS pause. No async
      // fetch/play completion can speak until a later safe observation.
      if (abort || retryTimer != null) {
        interruptAttempt();
        pending.attempts = Math.max(0, pending.attempts - 1);
        publish("idle");
      }
      return;
    }
    void attempt();
  }
  async function retryFromGesture() {
    // Call directly in the click handler, before its first asynchronous step.
    const previousStatus = currentStatus;
    interruptAttempt();
    const run = generation;
    const unlocked = await dependencies.unlock();
    if (run !== generation) return false;
    if (!unlocked) {
      publish("blocked", pending?.index ?? previousStatus.checkpointIndex, pending?.attempts ?? previousStatus.attempts);
      return false;
    }
    if (pending) {
      pending.blocked = false;
      pending.attempts = 0;
      update();
    } else if (currentStatus.checkpointIndex != null) {
      const request = unavailable.get(currentStatus.checkpointIndex);
      if (request && (options.isRelevant ?? options.isEligible)(request.index)) {
        unavailable.delete(request.index);
        enqueue(request.index, request.text, request.voice);
      } else {
        publish("idle");
      }
    } else {
      publish("idle");
    }
    return true;
  }
  function repeatFromGesture(index: number, text: string, voice?: GeorgianTtsVoice) {
    if (!text.trim() || !options.isEligible(index) || !(options.isRelevant ?? options.isEligible)(index)) return Promise.resolve(false);
    discard();
    delivered.delete(index);
    unavailable.delete(index);
    pending = { index, text: text.trim(), voice, createdAt: now(), attempts: 0, blocked: false };
    return retryFromGesture();
  }
  function stop() {
    discard();
    delivered.clear();
    unavailable.clear();
    publish("idle");
  }
  return { enqueue, update, retryFromGesture, repeatFromGesture, stop, getStatus: () => currentStatus };
}
