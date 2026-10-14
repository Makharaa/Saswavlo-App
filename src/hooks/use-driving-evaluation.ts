"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DrivingEvent, DrivingTracePoint, ExamRoute } from "@/types/domain";
import { compileDrivingRoute, createEvaluationState, evaluateDrivingPoint, MAX_TRACE_POINTS, replayDrivingTrace } from "@/utils/driving-evaluator";
import { haversineMeters } from "@/utils/geo";
import { createGpsFilterState, filterGpsSample } from "@/utils/gps-filter";

export function useDrivingEvaluation(route: ExamRoute) {
  const compiled = useMemo(() => compileDrivingRoute(route), [route]);
  const stateRef = useRef(createEvaluationState());
  const [state, setState] = useState(stateRef.current);
  const [eventVersion, setEventVersion] = useState(0);
  const eventsRef = useRef<DrivingEvent[]>([]);
  const traceRef = useRef<DrivingTracePoint[]>([]);
  const traceCompleteRef = useRef(true);
  const lastLoggedPosition = useRef<{ lng: number; lat: number } | null>(null);
  const filterRef = useRef(createGpsFilterState());
  const recordEvent = useCallback((event: DrivingEvent) => {
    eventsRef.current.push(event);
    setEventVersion((value) => value + 1);
  }, []);
  const observe = useCallback((point: DrivingTracePoint) => {
    if (point.raw && point.evaluationTime == null) {
      const filtered = filterGpsSample(filterRef.current, point.raw, point.observedAt);
      filterRef.current = filtered.state;
      point = { ...point, sample: filtered.sample, accepted: filtered.sample != null, reason: filtered.reason };
    }
    if (traceRef.current.length < MAX_TRACE_POINTS) traceRef.current.push(point);
    else traceCompleteRef.current = false;
    const update = evaluateDrivingPoint(compiled, stateRef.current, point);
    stateRef.current = update.state;
    eventsRef.current.push(...update.events);
    if (point.accepted && point.visible && point.sample && update.state.quality !== "paused" &&
        (!lastLoggedPosition.current || haversineMeters(lastLoggedPosition.current, point.sample) >= 12)) {
      lastLoggedPosition.current = point.sample;
      eventsRef.current.push({ type: "position", timestamp: point.observedAt, lng: point.sample.lng, lat: point.sample.lat, value: update.state.speedKmh });
    }
    setState(update.state);
    setEventVersion((value) => value + 1);
    return update;
  }, [compiled]);
  const reset = useCallback(() => {
    stateRef.current = createEvaluationState();
    filterRef.current = createGpsFilterState();
    eventsRef.current = []; traceRef.current = []; traceCompleteRef.current = true; lastLoggedPosition.current = null;
    setState(stateRef.current); setEventVersion((value) => value + 1);
  }, []);
  const restore = useCallback((trace: DrivingTracePoint[], events: DrivingEvent[], complete: boolean) => {
    const replayed = replayDrivingTrace(compiled, trace, "real", complete);
    const pausePoint: DrivingTracePoint = { observedAt: Date.now(), raw: null, sample: null, accepted: false, reason: "paused", visible: true };
    const paused = evaluateDrivingPoint(compiled, replayed.state, pausePoint);
    filterRef.current = replayed.filterState;
    stateRef.current = paused.state; eventsRef.current = events; traceRef.current = [...trace]; traceCompleteRef.current = complete;
    if (traceRef.current.length < MAX_TRACE_POINTS) traceRef.current.push(pausePoint); else traceCompleteRef.current = false;
    lastLoggedPosition.current = null;
    setState(paused.state); setEventVersion((value) => value + 1);
  }, [compiled]);
  return { compiled, state, stateRef, eventsRef, traceRef, traceCompleteRef, eventVersion, observe, reset, restore, recordEvent };
}
