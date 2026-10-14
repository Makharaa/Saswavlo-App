"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import * as maplibregl from "maplibre-gl";
import { Map, Marker } from "maplibre-gl";
import { configureMapLibreWorker } from "@/utils/maplibre-runtime";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Gauge,
  History,
  MapPinned,
  Satellite,
  Sparkles,
  LocateFixed,
  Navigation,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Route as RouteIcon,
  ShieldCheck,
  Volume2,
  X,
} from "lucide-react";

import { Badge, Button, Metric, Surface } from "@/components/ui";
import { MapThemeControl } from "@/components/map-theme-control";
import { useLiveLocation } from "@/hooks/use-live-location";
import { useDrivingEvaluation } from "@/hooks/use-driving-evaluation";
import { EVALUATION_VERSION } from "@/utils/driving-evaluator";
import { nextSimulationStep } from "@/utils/driving-simulation";
import { checkpointSpeechInWindow, checkpointSpeechToResume, resumedCheckpointSpeechDecision } from "@/utils/checkpoint-speech-policy";
import { activeSessionKey } from "@/services/sessions";
import { readActiveSnapshot, saveActiveSnapshot, removeActiveSnapshot } from "@/services/session-store";
import { useMapTheme } from "@/hooks/use-map-theme";
import { installNavigationMapStyle } from "@/utils/maplibre-style-guard";
import { addNavigationRouteLayers } from "@/utils/navigation-route-style";
import { markerScreenOffsetForStripe, NAVIGATION_STRIPE_OFFSET_PX } from "@/utils/navigation-route-offset";
import { sessionService } from "@/services/sessions";
import { createCheckpointSpeechDelivery, prefetchGeorgianSpeech, speakGeorgian, stopGeorgianSpeech, unlockGeorgianSpeech } from "@/services/speech";
import type { CheckpointSpeechStatus } from "@/services/speech";
import { EXAM_FINISH_RECORDED_PHRASE, getRecordedCheckpointPrompt } from "@/lib/recorded-voice-catalog";
import type {
  DriveAssistMode,
  DriveMode,
  DrivingEvent,
  DrivingSessionResult,
  DrivingTracePoint,
  GpsSample,
  ExamRoute,
  GeoPoint,
  RouteCheckpoint,
  RouteDraft,
} from "@/types/domain";
import {
  speedLimitAtRouteIndex,
} from "@/utils/route-engine";
import {
  bearingDegrees,
  haversineMeters,
  interpolatePoint,
  metersPerSecondToKmh,
  nearestPointOnRoute,
} from "@/utils/geo";

const SIMULATION_MULTIPLIERS = [1, 2, 4, 6] as const;
type SimulationMultiplier = (typeof SIMULATION_MULTIPLIERS)[number];

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

type ResumeSnapshot = {
  clientSessionId?: string;
  routeId: number | null;
  routeVersion?: number | null;
  routeSnapshot?: RouteDraft;
  assistMode: DriveAssistMode;
  startedAt: number;
  activeCheckpointIndex: number;
  distanceMeters: number;
  maxSpeedKmh: number;
  events: DrivingEvent[];
  trace: DrivingTracePoint[];
  traceComplete: boolean;
};

function instructionIcon(type: RouteCheckpoint["type"]) {
  if (type === "left") return "↰";
  if (type === "right") return "↱";
  if (type === "stop") return "■";
  if (type === "warning") return "!";
  return "↑";
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function createClientSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function gpsQuality(accuracy: number | null | undefined) {
  if (accuracy == null) return { label: "GPS-ის მოლოდინი", tone: "warning" as const };
  if (accuracy <= 8) return { label: `GPS მაღალი სიზუსტით ±${Math.round(accuracy)}მ`, tone: "success" as const };
  if (accuracy <= 18) return { label: `GPS კარგი სიზუსტით ±${Math.round(accuracy)}მ`, tone: "neutral" as const };
  return { label: `GPS სუსტი სიზუსტით ±${Math.round(accuracy)}მ`, tone: "warning" as const };
}

export function DrivingExperience({
  route,
  onSessionStateChange,
  routeSelector,
}: {
  route: ExamRoute;
  onSessionStateChange?: (locked: boolean) => void;
  routeSelector?: ReactNode;
}) {
  const router = useRouter();
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const carMarker = useRef<Marker | null>(null);
  const checkpointMarker = useRef<Marker | null>(null);
  const lastCameraUpdateAt = useRef(0);
  const lastCompletedRouteUpdateAt = useRef(0);
  const simulationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simulationMultiplierRef = useRef<SimulationMultiplier>(1);
  const finishing = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const clientSessionIdRef = useRef<string>("");
  const sessionRouteVersionRef = useRef<number | null>(route.version ?? null);
  const sessionModeRef = useRef<DriveMode>("real");
  const sessionAssistModeRef = useRef<DriveAssistMode>("practice");

  const gps = useLiveLocation({ maxAcceptedAccuracyMeters: 35, staleAfterMs: 8_000 });

  const [mode, setMode] = useState<DriveMode>("real");
  const [assistMode, setAssistMode] = useState<DriveAssistMode>("practice");
  const [started, setStarted] = useState(false);
  const [awaitingRealStart, setAwaitingRealStart] = useState(false);
  const [startGateDistance, setStartGateDistance] = useState<number | null>(null);
  const [simIndex, setSimIndex] = useState(0);
  const [simSpeed, setSimSpeed] = useState(0);
  const [simulationMultiplier, setSimulationMultiplier] =
    useState<SimulationMultiplier>(1);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  const { mode: mapThemeMode, resolvedTheme, styleUrl, setMode: setMapThemeMode } = useMapTheme();
  const evaluator = useDrivingEvaluation(route);
  const speechSessionActive = useRef(false);
  const speechUnlocked = useRef(false);
  const sessionStartGeneration = useRef(0);
  const lastSpeechObservationAt = useRef(0);
  const resumedSpeechIndex = useRef<number | null>(null);
  const deliveredInstructions = useRef(new Set<number>());
  const [speechStatus, setSpeechStatus] = useState<CheckpointSpeechStatus>({ state: "idle", checkpointIndex: null, attempts: 0 });
  const [recordingReadiness, setRecordingReadiness] = useState<{ missing: string[]; unverified: boolean }>({ missing: [], unverified: false });
  const speechDelivery = useMemo(() => {
    const isSafe = () => {
      const state = evaluator.stateRef.current;
      return speechSessionActive.current && !finishing.current && document.visibilityState === "visible" &&
        Date.now() - lastSpeechObservationAt.current <= 8_000 &&
        state.quality === "usable" && !state.gap &&
        (state.direction === "forward" || state.direction === "stationary") &&
        state.match != null && state.lastPosition?.accuracy != null &&
        state.match.distance <= Math.max(18, state.lastPosition.accuracy * 1.5);
    };
    const isRelevant = (index: number) => {
      const state = evaluator.stateRef.current;
      return speechSessionActive.current && !finishing.current && checkpointSpeechInWindow(evaluator.compiled, state, index);
    };
    // Starting a hint still requires a clean fix. Once the recording is
    // already playing, a single uncertain heading at the turn must not cut
    // the sentence. Confirmed reverse travel and an ended session still stop it.
    const canContinuePlayback = () => {
      const state = evaluator.stateRef.current;
      return speechSessionActive.current && !finishing.current && document.visibilityState === "visible" &&
        !state.reverseActive;
    };
    return createCheckpointSpeechDelivery({
      isRelevant,
      isEligible: (index) => isRelevant(index) && isSafe(),
      canContinuePlayback,
      onDelivered: (index) => { deliveredInstructions.current.add(index); },
      onStatus: setSpeechStatus,
    });
  }, [evaluator.compiled, evaluator.stateRef]);
  const evaluation = evaluator.state;
  const activeCheckpointIndex = evaluation.activeCheckpointIndex;
  const sessionEvents = evaluator.eventsRef;
  const recordEvent = evaluator.recordEvent;
  const eventVersion = evaluator.eventVersion;
  const lastObservation = useRef<DrivingTracePoint | null>(null);
  const lastPersistedAt = useRef(0);
  const simulationIndexRef = useRef(0);
  const simulationClockRef = useRef(0);
  const [simulationSample, setSimulationSample] = useState<GpsSample | null>(null);
  const [simulationPaused, setSimulationPaused] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const [saveError, setSaveError] = useState("");
  const [result, setResult] = useState<DrivingSessionResult | null>(null);
  const [savedSessionId, setSavedSessionId] = useState<number | null>(null);
  const [savingResult, setSavingResult] = useState(false);
  const [resultQueued, setResultQueued] = useState(false);
  const [resultDownloaded, setResultDownloaded] = useState(false);
  const resultCanClose = !savingResult && Boolean(savedSessionId || resultQueued || resultDownloaded);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot | null>(null);
  const resumeCompatible = resumeSnapshot?.routeVersion === route.version && resumeSnapshot?.routeId === (route.id ?? null);

  useEffect(() => {
    const locked =
      started ||
      simulationPaused ||
      awaitingRealStart ||
      startGateDistance != null ||
      result != null;
    onSessionStateChange?.(locked);
  }, [
    awaitingRealStart,
    simulationPaused,
    onSessionStateChange,
    result,
    startGateDistance,
    started,
  ]);

  useEffect(() => {
    return () => onSessionStateChange?.(false);
  }, [onSessionStateChange]);

  const sessionStartedAt = useRef<number | null>(null);
  const orderedCheckpoints = useMemo(
    () => [...route.checkpoints].sort((a, b) => a.orderIndex - b.orderIndex),
    [route.checkpoints]
  );

  useEffect(() => {
    simulationMultiplierRef.current = simulationMultiplier;
  }, [simulationMultiplier]);

  useEffect(() => {
    const online = () => {
      setIsOnline(true);
      void sessionService.flushPending();
    };
    const offline = () => setIsOnline(false);

    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    void sessionService.flushPending();

    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function requestWakeLock() {
      if (!started || document.visibilityState !== "visible") return;
      const nav = navigator as WakeLockNavigator;
      if (!nav.wakeLock?.request) return;
      try {
        const sentinel = await nav.wakeLock.request("screen");
        if (cancelled || !started) {
          await sentinel.release().catch(() => undefined);
          return;
        }
        wakeLockRef.current = sentinel;
      } catch {
        // Screen Wake Lock is optional and can be denied by the browser.
      }
    }

    async function releaseWakeLock() {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock) await lock.release().catch(() => undefined);
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible" && started) {
        void requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (started) void requestWakeLock();
    else void releaseWakeLock();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void releaseWakeLock();
    };
  }, [started]);


  useEffect(() => {
    let cancelled = false;
    setRecordingReadiness({ missing: [], unverified: false });
    void prefetchGeorgianSpeech(orderedCheckpoints.flatMap((checkpoint) => (
      checkpoint.voice.trim() ? [{ text: checkpoint.voice, voice: checkpoint.ttsVoice }] : []
    ))).then((readiness) => { if (!cancelled) setRecordingReadiness(readiness); });
    return () => { cancelled = true; };
  }, [orderedCheckpoints]);

  const simulationPath = evaluator.compiled.path;
  const laneDisplayPath = simulationPath;
  const checkpointPathIndexes = evaluator.compiled.checkpoints.map((point) => point.pathIndex);
  const rawPosition = mode === "real" ? started ? evaluation.lastPosition ?? gps.sample : gps.sample : simulationSample;
  const gpsUsable = mode !== "real" || Boolean(gps.sample && !gps.error && !gps.diagnostics.isStale && gps.sample.accuracy != null && gps.sample.accuracy <= 35);
  const routeMatch = evaluation.match ?? (rawPosition ? nearestPointOnRoute(rawPosition, simulationPath, evaluator.compiled.cumulative) : null);
  const displayPosition = rawPosition && routeMatch && evaluation.quality === "usable" && routeMatch.distance <= Math.max(10, Math.min(25, (rawPosition.accuracy ?? 10) * 1.5)) ? routeMatch.point : rawPosition;
  const routeProgressIndex = routeMatch?.index ?? 0;
  const routeProgressPercent = evaluator.compiled.total > 0 ? Math.min(100, evaluation.progressMeters / evaluator.compiled.total * 100) : 0;
  const speed = mode === "real" ? metersPerSecondToKmh(gps.sample?.speedMps) : simSpeed;
  const oppositeTravelDirection = evaluation.direction === "reverse";
  const activeCheckpoint = orderedCheckpoints[activeCheckpointIndex] ?? null;
  const nextCheckpoint = orderedCheckpoints[activeCheckpointIndex + 1] ?? null;
  const remainingPercent = Math.max(0, 100 - routeProgressPercent);
  const activeCheckpointDistance = rawPosition && activeCheckpoint ? haversineMeters(rawPosition, activeCheckpoint) : null;
  const currentSpeedLimit = started ? evaluation.currentSpeedLimit : speedLimitAtRouteIndex(route.speedZones, 0, null);
  const offRouteMeters = routeMatch?.distance ?? 0;
  const completed = evaluation.completed.length;
  const speedingCount = sessionEvents.current.filter((e) => e.type === "speeding").length;
  const offRouteCount = sessionEvents.current.filter((e) => e.type === "off_route").length;
  const quality = gpsQuality(gps.sample?.accuracy);

  const consumeObservation = useCallback((point: DrivingTracePoint) => {
    const previous = evaluator.stateRef.current;
    const update = evaluator.observe(point);
    lastSpeechObservationAt.current = point.observedAt;
    speechDelivery.update();
    for (const index of update.instructions) {
      const checkpoint = evaluator.compiled.checkpoints[index]?.checkpoint;
      if (checkpoint?.voice.trim()) speechDelivery.enqueue(index, checkpoint.voice, checkpoint.ttsVoice);
    }
    if (resumedSpeechIndex.current != null) {
      const index = resumedSpeechIndex.current;
      const decision = resumedCheckpointSpeechDecision(evaluator.compiled, previous, update.state, index);
      if (decision !== "wait") resumedSpeechIndex.current = null;
      if (decision === "retry") {
        const checkpoint = evaluator.compiled.checkpoints[index]?.checkpoint;
        if (checkpoint?.voice.trim()) speechDelivery.enqueue(index, checkpoint.voice, checkpoint.ttsVoice);
      }
    }
  }, [evaluator.observe, evaluator.compiled, speechDelivery]);

  useEffect(() => {
    if (!started || mode !== "real" || !gps.observation || gps.observation === lastObservation.current || finishing.current) return;
    lastObservation.current = gps.observation;
    consumeObservation(gps.observation);
  }, [consumeObservation, gps.observation, mode, started]);

  useEffect(() => {
    if (!started || mode !== "real" || (!gps.diagnostics.isStale && !gps.error)) return;
    consumeObservation({ observedAt: Date.now(), raw: null, sample: null, accepted: false, reason: gps.error ? "unavailable" : "stale", visible: document.visibilityState === "visible" });
  }, [consumeObservation, gps.diagnostics.isStale, gps.error, mode, started]);

  useEffect(() => {
    const hidden = () => {
      if (!started || document.visibilityState === "visible") return;
      resumedSpeechIndex.current = checkpointSpeechToResume(evaluator.stateRef.current);
      consumeObservation({ observedAt: Date.now(), raw: null, sample: null, accepted: false, reason: "hidden", visible: false,
        evaluationTime: mode === "simulation" ? simulationClockRef.current : undefined });
      if (mode === "simulation") {
        if (simulationTimer.current) clearTimeout(simulationTimer.current);
        simulationTimer.current = null;
        speechSessionActive.current = false;
        setSimulationPaused(true); setStarted(false); setSimSpeed(0);
      }
      if (mode === "real") persistActiveSession(true);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [consumeObservation, mode, started]);

  useEffect(() => {
    let cancelled = false;
    const key = activeSessionKey(route.id ?? null);
    if (key) void readActiveSnapshot<ResumeSnapshot>(key).then((snapshot) => {
      if (cancelled || !snapshot) return;
      setResumeSnapshot(snapshot);
      if (snapshot.routeVersion !== route.version || snapshot.routeId !== (route.id ?? null)) setStorageWarning("მარშრუტის ვერსია შეიცვალა; ძველი ჩანაწერი შეგიძლია ჩამოტვირთო. ახალ ვერსიაზე გაგრძელება შეუძლებელია.");
    }).catch((error) => { if (!cancelled) setStorageWarning(error instanceof Error ? error.message : "აღდგენის ჩანაწერი ვერ ჩაიტვირთა."); });
    return () => { cancelled = true; };
  }, [route.id, route.version]);

  function persistActiveSession(force = false) {
    if (!started || mode !== "real" || !sessionStartedAt.current || finishing.current) return;
    if (!force && Date.now() - lastPersistedAt.current < 5_000) return;
    lastPersistedAt.current = Date.now();
    const key = activeSessionKey(route.id ?? null);
    if (!key) { setStorageWarning("აღდგენის ჩანაწერის შესანახად ანგარიშის ამოცნობა ვერ მოხერხდა."); return; }
    const snapshot: ResumeSnapshot = {
      clientSessionId: clientSessionIdRef.current, routeId: route.id ?? null, routeVersion: sessionRouteVersionRef.current,
      routeSnapshot: route,
      assistMode, startedAt: sessionStartedAt.current, activeCheckpointIndex,
      distanceMeters: evaluator.stateRef.current.distanceMeters, maxSpeedKmh: evaluator.stateRef.current.maxSpeedKmh,
      events: [...sessionEvents.current], trace: [...evaluator.traceRef.current], traceComplete: evaluator.traceCompleteRef.current,
    };
    void saveActiveSnapshot(key, snapshot).catch((error) => setStorageWarning(error instanceof Error ? error.message : "აღდგენის ჩანაწერი ვერ შეინახა."));
  }
  useEffect(() => { persistActiveSession(); }, [activeCheckpointIndex, assistMode, eventVersion, mode, route.id, started]);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    const center: [number, number] = route.coordinates[0] ?? [44.11, 41.98];
    configureMapLibreWorker();
    const map = new maplibregl.Map({
      container: mapEl.current,
      center,
      zoom: 15.2,
      pitch: 0,
      bearing: 0,
      renderWorldCopies: false,
    });

    const disposeNavigationMapStyle = installNavigationMapStyle(map, styleUrl);

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    map.on("load", () => {
      map.addSource("drive-route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: laneDisplayPath } },
      });

      // The driving map and route studio share these exact visual layers.
      // GPS, checkpoint positions and route coordinates stay unshifted.
      addNavigationRouteLayers(map, "drive-route", "drive-route");

      map.addSource("drive-route-completed", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [laneDisplayPath[0] ?? center, laneDisplayPath[0] ?? center] },
        },
      });
      map.addLayer({
        id: "drive-route-completed-line",
        type: "line",
        source: "drive-route-completed",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#22c995",
          "line-width": 5,
          "line-offset": NAVIGATION_STRIPE_OFFSET_PX,
          "line-opacity": 1,
        },
      });

      const el = document.createElement("div");
      el.className = "live-location-dot live-direction-marker";
      el.innerHTML = `
        <span class="live-location-dot-pulse" aria-hidden="true"></span>
        <span class="live-direction-arrow" aria-hidden="true">
          <svg viewBox="0 0 40 44" focusable="false">
            <path d="M20 2 37 41 20 32 3 41Z" fill="#27d6a2" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" />
          </svg>
        </span>
      `;
      carMarker.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
      })
        .setLngLat(center)
        .addTo(map);

      const checkpointEl = document.createElement("div");
      checkpointEl.className = "active-checkpoint-marker";
      checkpointMarker.current = new maplibregl.Marker({
        element: checkpointEl,
        anchor: "center",
      })
        .setLngLat(center)
        .addTo(map);
    });

    mapRef.current = map;
    return () => {
      carMarker.current?.remove();
      carMarker.current = null;
      checkpointMarker.current?.remove();
      checkpointMarker.current = null;
      disposeNavigationMapStyle();
      map.remove();
      mapRef.current = null;
    };
  }, [laneDisplayPath, route.id, styleUrl]);

  useEffect(() => {
    if (!displayPosition || !mapRef.current || !carMarker.current) return;

    const map = mapRef.current;
    const coord: [number, number] = [displayPosition.lng, displayPosition.lat];
    carMarker.current.setLngLat(coord);
    // In the previous release the road stripe was shifted by 7 px, but the
    // vehicle marker remained on the centerline. Offset VISUAL marker only.
    // Do not modify GPS position, checkpoint matching, or session trace.
    const updateMarkerVisualOffset = () => {
      if (!carMarker.current) return;
      const isOnRoute = routeMatch && routeMatch.distance <= Math.max(10, Math.min(25, (rawPosition?.accuracy ?? 10) * 1.5));
      const offset = isOnRoute
        ? markerScreenOffsetForStripe(laneDisplayPath, routeMatch.segmentIndex, (coordinate) => map.project([coordinate[0], coordinate[1]]))
        : [0, 0] as [number, number];
      carMarker.current.setOffset(offset);
    };
    updateMarkerVisualOffset();
    map.on("move", updateMarkerVisualOffset);

    if (activeCheckpoint && checkpointMarker.current) {
      checkpointMarker.current
        .setLngLat([activeCheckpoint.lng, activeCheckpoint.lat])
        .getElement()
        .classList.remove("checkpoint-hidden");
    } else if (checkpointMarker.current) {
      checkpointMarker.current.getElement().classList.add("checkpoint-hidden");
    }

    const completedSource = map.getSource(
      "drive-route-completed"
    ) as maplibregl.GeoJSONSource | undefined;

    const now = performance.now();
    const completedUpdateInterval =
      mode === "simulation" ? 280 : 500;

    if (
      completedSource &&
      routeProgressIndex >= 0 &&
      now - lastCompletedRouteUpdateAt.current >= completedUpdateInterval
    ) {
      lastCompletedRouteUpdateAt.current = now;

      const completedCoordinates = laneDisplayPath.slice(
        0,
        Math.min(simulationPath.length, routeProgressIndex + 1)
      );

      const safeCoordinates =
        completedCoordinates.length >= 2
          ? completedCoordinates
          : [coord, coord];

      completedSource.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: safeCoordinates,
        },
      });
    }

    const lookAheadSteps =
      speed >= 70 ? 28 : speed >= 45 ? 22 : speed >= 20 ? 17 : 12;

    const lookAheadIndex = Math.min(
      simulationPath.length - 1,
      Math.max(0, routeProgressIndex + lookAheadSteps)
    );

    const lookAheadCoord = simulationPath[lookAheadIndex];
    const lookAheadPoint = lookAheadCoord
      ? { lng: lookAheadCoord[0], lat: lookAheadCoord[1] }
      : displayPosition;

    const cameraCenter = started
      ? interpolatePoint(displayPosition, lookAheadPoint, 0.34)
      : displayPosition;

    // A long look-ahead can point beyond a turn, rotating the car/map early.
    // Use the actual current route segment tangent as the route fallback.
    const currentSegment = Math.max(0, Math.min(simulationPath.length - 2, routeMatch?.segmentIndex ?? routeProgressIndex));
    const tangentStart = simulationPath[currentSegment];
    const tangentEnd = simulationPath[currentSegment + 1];
    const routeBearing = tangentStart && tangentEnd
      ? bearingDegrees({ lng: tangentStart[0], lat: tangentStart[1] }, { lng: tangentEnd[0], lat: tangentEnd[1] })
      : map.getBearing();

    const vehicleBearing =
      started && mode === "real" && gps.sample?.heading != null &&
      gps.sample.headingConfidence === "high" && speed >= 7
        ? gps.sample.heading
        : routeBearing;

    const dotElement = carMarker.current.getElement();
    const directionArrow = dotElement.querySelector<HTMLElement>(
      ".live-direction-arrow"
    );
    if (directionArrow) {
      const targetMapBearing = started ? vehicleBearing : 0;
      directionArrow.style.transform = `rotate(${vehicleBearing - targetMapBearing}deg)`;
    }
    dotElement.classList.toggle(
      "moving",
      started && speed >= 3
    );

    // Start with a wider overview, then move much closer once the vehicle
    // actually starts moving. At higher speed we back off slightly so the
    // next road segment remains visible.
    const zoom =
      speed >= 70
          ? 17.0
        : speed >= 45
          ? 17.45
          : speed >= 20
            ? 17.9
            : speed >= 3
              ? 18.15
              : 17.5;

    // The fixed exam route is easier to read in a clean top-down view.
    // Keeping pitch at zero also removes bulky 3D-building occlusion.
    const pitch = 0;

    const cameraUpdateInterval =
      mode === "simulation" ? 180 : 260;

    if (
      now - lastCameraUpdateAt.current >= cameraUpdateInterval
    ) {
      lastCameraUpdateAt.current = now;

      map.easeTo({
        center: [cameraCenter.lng, cameraCenter.lat],
        zoom: started ? zoom : 17.5,
        bearing: started ? vehicleBearing : 0,
        pitch,
        duration: mode === "simulation" ? 170 : 320,
        easing: (t) => 1 - Math.pow(1 - t, 2),
      });
    }
    return () => { map.off("move", updateMarkerVisualOffset); };
  }, [
    activeCheckpoint,
    displayPosition?.lng,
    displayPosition?.lat,
    rawPosition?.accuracy,
    gps.sample?.heading,
    gps.sample?.headingConfidence,
    laneDisplayPath,
    mode,
    routeProgressIndex,
    simulationPath,
    speed,
    started,
    resolvedTheme,
  ]);

  useEffect(() => {
    if (!awaitingRealStart || !gps.sample || !route.coordinates.length) return;
    const start = { lng: route.coordinates[0][0], lat: route.coordinates[0][1] };
    const distance = haversineMeters(gps.sample, start);
    setAwaitingRealStart(false);
    if (distance > 180) {
      setStartGateDistance(distance);
      return;
    }
    beginRealSession(false);
  }, [awaitingRealStart, gps.sample, route.coordinates]);


useEffect(() => {
  if (!awaitingRealStart || !gps.error) return;
  setAwaitingRealStart(false);
  setStartGateDistance(null);
}, [awaitingRealStart, gps.error]);

  useEffect(() => {
    if (started && evaluation.atFinish && !finishing.current) void finishDrive(true);
  }, [evaluation.atFinish, started]);

  useEffect(() => {
    return () => {
      sessionStartGeneration.current += 1;
      speechSessionActive.current = false;
      speechDelivery.stop();
      gps.stop();
      if (simulationTimer.current) clearTimeout(simulationTimer.current);
      stopGeorgianSpeech();
    };
  }, [gps.stop, speechDelivery]);

  function resetSession(modeToUse: DriveMode) {
    speechSessionActive.current = false;
    speechDelivery.stop();
    deliveredInstructions.current.clear();
    resumedSpeechIndex.current = null;
    lastSpeechObservationAt.current = 0;
    finishing.current = false;
    clientSessionIdRef.current = createClientSessionId();
    sessionRouteVersionRef.current = route.version ?? null;
    sessionModeRef.current = modeToUse;
    sessionAssistModeRef.current = assistMode;
    setMode(modeToUse);
    setResult(null);
    setSavedSessionId(null);
    setResultQueued(false);
    setResultDownloaded(false);
    evaluator.reset();
    lastObservation.current = null;
    lastPersistedAt.current = 0;
    simulationIndexRef.current = 0;
    setSimulationSample(null);
    setSimulationPaused(false);
    setSaveError("");
    setSimIndex(0);
    setSimSpeed(0);

    sessionStartedAt.current = Date.now();
    simulationClockRef.current = sessionStartedAt.current;
    recordEvent({ type: "session_started", timestamp: sessionStartedAt.current, note: `${modeToUse}/${assistMode}` });
  }

  function beginRealSession(ignoreStartGate: boolean) {
    setStartGateDistance(null);
    resetSession("real");
    if (!speechUnlocked.current) setSpeechStatus({ state: "blocked", checkpointIndex: null, attempts: 0 });
    if (ignoreStartGate) lastObservation.current = gps.observation;
    gps.start();
    speechSessionActive.current = true;
    setStarted(true);
    setSidePanelOpen(false);
    setResumeSnapshot(null);
  }

  async function startReal() {
    if (!route.coordinates.length) return;
    const generation = ++sessionStartGeneration.current;
    speechSessionActive.current = false;
    speechDelivery.stop();
    const unlocked = await unlockGeorgianSpeech();
    if (generation !== sessionStartGeneration.current) return;
    speechUnlocked.current = unlocked;
    if (!unlocked) setSpeechStatus({ state: "blocked", checkpointIndex: null, attempts: 0 });
    setMode("real");
    setStartGateDistance(null);
    setAwaitingRealStart(true);
    // A fresh attempt must not reuse the last GPS sample from an older session.
    // retry() clears cached samples before creating a new watch.
    gps.retry();
  }

  function retryRealLocation() { return startReal(); }

  async function resumeReal() {
    if (!resumeSnapshot || !resumeCompatible) return;
    const generation = ++sessionStartGeneration.current;
    speechSessionActive.current = false;
    speechDelivery.stop();
    const unlocked = await unlockGeorgianSpeech();
    if (generation !== sessionStartGeneration.current) return;
    speechUnlocked.current = unlocked;
    if (!unlocked) setSpeechStatus({ state: "blocked", checkpointIndex: null, attempts: 0 });
    deliveredInstructions.current.clear();
    clientSessionIdRef.current = resumeSnapshot.clientSessionId || createClientSessionId();
    setMode("real");
    setAssistMode(resumeSnapshot.assistMode);
    sessionModeRef.current = "real";
    sessionAssistModeRef.current = resumeSnapshot.assistMode;
    sessionStartedAt.current = resumeSnapshot.startedAt;
    sessionRouteVersionRef.current = resumeSnapshot.routeVersion ?? route.version;
    evaluator.restore(resumeSnapshot.trace ?? [], resumeSnapshot.events ?? [], resumeSnapshot.traceComplete !== false);
    resumedSpeechIndex.current = checkpointSpeechToResume(evaluator.stateRef.current);
    lastObservation.current = null;
    gps.retry();
    speechSessionActive.current = true;
    setStarted(true);
    setSidePanelOpen(false);
    setResumeSnapshot(null);
  }

  function discardResume() {
    const key = activeSessionKey(route.id ?? null);
    if (key) void removeActiveSnapshot(key).catch(() => setStorageWarning("აღდგენის ჩანაწერი ვერ წაიშალა."));
    setResumeSnapshot(null);
  }

  function startSimulationTimer(multiplier: SimulationMultiplier) {
    if (simulationTimer.current) {
      clearTimeout(simulationTimer.current);
      simulationTimer.current = null;
    }

    const schedule = () => {
      if (finishing.current) return;
      const current = evaluator.stateRef.current;
      const step = nextSimulationStep(evaluator.compiled, current, simulationIndexRef.current);
      if (!step) { void finishDrive(true); return; }
      const { index: next, coordinate: coord, speedKmh: simulatedSpeed, elapsed, heading } = step;
      simulationTimer.current = setTimeout(() => {
        if (document.visibilityState !== "visible" || finishing.current) return;
        simulationIndexRef.current = next;
        simulationClockRef.current += elapsed;
        const observedAt = Date.now();
        const sample: GpsSample = { lng: coord[0], lat: coord[1], accuracy: 0, timestamp: observedAt,
          speedMps: simulatedSpeed / 3.6, heading,
          speedSource: "device", headingSource: heading == null ? "unknown" : "device", speedConfidence: "high", headingConfidence: heading == null ? "unknown" : "high" };
        setSimIndex(next); setSimSpeed(simulatedSpeed); setSimulationSample(sample);
        consumeObservation({ observedAt, raw: null, sample, accepted: true, visible: true, evaluationTime: simulationClockRef.current });
        schedule();
      }, Math.max(60, Math.round(elapsed / multiplier)));
    };
    schedule();
  }

  function changeSimulationMultiplier(multiplier: SimulationMultiplier) {
    setSimulationMultiplier(multiplier);
    simulationMultiplierRef.current = multiplier;

    if (started && mode === "simulation") {
      startSimulationTimer(multiplier);
    }
  }

  async function startSimulation() {
    if (simulationPath.length < 2) return;
    const generation = ++sessionStartGeneration.current;
    speechSessionActive.current = false;
    speechDelivery.stop();
    const unlocked = await unlockGeorgianSpeech();
    if (generation !== sessionStartGeneration.current) return;
    speechUnlocked.current = unlocked;

    gps.stop();
    resetSession("simulation");
    if (!unlocked) setSpeechStatus({ state: "blocked", checkpointIndex: null, attempts: 0 });
    speechSessionActive.current = true;
    const observedAt = sessionStartedAt.current!;
    const [lng, lat] = simulationPath[0];
    const sample: GpsSample = { lng, lat, accuracy: 0, timestamp: observedAt, speedMps: 0, heading: null,
      speedSource: "device", headingSource: "unknown", speedConfidence: "high", headingConfidence: "unknown" };
    setSimulationSample(sample);
    consumeObservation({ observedAt, raw: null, sample, accepted: true, visible: true, evaluationTime: observedAt });
    setStarted(true);
    setSidePanelOpen(false);
    startSimulationTimer(simulationMultiplierRef.current);
  }

  async function resumeSimulation() {
    const generation = ++sessionStartGeneration.current;
    const unlocked = await unlockGeorgianSpeech();
    if (generation !== sessionStartGeneration.current) return;
    speechUnlocked.current = unlocked;
    if (!unlocked) setSpeechStatus({ state: "blocked", checkpointIndex: null, attempts: 0 });
    speechSessionActive.current = true;
    setSimulationPaused(false);
    setStarted(true);
    startSimulationTimer(simulationMultiplierRef.current);
  }

  async function finishDrive(automatic = false) {
    if (finishing.current) return;
    finishing.current = true;
    sessionStartGeneration.current += 1;
    speechSessionActive.current = false;
    speechDelivery.stop();
    gps.stop();

    if (simulationTimer.current) {
      clearTimeout(simulationTimer.current);
      simulationTimer.current = null;
    }
    stopGeorgianSpeech();

    const finishedAt = Date.now();
    const startedAt = sessionStartedAt.current ?? finishedAt;
    const finishedMode = sessionModeRef.current;
    const finishedAssistMode = sessionAssistModeRef.current;
    recordEvent({ type: "session_finished", timestamp: finishedAt, note: automatic ? "automatic finish" : "manual finish" });

    const finalEvents = [...sessionEvents.current, {
      type: "session_finished" as const,
      timestamp: finishedAt,
      note: automatic ? "automatic finish" : "manual finish",
    }].filter((event, index, arr) =>
      !(event.type === "session_finished" && arr.slice(0, index).some((previous) => previous.type === "session_finished"))
    );

    const finalResult: DrivingSessionResult = {
      clientSessionId: clientSessionIdRef.current || createClientSessionId(),
      routeId: route.id ?? null,
      routeVersion: sessionRouteVersionRef.current,
      mode: finishedMode,
      assistMode: finishedAssistMode,
      startedAt,
      finishedAt,
      durationSeconds: Math.max(0, Math.round(((finishedMode === "simulation" ? simulationClockRef.current : finishedAt) - startedAt) / 1000)),
      distanceMeters: evaluator.stateRef.current.distanceMeters,
      maxSpeedKmh: evaluator.stateRef.current.maxSpeedKmh,
      speedingEvents: finalEvents.filter((e) => e.type === "speeding").length,
      offRouteEvents: finalEvents.filter((e) => e.type === "off_route").length,
      checkpointsCompleted: evaluator.stateRef.current.completed.length,
      checkpointsTotal: orderedCheckpoints.length,
      events: finalEvents,
      trace: [...evaluator.traceRef.current], traceComplete: evaluator.traceCompleteRef.current,
      evaluation: { version: EVALUATION_VERSION, status: evaluator.traceCompleteRef.current ? "replayed" : "incomplete",
        missedCheckpoints: evaluator.stateRef.current.missed.length, uncertainCheckpoints: evaluator.stateRef.current.uncertain.length,
        rejectedSamples: evaluator.stateRef.current.rejectedSamples,
        wrongDirectionEvents: finalEvents.filter((event) => event.type === "wrong_direction").length },
    };

    setResumeSnapshot(null);
    setStarted(false);
    setSimulationPaused(false);
    setSimSpeed(0);
    setResult(finalResult);
    if (automatic && finishedAssistMode === "exam") {
      speakGeorgian(EXAM_FINISH_RECORDED_PHRASE);
    }

    setSavingResult(true);
    try {
      const saved = await sessionService.saveOrQueue(finalResult, route);
      setSavedSessionId(saved.id);
      setResultQueued(saved.pending);
      setSaveError(saved.error ?? "");
      if (saved.id || saved.pending) {
        const key = activeSessionKey(route.id ?? null);
        if (key) await removeActiveSnapshot(key).catch(() => undefined);
      }
    } finally {
      setSavingResult(false);
      finishing.current = false;
    }
  }

  async function retryResultSave() {
    if (!result || savingResult) return;
    setSavingResult(true);
    try {
      const saved = await sessionService.saveOrQueue(result, route);
      setSavedSessionId(saved.id); setResultQueued(saved.pending); setSaveError(saved.error ?? "");
      if (saved.id || saved.pending) {
        const key = activeSessionKey(route.id ?? null);
        if (key) await removeActiveSnapshot(key).catch(() => undefined);
      }
    } finally { setSavingResult(false); }
  }
  function downloadResult() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ route, session: result }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `DriveExam-${result.clientSessionId}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setResultDownloaded(true);
  }

  function retryAttempt() {
    if (!result || !resultCanClose || finishing.current) return;

    const retryMode = result.mode;

    stopGeorgianSpeech();
    setResult(null);
    setSavedSessionId(null);
    setResultQueued(false);
    setStartGateDistance(null);
    setAwaitingRealStart(false);
    setResumeSnapshot(null);
    setSidePanelOpen(false);

    if (retryMode === "simulation") {
      startSimulation();
      return;
    }

    startReal();
  }

  return (
    <div className={`drive-layout drive-v8 ${started ? "drive-active" : "drive-idle"} ${assistMode === "exam" ? "drive-exam-mode" : ""}`}>
      <section className="drive-map-stage">
        <div ref={mapEl} className="map-canvas" />

        <MapThemeControl
          mode={mapThemeMode}
          resolvedTheme={resolvedTheme}
          onChange={setMapThemeMode}
          compact
        />

        <div className="drive-v8-progress" aria-label="Route progress">
          <div>
            <span style={{ width: `${routeProgressPercent}%` }} />
          </div>
          <small>{Math.round(routeProgressPercent)}%</small>
        </div>

        <div className="drive-v19-top-stack">
        <div className="drive-v8-instruction-wrap">
          <Surface className="drive-v8-instruction">
            <div className="drive-v8-turn-icon">
              {instructionIcon(activeCheckpoint?.type ?? "straight")}
            </div>

            <div className="drive-v8-instruction-copy">
              <div className="drive-v8-instruction-meta">
                <span className="drive-v8-distance">
                  {activeCheckpoint && activeCheckpointDistance != null
                    ? `${Math.round(activeCheckpointDistance)} მ`
                    : started
                      ? "ფინიში"
                      : "მზადაა"}
                </span>
                {started && (
                  <span className="drive-v8-meta-separator">•</span>
                )}
                {started && (
                  <span>
                    {completed}/{orderedCheckpoints.length} წერტილი
                  </span>
                )}
              </div>

              <h2>
                {activeCheckpoint?.title ||
                  (started ? "გააგრძელეთ ფინიშამდე" : "აირჩიე რეჟიმი და დაიწყე")}
              </h2>

              {started && nextCheckpoint && assistMode === "practice" && (
                <div className="drive-v8-next">
                  შემდეგი: {nextCheckpoint.title}
                </div>
              )}
            </div>

            <button
              className="drive-v8-voice"
              onClick={() => {
                if (activeCheckpoint?.voice.trim()) void speechDelivery.repeatFromGesture(activeCheckpointIndex,
                  activeCheckpoint.voice, activeCheckpoint.ttsVoice);
              }}
              disabled={!started || !activeCheckpoint?.voice.trim() || evaluation.quality !== "usable" ||
                (evaluation.direction !== "forward" && evaluation.direction !== "stationary") ||
                !checkpointSpeechInWindow(evaluator.compiled, evaluation, activeCheckpointIndex)}
              aria-label="ხმოვანი ინსტრუქციის გამეორება"
            >
              <Volume2 size={20} />
            </button>
          </Surface>
        </div>

          {routeSelector}

        <div className="drive-v8-status">
          <div className={`drive-v8-gps ${quality.tone}`}>
            <Satellite size={14} />
            <span>
              {mode === "simulation"
                ? `სიმულაცია • ${simulationMultiplier}×`
                : quality.label.replace("GPS ", "")}
            </span>
          </div>

          <div className="drive-v8-mode-pill">
            <Sparkles size={13} />
            {assistMode === "exam" ? "გამოცდა" : "ვარჯიში"}
          </div>

          {started && (
            <div
              className={`drive-v20-lane-status ${oppositeTravelDirection ? "opposite" : ""}`}
              aria-live="polite"
            >
              <span className="drive-v20-lane-arrow" aria-hidden="true">
                {oppositeTravelDirection ? "←" : "→"}
              </span>
              <span>
                <b>
                  {oppositeTravelDirection
                    ? "საპირისპირო მიმართულება"
                    : mode === "simulation"
                      ? "სიმულაციის მიმართულება"
                      : evaluation.direction === "uncertain" ? "მიმართულება დაუზუსტებელია" : "მარშრუტის მიმართულება"}
                </b>
                <small>{evaluation.direction === "uncertain" ? "მიმართულების დასადგენად მონაცემებს ველოდებით" : "მარშრუტთან მიმართებით"}</small>
              </span>
            </div>
          )}

          {started && (evaluation.quality !== "usable" || storageWarning || !evaluator.traceCompleteRef.current) && (
            <div className="drive-evaluation-status" role="status">
              {storageWarning || (!evaluator.traceCompleteRef.current ? "GPS ჩანაწერის ზღვარი მიღწეულია; სრული გადამოწმება ვერ მოხერხდება." : evaluation.quality === "paused" ? "შეფასება შეჩერებულია — ახალი სანდო GPS მონაცემის მოლოდინი." : "GPS მონაცემი არასაკმარისია; დავალების შესრულება ჯერ არ დასტურდება.")}
            </div>
          )}
          {!started && storageWarning && <div className="drive-evaluation-status" role="status">{storageWarning}</div>}
          {!started && recordingReadiness.missing.length > 0 && (
            <div className="drive-evaluation-status" role="status">
              ხმოვანი ჩანაწერი აკლია: {recordingReadiness.missing.map((phrase) => `„${getRecordedCheckpointPrompt(phrase)?.label ?? phrase}“`).join("; ")}. ამ მინიშნებას ტექსტურად ნახავ.
            </div>
          )}
          {!started && recordingReadiness.unverified && <div className="drive-evaluation-status" role="status">ხმოვანი ჩანაწერების ჩატვირთვა ვერ შემოწმდა. შეამოწმე ინტერნეტი.</div>}
          {started && ["blocked", "network", "missing", "failed"].includes(speechStatus.state) && (
            <div className="drive-evaluation-status" role="status">
              {speechStatus.state === "blocked" ? "ბრაუზერმა ხმა შეაჩერა. ჩართე ხმა ღილაკით." :
                speechStatus.state === "missing" ? "ამ მინიშნებისთვის ხმოვანი ჩანაწერი არ მოიძებნა." :
                  speechStatus.state === "failed" ? "ხმოვანი ჩანაწერი ვერ გაიხსნა." :
                    speechStatus.attempts < 3 ? "ხმა ვერ ჩაიტვირთა — ხელახლა ვცდილობთ." : "ხმა ვერ ჩაიტვირთა. შეამოწმე ინტერნეტი და თავიდან სცადე."}
              {speechStatus.checkpointIndex != null && <span> {orderedCheckpoints[speechStatus.checkpointIndex]?.title || orderedCheckpoints[speechStatus.checkpointIndex]?.voice}</span>}
              <button type="button" className="drive-audio-retry" onClick={() => void speechDelivery.retryFromGesture()}>ხმის ხელახლა ჩართვა</button>
            </div>
          )}
          {started && activeCheckpoint?.type === "stop" && evaluation.checkpoint.phase === "stopping" && <div className="drive-evaluation-status">გაჩერება მოწმდება — დარჩი მონიშნულ ადგილზე.</div>}
          {!isOnline && (
            <div className="drive-v16-offline">
              <CloudOff size={13} />
              ოფლაინ
            </div>
          )}

          {mode === "real" &&
            gps.sample &&
            offRouteMeters > 40 &&
            (!started || assistMode === "practice") && (
            <div className="drive-v8-warning">
              <AlertTriangle size={14} />
              მარშრუტი აცდენილია • {Math.round(offRouteMeters)} მ
            </div>
          )}
        </div>

        <button
          type="button"
          className="drive-v12-panel-toggle"
          onClick={() => setSidePanelOpen((value) => !value)}
          aria-expanded={sidePanelOpen}
          aria-label={sidePanelOpen ? "საკონტროლო პანელის დახურვა" : "საკონტროლო პანელის გახსნა"}
        >
          {sidePanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          <span>პანელი</span>
          <b>{completed}/{orderedCheckpoints.length}</b>
        </button>

        </div>

        <div className="drive-v8-cockpit">
          <Surface className={`drive-v8-speed ${currentSpeedLimit != null && speed > currentSpeedLimit + 3 ? "overspeed" : ""}`}>
            <div className="drive-v8-speed-number">
              <strong>{Math.round(speed)}</strong>
              <span>კმ/სთ</span>
            </div>
            <div className="drive-v8-speed-limit">
              <small>ლიმიტი</small>
              <strong>{currentSpeedLimit ?? "—"}</strong>
            </div>
          </Surface>

          <Surface className="drive-v8-route-card">
            <div>
              <small>მარშრუტი</small>
              <strong>{route.name}</strong>
            </div>
            <div className="drive-v8-route-mini">
              <span>
                <MapPinned size={14} />
                {completed}/{orderedCheckpoints.length}
              </span>
              <span>{Math.round(remainingPercent)}% დარჩა</span>
            </div>
          </Surface>

          <div className="drive-v12-action-stack">
            {(!started || mode === "simulation") && (
              <div className="drive-v12-sim-rate" aria-label="სიმულაციის სიჩქარე">
                <span>სიმულაციის სიჩქარე</span>
                <div>
                  {SIMULATION_MULTIPLIERS.map((multiplier) => (
                    <button
                      key={multiplier}
                      type="button"
                      className={
                        simulationMultiplier === multiplier ? "active" : ""
                      }
                      onClick={() => changeSimulationMultiplier(multiplier)}
                    >
                      {multiplier}×
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="drive-v8-controls">
      {simulationPaused ? (
                <>
                  <Button onClick={resumeSimulation}><Play size={18} /> გაგრძელება</Button>
                  <Button variant="secondary" onClick={() => void finishDrive(false)}>დასრულება</Button>
                </>
              ) : !started ? (
                <>
                  {resumeSnapshot && resumeCompatible && (
                    <Button variant="secondary" onClick={resumeReal}>
                      <RotateCcw size={17} />
                      გაგრძელება
                    </Button>
                  )}

                  <Button onClick={startReal}>
                    <LocateFixed size={18} />
                    რეალური რეჟიმი
                  </Button>

                  <Button variant="secondary" onClick={startSimulation}>
                    <Play size={18} />
                    სიმულაცია
                  </Button>
                </>
              ) : (
                <>
                  {mode === "simulation" && <Button variant="secondary" onClick={() => {
                    resumedSpeechIndex.current = checkpointSpeechToResume(evaluator.stateRef.current);
                    if (simulationTimer.current) clearTimeout(simulationTimer.current);
                    simulationTimer.current = null;
                    consumeObservation({ observedAt: Date.now(), raw: null, sample: null, accepted: false, reason: "paused", visible: true, evaluationTime: simulationClockRef.current });
                    speechSessionActive.current = false;
                    speechDelivery.update();
                    setSimulationPaused(true); setStarted(false); setSimSpeed(0); stopGeorgianSpeech();
                  }}><Pause size={18} /> პაუზა</Button>}
                  <Button variant="danger" onClick={() => void finishDrive(false)}>დასრულება</Button>
                </>
              )}
            </div>
          </div>
        </div>

        {mode === "real" && gps.error && !started && (
          <Surface className="drive-location-error">
            <div className="drive-location-error-icon">
              <AlertTriangle size={19} />
            </div>
            <div>
              <strong>Location ვერ ჩაირთო</strong>
              <small>{gps.error.message}</small>
            </div>
            <button type="button" onClick={retryRealLocation}>
              თავიდან ცდა
            </button>
          </Surface>
        )}

        {awaitingRealStart && (
          <Surface className="drive-v8-floating-notice">
            <span className="drive-v8-spinner" />
            <div>
              <strong>GPS პოზიციას ვამოწმებ</strong>
              <small>დაწყების წერტილთან მანძილს ვადგენთ...</small>
            </div>
          </Surface>
        )}

        {resumeSnapshot && !started && (
          <Surface className="drive-v8-resume-toast">
            <div>
              <small>დაუმთავრებელი სესია</small>
              <strong>
                {resumeCompatible ? `წერტილი ${resumeSnapshot.activeCheckpointIndex + 1}-დან გაგრძელება` : "ძველი ვერსიის ჩანაწერი"}
              </strong>
            </div>
            <button onClick={() => {
              const url = URL.createObjectURL(new Blob([JSON.stringify({ route: resumeSnapshot.routeSnapshot ?? (resumeCompatible ? route : null), trace: resumeSnapshot.trace, mode: "real", activeSession: resumeSnapshot }, null, 2)], { type: "application/json" }));
              const link = document.createElement("a"); link.href = url; link.download = `DriveExam-active-${resumeSnapshot.clientSessionId || resumeSnapshot.startedAt}.json`; link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}>ჩამოტვირთვა</button>
            <button onClick={discardResume}>გაუქმება</button>
          </Surface>
        )}

        {startGateDistance != null && !started && (
          <div className="results-backdrop">
            <Surface className="results-modal drive-v8-start-gate">
              <button
                className="results-close"
                onClick={() => {
                  setStartGateDistance(null);
                  gps.stop();
                }}
                aria-label="Close"
              >
                <X size={18} />
              </button>

              <div className="results-icon">
                <LocateFixed size={26} />
              </div>
              <small>START POINT CHECK</small>
              <h2>საწყისი წერტილი შორსაა</h2>
              <p>
                მარშრუტის დასაწყისამდე დაახლოებით{" "}
                <b>{Math.round(startGateDistance)} მეტრია</b>.
              </p>
              <div className="start-gate-actions">
                <Button onClick={async () => {
                  const generation = ++sessionStartGeneration.current;
                  const unlocked = await unlockGeorgianSpeech();
                  if (generation !== sessionStartGeneration.current) return;
                  speechUnlocked.current = unlocked;
                  beginRealSession(true);
                }}>
                  მაინც დაწყება
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setStartGateDistance(null);
                    gps.stop();
                  }}
                >
                  გაუქმება
                </Button>
              </div>
            </Surface>
          </div>
        )}
      </section>

      {sidePanelOpen && (
        <button
          type="button"
          className="drive-v12-panel-backdrop"
          onClick={() => setSidePanelOpen(false)}
          aria-label="საკონტროლო პანელის დახურვა"
        />
      )}

      <aside
        className={`drive-side-panel drive-v8-sidebar drive-v12-sidebar ${
          sidePanelOpen ? "panel-open" : ""
        }`}
      >
        <button
          type="button"
          className="drive-v12-sidebar-close"
          onClick={() => setSidePanelOpen(false)}
          aria-label="საკონტროლო პანელის დახურვა"
        >
          <X size={17} />
        </button>

        <div className="drive-v8-sidebar-head">
          <div className="side-kicker">
            <Radio size={15} />
            სესია
          </div>
          <h1>{route.name}</h1>
          <p>{route.description || `${route.city} • სავარჯიშო მარშრუტი`}</p>
        </div>

        {!started && !simulationPaused && !result && (
          <div className="assist-mode-picker">
            <button
              className={assistMode === "practice" ? "active" : ""}
              onClick={() => setAssistMode("practice")}
            >
              <ShieldCheck size={17} />
              <span>
                <b>ვარჯიში</b>
                <small>გაფრთხილებები, შემდეგი ინსტრუქცია და სრული დახმარება</small>
              </span>
            </button>
            <button
              className={assistMode === "exam" ? "active" : ""}
              onClick={() => setAssistMode("exam")}
            >
              <Navigation size={17} />
              <span>
                <b>გამოცდა</b>
                <small>მინიმალური დახმარება და სუფთა მართვის ეკრანი</small>
              </span>
            </button>
          </div>
        )}

        <div className="drive-v8-sidebar-stats">
          <div>
            <small>პროგრესი</small>
            <strong>{Math.round(routeProgressPercent)}%</strong>
          </div>
          <div>
            <small>საკონტროლო</small>
            <strong>{completed}/{orderedCheckpoints.length}</strong>
          </div>
          <div>
            <small>სიჩქარის გადაჭარბება</small>
            <strong>{speedingCount}</strong>
          </div>
          <div>
            <small>გზიდან გადახვევა</small>
            <strong>{offRouteCount}</strong>
          </div>
        </div>

        {assistMode === "practice" && (
          <div className="checkpoint-timeline drive-v8-timeline">
            {orderedCheckpoints.map((checkpoint, index) => (
              <div
                key={checkpoint.id ?? `${checkpoint.orderIndex}-${index}`}
                className={`timeline-item ${
                  activeCheckpointIndex === index ? "active" : ""
                } ${evaluation.completed.includes(index) ? "completed" : ""} ${evaluation.missed.includes(index) || evaluation.uncertain.includes(index) ? "uncertain" : ""}`}
              >
                <span>{evaluation.completed.includes(index) ? "✓" : evaluation.missed.includes(index) ? "!" : evaluation.uncertain.includes(index) ? "?" : index + 1}</span>
                <div>
                  <b>{checkpoint.title}</b>
                  <small>
                    {checkpoint.speedLimit != null ? `${checkpoint.speedLimit} კმ/სთ` : "სიჩქარის ლიმიტი არაა"} •{" "}
                    {checkpoint.triggerMeters} მ
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="drive-v8-sidebar-links">
          <button onClick={() => router.push("/history")}>
            <History size={16} />
            ისტორია
          </button>
        </div>
      </aside>

      {result && (
        <div className="results-backdrop">
          <Surface className="results-modal">
            <button
              className="results-close"
              onClick={() => setResult(null)}
              disabled={!resultCanClose}
              aria-label="შედეგის დახურვა"
            >
              <X size={18} />
            </button>

            <div className="results-icon">
              <CheckCircle2 size={28} />
            </div>
            <small>სესია დასრულდა</small>
            <h2>{route.name}</h2>
            <p>
              {result.assistMode === "exam" ? "გამოცდის რეჟიმი" : "ვარჯიშის რეჟიმი"} •{" "}
              {result.mode === "real" ? "რეალური GPS" : "სიმულაცია"}
            </p>
            {result.assistMode === "exam" && (
              <p className="results-note">
                GPS-ზე დაფუძნებული სასწავლო შეფასებაა; ოფიციალურ პრაქტიკულ გამოცდას სრულად ვერ ცვლის.
              </p>
            )}

            <div className="results-grid">
              <div>
                <span>დრო</span>
                <b>{formatDuration(result.durationSeconds)}</b>
              </div>
              <div>
                <span>მანძილი</span>
                <b>{(result.distanceMeters / 1000).toFixed(2)} კმ</b>
              </div>
              <div>
                <span>მაქს. სიჩქარე</span>
                <b>{Math.round(result.maxSpeedKmh)} კმ/სთ</b>
              </div>
              <div>
                <span>საკონტროლო წერტილები</span>
                <b>{result.checkpointsCompleted}/{result.checkpointsTotal}</b>
              </div>
              <div className={result.speedingEvents ? "result-warning" : ""}>
                <span>სიჩქარის გადაჭარბება</span>
                <b>{result.speedingEvents}</b>
              </div>
              <div className={result.offRouteEvents ? "result-warning" : ""}>
                <span>გზიდან გადახვევა</span>
                <b>{result.offRouteEvents}</b>
              </div>
            </div>

            <div className="results-note">
              {savingResult
                ? "შედეგი ინახება..."
                : savedSessionId
                  ? "შედეგი შენახულია."
                  : resultQueued
                    ? "შედეგი შენახულია ამ მოწყობილობაზე. გაგზავნის სტატუსი და ხელახლა გაგზავნა იხილე ისტორიაში."
                    : "შედეგი ნაჩვენებია, მაგრამ შენახვა ვერ მოხერხდა."}
              {saveError && <p>{saveError}</p>}
              {!savingResult && !resultCanClose && <p>დახურვამდე შეინახე ან ჩამოტვირთე ჩანაწერი, რომ შედეგი არ დაიკარგოს.</p>}
            </div>

            <div className="results-actions">
              {!savedSessionId && <Button variant="secondary" disabled={savingResult} onClick={() => void retryResultSave()}>შენახვის გამეორება</Button>}
              <Button variant="secondary" onClick={() => downloadResult()}>ჩანაწერის ჩამოტვირთვა</Button>
              {savedSessionId && (
                <Button
                  onClick={() => router.push(`/results/${savedSessionId}`)}
                >
                  დეტალური შედეგი
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => router.push("/history")}
                disabled={!resultCanClose}
              >
                <History size={16} />
                ისტორია
              </Button>
              <Button
                variant="secondary"
                onClick={retryAttempt}
                disabled={!resultCanClose}
              >
                <RotateCcw size={16} />
                {savingResult ? "ინახება..." : "თავიდან ცდა"}
              </Button>
            </div>
          </Surface>
        </div>
      )}
    </div>
  );
}
