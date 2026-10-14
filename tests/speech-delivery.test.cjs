const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadSource(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : module.require(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const queueModule = loadSource("src/utils/checkpoint-speech-delivery.ts");
const { createSpeechDeliveryQueue } = queueModule;
const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function queueHarness(outcomes = [], canContinuePlayback) {
  let time = 0;
  let eligible = true;
  let relevant = true;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [], delivered = [], statuses = [];
  let unlocks = 0;
  const queue = createSpeechDeliveryQueue({
    isEligible: () => eligible, isRelevant: () => relevant, canContinuePlayback,
    onDelivered: (index) => delivered.push(index), onStatus: (status) => statuses.push(status),
  }, {
    play(request, signal) {
      requests.push({ ...request, signal });
      const outcome = outcomes.shift() ?? { status: "played" };
      return outcome.promise ?? Promise.resolve(outcome);
    },
    unlock() { unlocks += 1; return Promise.resolve(true); },
    now: () => time,
    setTimer(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    queue, requests, delivered, statuses, timers,
    get unlocks() { return unlocks; },
    setEligible(value) { eligible = value; }, setRelevant(value) { relevant = value; },
    advance(value) { time += value; },
    runNextTimer() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); time += timer.delay; timer.callback();
    },
  };
}

test("checkpoint is acknowledged only after its playback promise starts", async () => {
  const loading = deferred();
  const h = queueHarness([loading]);
  h.queue.enqueue(3, "გთხოვთ შეუხვიოთ მარცხნივ");
  assert.deepEqual(h.delivered, []);
  assert.equal(h.queue.getStatus().state, "loading");
  loading.resolve({ status: "played" }); await settle();
  assert.deepEqual(h.delivered, [3]);
  h.queue.enqueue(3, "გთხოვთ შეუხვიოთ მარცხნივ"); await settle();
  assert.equal(h.requests.length, 1);
});

test("transient request failure retries the same exact phrase while still relevant", async () => {
  const h = queueHarness([{ status: "network" }, { status: "played" }]);
  h.queue.enqueue(1, "500 მეტრში შეუხვიეთ მარცხნივ"); await settle();
  assert.deepEqual(h.delivered, []); assert.equal(h.timers.size, 1);
  h.runNextTimer(); await settle();
  assert.deepEqual(h.delivered, [1]);
  assert.deepEqual(h.requests.map((item) => item.text), ["500 მეტრში შეუხვიეთ მარცხნივ", "500 მეტრში შეუხვიეთ მარცხნივ"]);
  assert.equal(h.queue.getStatus().attempts, 2);
});

test("a newer checkpoint invalidates an older asynchronous playback result", async () => {
  const old = deferred();
  const h = queueHarness([old, { status: "played" }]);
  h.queue.enqueue(1, "ძველი");
  h.queue.enqueue(2, "ახალი"); await settle();
  assert.equal(h.requests[0].signal.aborted, true);
  old.resolve({ status: "played" }); await settle();
  assert.deepEqual(h.delivered, [2]);
});

test("GPS uncertainty suspends a request and rechecks current position before recovery", async () => {
  const old = deferred();
  const h = queueHarness([old, { status: "played" }]);
  h.queue.enqueue(2, "გთხოვთ შეუხვიოთ მარჯვნივ");
  h.setEligible(false); h.queue.update();
  assert.equal(h.requests[0].signal.aborted, true);
  old.resolve({ status: "played" }); await settle();
  assert.deepEqual(h.delivered, []);
  h.setEligible(true); h.queue.update(); await settle();
  assert.deepEqual(h.delivered, [2]);
});

test("eligibility is rechecked at asynchronous play completion before acknowledging", async () => {
  const loading = deferred(); const h = queueHarness([loading]);
  h.queue.enqueue(1, "მარცხნივ");
  h.setEligible(false);
  loading.resolve({ status: "played" }); await settle();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.deepEqual(h.delivered, []);
  h.setEligible(true); h.queue.update(); await settle();
  assert.deepEqual(h.delivered, [1]);
});

test("a passed checkpoint or expired request cannot retry after GPS/network recovery", async () => {
  for (const expiry of [false, true]) {
    const h = queueHarness([{ status: "network" }]);
    h.queue.enqueue(4, "მარჯვნივ"); await settle();
    if (expiry) h.advance(20_001); else h.setRelevant(false);
    h.queue.update();
    assert.equal(h.timers.size, 0);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.delivered, []);
  }
});

test("autoplay rejection remains visible and retries only from a fresh user gesture", async () => {
  const h = queueHarness([{ status: "blocked" }, { status: "played" }]);
  h.queue.enqueue(0, "მარცხნივ"); await settle();
  assert.equal(h.queue.getStatus().state, "blocked");
  h.queue.update(); await settle(); assert.equal(h.requests.length, 1);
  assert.equal(await h.queue.retryFromGesture(), true); await settle();
  assert.equal(h.unlocks, 1); assert.deepEqual(h.delivered, [0]);
});

test("missing exact500m-left is surfaced without acknowledging or substituting another recording", async () => {
  const h = queueHarness([{ status: "missing" }]);
  h.queue.enqueue(8, "500 მეტრში შეუხვიეთ მარცხნივ"); await settle();
  assert.equal(h.queue.getStatus().state, "missing");
  assert.equal(h.queue.getStatus().checkpointIndex, 8);
  h.queue.update(); h.queue.enqueue(8, "500 მეტრში შეუხვიეთ მარცხნივ"); await settle();
  assert.equal(h.requests.length, 1); assert.deepEqual(h.delivered, []);
});

test("network retries are bounded and ending a session invalidates its pending result", async () => {
  const h = queueHarness([{ status: "network" }, { status: "network" }, { status: "network" }]);
  h.queue.enqueue(7, "პირდაპირ"); await settle();
  h.runNextTimer(); await settle(); h.runNextTimer(); await settle();
  h.queue.update(); await settle();
  assert.equal(h.requests.length, 3); assert.equal(h.timers.size, 0);
  assert.equal(h.queue.getStatus().state, "network"); assert.deepEqual(h.delivered, []);
  const pending = deferred(), active = queueHarness([pending]);
  active.queue.enqueue(7, "პირდაპირ"); active.queue.stop();
  pending.resolve({ status: "played" }); await settle();
  assert.equal(active.requests[0].signal.aborted, true);
  assert.deepEqual(active.delivered, []);
});

test("an already started instruction is stopped when direction becomes unsafe", async () => {
  const h = queueHarness(); h.queue.enqueue(2, "მარჯვნივ"); await settle();
  assert.deepEqual(h.delivered, [2]); assert.equal(h.requests[0].signal.aborted, false);
  h.setEligible(false); h.queue.update(); assert.equal(h.requests[0].signal.aborted, true);
});

test("a timely started warning can finish beyond its start window but stops on reverse direction", async () => {
  let continuationSafe = true;
  const h = queueHarness([], () => continuationSafe);
  h.queue.enqueue(2, "300 მეტრში გთხოვთ შეუხვიოთ მარცხნივ"); await settle();
  h.setEligible(false); h.setRelevant(false); h.queue.update();
  assert.equal(h.requests[0].signal.aborted, false, "Passing the start window must not clip a correctly started sentence");
  continuationSafe = false; h.queue.update();
  assert.equal(h.requests[0].signal.aborted, true, "Reverse/unsafe direction must still stop it");

  const bounded = queueHarness([], () => true);
  bounded.queue.enqueue(2, "მარცხნივ"); await settle();
  bounded.advance(10_001); bounded.queue.update();
  assert.equal(bounded.requests[0].signal.aborted, true, "The continuation exception expires after ten seconds");
});

test("manual repeat unlocks immediately and remains owned by the safety-gated queue", async () => {
  const h = queueHarness(); h.queue.enqueue(1, "მარცხნივ"); await settle();
  const repeating = h.queue.repeatFromGesture(1, "მარცხნივ");
  assert.equal(h.unlocks, 1);
  assert.equal(await repeating, true); await settle();
  assert.deepEqual(h.delivered, [1, 1]);
  h.setEligible(false); h.queue.update();
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(await h.queue.repeatFromGesture(1, "მარცხნივ"), false);
  assert.equal(h.requests.length, 2); assert.equal(h.unlocks, 1);
});

test("ending a session while gesture unlock is pending suppresses its late retry", async () => {
  const unlocking = deferred(); const statuses = [], requests = [];
  const queue = createSpeechDeliveryQueue({
    isEligible: () => true, onDelivered: () => assert.fail("Ended session must not acknowledge"),
    onStatus: (status) => statuses.push(status),
  }, {
    play: async (request) => { requests.push(request); return { status: "played" }; },
    unlock: () => unlocking.promise,
  });
  const repeating = queue.repeatFromGesture(1, "მარცხნივ");
  queue.stop(); unlocking.resolve(true);
  assert.equal(await repeating, false); assert.equal(requests.length, 0);
  assert.equal(statuses.at(-1).state, "idle");
});

function browserHarness(fetchResponse, plays = []) {
  const originals = { window: global.window, Audio: global.Audio, fetch: global.fetch, createObjectURL: URL.createObjectURL };
  const audios = [], fetched = [], urls = [];
  const playStarted = deferred();
  global.window = {};
  global.Audio = class {
    constructor() { this.currentTime = 0; this.paused = false; this.plays = []; audios.push(this); }
    pause() { this.paused = true; }
    play() {
      this.paused = false; this.plays.push(this.src);
      playStarted.resolve();
      const outcome = plays.shift(); return outcome?.promise ?? (outcome ? Promise.reject(outcome) : Promise.resolve());
    }
  };
  URL.createObjectURL = (blob) => { const url = `blob:test-${urls.length}`; urls.push({ url, blob }); return url; };
  global.fetch = (url, input) => {
    fetched.push({ url, input });
    return typeof fetchResponse === "function" ? fetchResponse(url, input) : Promise.resolve(fetchResponse);
  };
  const speech = loadSource("src/services/speech.ts", { "../utils/checkpoint-speech-delivery": queueModule });
  return {
    speech, audios, fetched, urls, playStarted,
    restore() { global.window = originals.window; global.Audio = originals.Audio; global.fetch = originals.fetch; URL.createObjectURL = originals.createObjectURL; },
  };
}
const audioResponse = () => new Response(new Blob(["recording"], { type: "audio/mpeg" }), { headers: { "Content-Type": "audio/mpeg" } });

test("gesture unlock calls play synchronously and every later recording uses that same element", async () => {
  const h = browserHarness(() => Promise.resolve(audioResponse()));
  try {
    const unlocking = h.speech.unlockGeorgianSpeech();
    assert.equal(h.audios.length, 1); assert.equal(h.audios[0].plays.length, 1);
    assert.equal(h.fetched.length, 0); assert.equal(await unlocking, true);
    assert.deepEqual(await h.speech.playRecordedGeorgian("გთხოვთ შეუხვიოთ მარჯვნივ"), { status: "played" });
    assert.equal(h.audios.length, 1); assert.equal(h.audios[0].plays.length, 2);
    assert.equal(JSON.parse(h.fetched[0].input.body).text, "გთხოვთ შეუხვიოთ მარჯვნივ");
  } finally { h.restore(); }
});

test("204 reports missing and never starts arbitrary browser speech", async () => {
  const h = browserHarness(new Response(null, { status: 204 }));
  try {
    h.speech.setTtsClientProvider("browser");
    assert.deepEqual(await h.speech.playRecordedGeorgian("500 მეტრში შეუხვიეთ მარცხნივ"), { status: "missing" });
    assert.equal(await h.speech.speakGeorgian("500 მეტრში შეუხვიეთ მარცხნივ"), false);
    assert.equal(h.audios.length, 0); assert.equal(h.fetched.length, 2);
  } finally { h.restore(); }
});

test("blocked media playback is reported distinctly from a request failure", async () => {
  const h = browserHarness(() => Promise.resolve(audioResponse()), [new DOMException("Gesture required", "NotAllowedError")]);
  try {
    assert.deepEqual(await h.speech.playRecordedGeorgian("პირდაპირ"), { status: "blocked" });
    assert.equal(h.audios[0].paused, true);
  } finally { h.restore(); }
});

test("cancelling during a pending file fetch prevents it playing after the car passed", async () => {
  const download = deferred(); const h = browserHarness(() => download.promise);
  try {
    const controller = new AbortController();
    const playback = h.speech.playRecordedGeorgian("მარცხნივ", undefined, controller.signal);
    controller.abort();
    assert.deepEqual(await playback, { status: "cancelled" });
    download.resolve(audioResponse()); await settle();
    assert.equal(h.audios.length, 0);
  } finally { h.restore(); }
});

test("stopping while play is pending suppresses its late confirmation and preserves a newer clip", async () => {
  const pending = deferred(); const h = browserHarness(() => Promise.resolve(audioResponse()), [pending]);
  try {
    const first = h.speech.playRecordedGeorgian("მარცხნივ"); await h.playStarted.promise;
    h.speech.stopGeorgianSpeech(); assert.equal(h.audios[0].paused, true);
    assert.deepEqual(await h.speech.playRecordedGeorgian("პირდაპირ"), { status: "played" });
    pending.resolve();
    assert.deepEqual(await first, { status: "cancelled" });
    assert.equal(h.audios[0].paused, false);
  } finally { h.restore(); }
});

test("a failed fetch is evicted from cache so a bounded queue retry can fetch again", async () => {
  let attempts = 0;
  const h = browserHarness(() => Promise.resolve(attempts++ === 0 ? new Response("failure", { status: 503 }) : audioResponse()));
  try {
    assert.deepEqual(await h.speech.playRecordedGeorgian("პირდაპირ"), { status: "network" });
    assert.deepEqual(await h.speech.playRecordedGeorgian("პირდაპირ"), { status: "played" });
    assert.equal(h.fetched.length, 2);
  } finally { h.restore(); }
});

test("reversal cancellation can stop a clip even after play has resolved", async () => {
  const h = browserHarness(() => Promise.resolve(audioResponse()));
  try {
    const controller = new AbortController();
    assert.deepEqual(await h.speech.playRecordedGeorgian("მარჯვნივ", undefined, controller.signal), { status: "played" });
    assert.equal(h.audios[0].paused, false);
    controller.abort(); assert.equal(h.audios[0].paused, true);
  } finally { h.restore(); }
});

test("readiness deduplicates phrases and distinguishes missing recordings from an unverified server", async () => {
  const h = browserHarness((url, input) => {
    const { text } = JSON.parse(input.body);
    return Promise.resolve(text === "missing" ? new Response(null, { status: 204 }) :
      text === "fail" ? new Response("failure", { status: 503 }) : audioResponse());
  });
  try {
    assert.deepEqual(await h.speech.prefetchGeorgianSpeech([
      { text: "ready" }, { text: " ready " }, { text: "missing" }, { text: "fail" },
    ]), { missing: ["missing"], unverified: true });
    assert.equal(h.fetched.length, 3); assert.equal(h.audios.length, 0);
  } finally { h.restore(); }
});

test("a recording deployed after an earlier204 becomes available without reloading the page", async () => {
  let requests = 0;
  const h = browserHarness(() => Promise.resolve(requests++ === 0 ? new Response(null, { status: 204 }) : audioResponse()));
  try {
    assert.deepEqual(await h.speech.prefetchGeorgianSpeech([{ text: "500 მეტრში შეუხვიეთ მარცხნივ" }]),
      { missing: ["500 მეტრში შეუხვიეთ მარცხნივ"], unverified: false });
    assert.deepEqual(await h.speech.playRecordedGeorgian("500 მეტრში შეუხვიეთ მარცხნივ"), { status: "played" });
    assert.equal(h.fetched.length, 2);
  } finally { h.restore(); }
});

test("real playback is acknowledged only after the clip ends", async () => {
  const ending = deferred();
  const h = queueHarness([{ status: "played", completion: ending.promise }]);
  h.queue.enqueue(0, "მარჯვნივ"); await settle();
  assert.equal(h.queue.getStatus().state, "playing");
  assert.deepEqual(h.delivered, []);
  ending.resolve(true); await settle();
  assert.deepEqual(h.delivered, [0]);
  assert.equal(h.queue.getStatus().state, "played");
});

test("GPS interruption never acknowledges a partial recording; safe recovery retries only while relevant", async () => {
  const interrupted = deferred();
  const h = queueHarness([
    { status: "played", completion: interrupted.promise },
    { status: "played", completion: Promise.resolve(true) },
  ]);
  h.queue.enqueue(0, "300 მეტრში მოუხვიეთ მარცხნივ"); await settle();
  h.setEligible(false); h.queue.update();
  assert.equal(h.requests[0].signal.aborted, true);
  interrupted.resolve(false); await settle();
  assert.deepEqual(h.delivered, []);
  h.setEligible(true); h.queue.update(); await settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.delivered, [0]);
});

test("an interrupted recording is never replayed after leaving its valid checkpoint window", async () => {
  const interrupted = deferred();
  const h = queueHarness([{ status: "played", completion: interrupted.promise }]);
  h.queue.enqueue(0, "მარცხნივ"); await settle();
  h.setEligible(false); h.setRelevant(false); h.queue.update();
  interrupted.resolve(false); await settle();
  h.setEligible(true); h.queue.update(); await settle();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.delivered, []);
});

test("a real browser audio end event, not play() start, controls completion", async () => {
  const h = browserHarness(() => Promise.resolve(audioResponse()));
  const Original = global.Audio;
  global.Audio = class extends Original {
    constructor() { super(); this.events = new EventTarget(); }
    addEventListener(...args) { this.events.addEventListener(...args); }
    removeEventListener(...args) { this.events.removeEventListener(...args); }
    dispatchEvent(event) { return this.events.dispatchEvent(event); }
  };
  try {
    const playback = await h.speech.playRecordedGeorgian("მარცხნივ");
    assert.equal(playback.status, "played");
    assert.ok(playback.completion);
    h.audios[0].dispatchEvent(new Event("ended"));
    assert.equal(await playback.completion, true);
    const controller = new AbortController();
    const other = await h.speech.playRecordedGeorgian("მარჯვნივ", undefined, controller.signal);
    controller.abort();
    assert.equal(await other.completion, false);
    assert.equal(h.audios[0].paused, true);
  } finally { h.restore(); }
});
