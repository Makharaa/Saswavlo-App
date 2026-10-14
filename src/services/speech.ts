import type { GeorgianTtsVoice } from "@/types/domain";
import { createSpeechDeliveryQueue } from "../utils/checkpoint-speech-delivery";
import type { CheckpointSpeechDeliveryOptions, RecordedSpeechResult } from "../utils/checkpoint-speech-delivery";
export type { CheckpointSpeechStatus, RecordedSpeechResult } from "../utils/checkpoint-speech-delivery";

export type TtsClientProvider = "server" | "browser";
const DEFAULT_VOICE: GeorgianTtsVoice = "ka-GE-EkaNeural";
let preferredProvider: TtsClientProvider = "server";
// Retained for callers of the old API. Driving always uses exact recordings;
// selecting a browser provider cannot silently synthesize a different voice.
export function setTtsClientProvider(provider: TtsClientProvider) { preferredProvider = provider; }
export function getTtsClientProvider() { return preferredProvider; }

const audioUrlCache = new Map<string, Promise<string | null>>();
let reusableAudio: HTMLAudioElement | null = null;
let playbackRequestId = 0;
let silentAudioUrl: string | null = null;

function audioElement() {
  if (!reusableAudio) {
    reusableAudio = new Audio();
    reusableAudio.preload = "auto";
  }
  return reusableAudio;
}
function pauseAudio() {
  if (!reusableAudio) return;
  reusableAudio.pause();
  try { reusableAudio.currentTime = 0; } catch { /* Metadata may not be ready. */ }
}
function abortError() { return new DOMException("Playback was cancelled.", "AbortError"); }
function awaitOperation<T>(operation: Promise<T>, signal?: AbortSignal, timeoutMs = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => {
      cleanup(); reject(new DOMException("Recorded audio timed out.", "TimeoutError"));
    }, timeoutMs);
    const cancelled = () => { cleanup(); reject(abortError()); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); };
    signal?.addEventListener("abort", cancelled, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
async function getAudioUrl(text: string, voice: GeorgianTtsVoice): Promise<string | null> {
  const key = `${voice}\n${text.trim()}`;
  const cached = audioUrlCache.get(key);
  if (cached) return cached;
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 8_000);
  const promise = (async () => {
    try {
      const response = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), voice }), signal: request.signal,
      });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error(`Recorded audio request failed (${response.status}).`);
      if (!(response.headers.get("content-type") || "").startsWith("audio/")) {
        throw new DOMException("The server did not return recorded audio.", "NotSupportedError");
      }
      const blob = await response.blob();
      if (!blob.size) throw new DOMException("The recording is empty.", "NotSupportedError");
      return URL.createObjectURL(blob);
    } finally { clearTimeout(timeout); }
  })();
  audioUrlCache.set(key, promise);
  try {
    const url = await promise;
    // New recordings can be deployed while a session is open. Keep successful
    // blobs, but retry 204 on an explicit retry/next readiness check.
    if (url == null) audioUrlCache.delete(key);
    return url;
  }
  catch (error) { audioUrlCache.delete(key); throw error; }
}

/** Starts playback on the same audio element during a direct user gesture. */
export async function unlockGeorgianSpeech(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const id = ++playbackRequestId;
  pauseAudio();
  const audio = audioElement();
  if (!silentAudioUrl) {
    // A short PCM clip is local, deterministic and contains no spoken words.
    const samples = 800;
    const bytes = new Uint8Array(44 + samples * 2);
    const data = new DataView(bytes.buffer);
    for (const [offset, word] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
      for (let i = 0; i < word.length; i += 1) bytes[offset + i] = word.charCodeAt(i);
    }
    data.setUint32(4, bytes.length - 8, true); data.setUint32(16, 16, true);
    data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, 8_000, true); data.setUint32(28, 16_000, true);
    data.setUint16(32, 2, true); data.setUint16(34, 16, true);
    data.setUint32(40, samples * 2, true);
    silentAudioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  }
  audio.muted = false;
  audio.src = silentAudioUrl;
  try {
    // play() is intentionally called before any await/fetch so the browser
    // observes the click, including on iOS. Later clips reuse this element.
    await awaitOperation(audio.play(), undefined, 3_000);
    if (id !== playbackRequestId) return false;
    pauseAudio();
    return true;
  } catch {
    if (id === playbackRequestId) pauseAudio();
    return false;
  }
}

/** Observes completion, not just the browser's play() start promise. */
function audioCompletion(audio: HTMLAudioElement, signal?: AbortSignal): Promise<boolean> {
  if (typeof audio.addEventListener !== "function") return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const done = (success: boolean) => {
      if (finished) return;
      finished = true;
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", failed);
      signal?.removeEventListener("abort", failed);
      clearTimeout(timeout);
      resolve(success);
    };
    const ended = () => done(true);
    const failed = () => done(false);
    audio.addEventListener("ended", ended, { once: true });
    audio.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", failed, { once: true });
    // The provided recording pack is short. Avoid leaving the queue stuck
    // indefinitely if a mobile browser never dispatches `ended`.
    const timeout = setTimeout(failed, 12_000);
    if (signal?.aborted) failed();
  });
}

export async function playRecordedGeorgian(
  text: string, voice: GeorgianTtsVoice = DEFAULT_VOICE, signal?: AbortSignal
): Promise<RecordedSpeechResult> {
  const clean = text.trim();
  if (!clean || typeof window === "undefined") return { status: "missing" };
  if (signal?.aborted) return { status: "cancelled" };
  const id = ++playbackRequestId;
  pauseAudio();
  const cancel = () => { if (id === playbackRequestId) pauseAudio(); };
  signal?.addEventListener("abort", cancel, { once: true });
  let playing = false;
  let keepCancellation = false;
  try {
    const url = await awaitOperation(getAudioUrl(clean, voice), signal);
    if (id !== playbackRequestId || signal?.aborted) return { status: "cancelled" };
    if (!url) return { status: "missing" };
    const audio = audioElement();
    audio.muted = false;
    audio.src = url;
    playing = true;
    await awaitOperation(audio.play(), signal, 5_000);
    if (id !== playbackRequestId || signal?.aborted) return { status: "cancelled" };
    keepCancellation = true;
    return typeof audio.addEventListener === "function"
      ? { status: "played", completion: audioCompletion(audio, signal).then((finished) => {
          signal?.removeEventListener("abort", cancel);
          return finished;
        }) }
      : { status: "played" };
  } catch (error) {
    if (id !== playbackRequestId || signal?.aborted) return { status: "cancelled" };
    if (playing) pauseAudio();
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError") return { status: "blocked" };
    if (name === "NotSupportedError") return { status: "failed" };
    // A server request timeout uses AbortError internally; only the caller's
    // signal represents deliberate cancellation. Retry real request failures.
    return { status: "network" };
  } finally {
    // The queue may still stop an already-started clip if the car reverses,
    // GPS becomes unsafe, or the session ends. The once listener is removed
    // when that delivery controller is aborted by a later checkpoint/reset.
    if (!keepCancellation) signal?.removeEventListener("abort", cancel);
  }
}

export async function speakGeorgian(text: string, voice: GeorgianTtsVoice = DEFAULT_VOICE) {
  const result = await playRecordedGeorgian(text, voice);
  return result.status === "played";
}

export function createCheckpointSpeechDelivery(options: CheckpointSpeechDeliveryOptions) {
  return createSpeechDeliveryQueue(options, {
    play: (request, signal) => playRecordedGeorgian(request.text, request.voice, signal),
    unlock: unlockGeorgianSpeech,
  });
}

export async function prefetchGeorgianSpeech(items: Array<{ text: string; voice?: GeorgianTtsVoice }>): Promise<{ missing: string[]; unverified: boolean }> {
  if (typeof window === "undefined") return { missing: [], unverified: true };
  const unique = [...new Map(items.filter((item) => item.text.trim()).map((item) => {
    const text = item.text.trim();
    const voice = item.voice ?? DEFAULT_VOICE;
    return [`${voice}\n${text}`, { text, voice }] as const;
  })).values()];
  const results = await Promise.allSettled(unique.map((item) => getAudioUrl(item.text, item.voice)));
  const missing = new Set<string>();
  let unverified = false;
  results.forEach((result, index) => {
    if (result.status === "rejected") unverified = true;
    else if (result.value == null) missing.add(unique[index].text);
  });
  return { missing: [...missing], unverified };
}
export function stopGeorgianSpeech() {
  playbackRequestId += 1;
  pauseAudio();
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

// Retained for DB/backward compatibility. The recorded voice pack itself
// maps exact Georgian phrases to files and ignores this legacy Azure field.
export const GEORGIAN_VOICE_OPTIONS: Array<{
  value: GeorgianTtsVoice;
  label: string;
}> = [
  {
    value: "ka-GE-EkaNeural",
    label: "ჩაწერილი ხმა",
  },
  {
    value: "ka-GE-GiorgiNeural",
    label: "ჩაწერილი ხმა",
  },
];

export async function getRecordedSpeechStatus(text: string) {
  const clean = text.trim();

  if (!clean) {
    return {
      available: false,
      fileName: null as string | null,
      phrase: null as string | null,
    };
  }

  const params = new URLSearchParams({
    text: clean,
    lang: "ka",
    meta: "1",
  });

  const response = await fetch(`/api/tts?${params.toString()}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    return {
      available: false,
      fileName: null as string | null,
      phrase: null as string | null,
    };
  }

  const body = await response.json();

  return {
    available: Boolean(body?.recorded?.available),
    fileName: body?.recorded?.fileName ?? null,
    phrase: body?.recorded?.phrase ?? null,
  };
}
