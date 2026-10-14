"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DrivingTracePoint } from "@/types/domain";
import { routeLengthMeters } from "@/utils/geo";
import { FieldRecordingBuffer } from "@/utils/field-recording";
import { FieldRecordingMatcher } from "@/utils/field-recording-matcher";
import type { FieldRecordingSnapshot } from "@/utils/field-recording";
import { mapEngineService } from "@/services/map-engine";

export function useRouteRecorder(observation: DrivingTracePoint | null) {
  const active = useRef({ recording: false, paused: false });
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const activeSince = useRef<number | null>(null);
  const accumulatedMs = useRef(0);
  const latestObservation = useRef(observation);
  latestObservation.current = observation;
  const publish = useCallback(() => setRevision(v => v + 1), []);

  const matcherRef = useRef<FieldRecordingMatcher | null>(null);
  matcherRef.current ??= new FieldRecordingMatcher(new FieldRecordingBuffer(),
    (request, signal) => mapEngineService.match(request.samples, { hints: request.hints, signal }), publish);
  const matcher = matcherRef.current;
  const processMatches = useCallback((finalize = false) => matcher.process(finalize), [matcher]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(Date.now());
      if (active.current.recording && !active.current.paused && !matcher.matching) void processMatches(matcher.buffer.stationaryCount >= 2);
    }, 2000);
    return () => { window.clearInterval(timer); matcher.invalidate(); };
  }, [matcher, processMatches]);

  useEffect(() => {
    if (!active.current.recording || active.current.paused || !observation) return;
    if (matcher.buffer.ingest(observation)) publish();
  }, [matcher, observation, publish, recording, paused]);

  function changeClock() {
    if (activeSince.current != null) accumulatedMs.current += Date.now() - activeSince.current;
    activeSince.current = null;
  }
  function freshFix() {
    const observation = latestObservation.current;
    const fix = observation?.accepted && observation.visible ? observation.raw : null;
    return fix && Date.now() - fix.timestamp <= 8000 && fix.timestamp <= Date.now() + 1000 ? fix : null;
  }
  function replaceBuffer(next: FieldRecordingBuffer) { matcher.replace(next); }
  function startNew() {
    replaceBuffer(new FieldRecordingBuffer());
    accumulatedMs.current = 0; activeSince.current = Date.now();
    active.current = { recording: true, paused: false };
    setRecording(true); setPaused(false);
  }
  async function startFrom(points: [number, number][], snapshot?: FieldRecordingSnapshot) {
    replaceBuffer(new FieldRecordingBuffer(points, snapshot));
    const token = matcher.generation;
    active.current = { recording: true, paused: true };
    setRecording(true); setPaused(true); accumulatedMs.current = 0;
    await processMatches(true);
    if (token !== matcher.generation) return;
    const fix = freshFix();
    if (fix && matcher.buffer.pendingCount === 0 && matcher.buffer.rebaseAt(fix)) {
      active.current.paused = false; setPaused(false); activeSince.current = Date.now();
    }
    publish();
  }
  async function pause() {
    if (!active.current.recording || active.current.paused) return;
    changeClock(); active.current.paused = true; setPaused(true);
    await processMatches(true);
  }
  async function resume() {
    if (!active.current.recording || !active.current.paused) return;
    const token = matcher.generation;
    await processMatches(true);
    if (token !== matcher.generation) return;
    const fix = freshFix();
    if (!fix || matcher.buffer.pendingCount || (matcher.buffer.points.length && !matcher.buffer.rebaseAt(fix))) {
      matcher.buffer.issue = matcher.buffer.pendingCount ? "ambiguous" : "gap"; publish(); return;
    }
    activeSince.current = Date.now(); active.current.paused = false; setPaused(false); publish();
  }
  async function stop() {
    changeClock(); active.current = { recording: false, paused: false };
    setRecording(false); setPaused(false);
    await processMatches(true);
  }
  async function flush() {
    const token = matcher.generation;
    await processMatches(true);
    if (token !== matcher.generation) throw new Error("ჩანაწერი შეიცვალა — შენახვა შეჩერებულია.");
    if (matcher.buffer.gap || matcher.buffer.pendingCount) throw new Error("მონაკვეთი ჯერ დაუდასტურებელია. GPS ჩანაწერი შენარჩუნებულია — სცადე გზაზე მიბმა ხელახლა ან გადაამოწმე ჩანაწერი.");
    return [...matcher.buffer.points];
  }
  function setPoints(points: [number, number][]) {
    matcher.buffer.points = points.map(c => [...c]);
    publish();
  }
  function reset() {
    replaceBuffer(new FieldRecordingBuffer()); accumulatedMs.current = 0; activeSince.current = null;
    active.current = { recording: false, paused: false }; setRecording(false); setPaused(false);
  }
  function finishConfirmedPart() {
    matcher.invalidate(); matcher.buffer.finishConfirmedPart(); publish();
  }
  const durationMs = accumulatedMs.current + (recording && !paused && activeSince.current != null ? Math.max(0, clock - activeSince.current) : 0);
  return { recording, paused, revision, matching: matcher.matching, points: matcher.buffer.points, roadSample: matcher.buffer.roadSample,
    issue: matcher.buffer.issue, hasGap: matcher.buffer.gap, pendingCount: matcher.buffer.pendingCount, snapshot: () => matcher.buffer.snapshot(),
    startNew, startFrom, pause, resume, stop, flush, retryMatching: () => processMatches(true), finishConfirmedPart, setPoints, reset,
    stats: { acceptedSamples: matcher.buffer.acceptedSamples, rejectedSamples: matcher.buffer.rejectedSamples,
      distanceMeters: routeLengthMeters(matcher.buffer.points), durationSeconds: Math.floor(durationMs / 1000) } };
}
