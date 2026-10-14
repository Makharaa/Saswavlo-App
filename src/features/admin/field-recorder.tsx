"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { GeoJSONSource, Map, Marker } from "maplibre-gl";
import { configureMapLibreWorker } from "@/utils/maplibre-runtime";
import {
  AlertTriangle,
  CarFront,
  Check,
  CloudOff,
  Download,
  LocateFixed,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Save,
  Signal,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";

import { Badge, Button, Metric, Surface } from "@/components/ui";
import { MapThemeControl } from "@/components/map-theme-control";
import { useLiveLocation } from "@/hooks/use-live-location";
import { useMapTheme } from "@/hooks/use-map-theme";
import { installNavigationMapStyle } from "@/utils/maplibre-style-guard";
import { useRouteRecorder } from "@/hooks/use-route-recorder";
import { ApiError, routeService } from "@/services/routes";
import { fieldRecordingIssueLabel } from "@/utils/field-recording";
import type { FieldRecordingSnapshot } from "@/utils/field-recording";
import {
  DEFAULT_LEFT_RECORDED_PHRASE,
  DEFAULT_RIGHT_RECORDED_PHRASE,
  DEFAULT_STRAIGHT_RECORDED_PHRASE,
} from "@/lib/recorded-voice-catalog";
import type {
  ExamRoute,
  InstructionType,
  RouteCheckpoint,
} from "@/types/domain";
import {
  downsampleCoordinates,
  haversineMeters,
  nearestPointOnRoute,
} from "@/utils/geo";
import { remapRouteReferences } from "@/utils/route-engine";

type FieldDraft = {
  version: 1;
  routeId: number;
  routeVersion?: number;
  points: [number, number][];
  recording?: FieldRecordingSnapshot;
  checkpoints: RouteCheckpoint[];
  // Legacy fields may still exist in an older browser draft. They are ignored.
  speedAnchors?: unknown[];
  speedLimit?: number;
  savedAt: number;
};

const MAX_CHECKPOINT_ACCURACY = 35;
const ROUTING_WAYPOINT_LIMIT = 40;

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatDistance(meters: number) {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(2)} კმ`
    : `${Math.round(meters)} მ`;
}

function gpsTone(quality: string) {
  if (quality === "excellent" || quality === "good") return "success" as const;
  if (quality === "waiting") return "neutral" as const;
  return "warning" as const;
}

export function FieldRecorder({ routeId }: { routeId: number }) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const locationMarker = useRef<Marker | null>(null);
  const checkpointMarkers = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(0);

  const gps = useLiveLocation({
    smoothing: true,
    staleAfterMs: 8_000,
    maxAcceptedAccuracyMeters: 35,
  });

  const recorder = useRouteRecorder(gps.observation);
  const roadSample = recorder.roadSample;
  const roadLockWarning = recorder.issue ? fieldRecordingIssueLabel(recorder.issue) : null;

  const [route, setRoute] = useState<ExamRoute | null>(null);
  const [status, setStatus] = useState("მარშრუტი იტვირთება...");
  const [draft, setDraft] = useState<FieldDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [locationRequested, setLocationRequested] = useState(false);

  const { mode: mapThemeMode, resolvedTheme, styleUrl, setMode: setMapThemeMode } = useMapTheme();

  const storageKey = useMemo(
    () => `driveexam-field-draft-v1:${routeId}`,
    [routeId]
  );

  useEffect(() => {
    let mounted = true;

    routeService
      .get(routeId)
      .then((data) => {
        if (!mounted) return;
        setRoute(data);
        setStatus("გზის ჩაწერის რეჟიმი მზადაა");
      })
      .catch((error) => {
        if (!mounted) return;
        setStatus(
          error instanceof Error ? error.message : "მარშრუტი ვერ ჩაიტვირთა"
        );
      });

    return () => {
      mounted = false;
    };
  }, [routeId]);

  useEffect(() => {
    // If the browser already has Location permission, start immediately.
    // Otherwise Field Recorder shows a clear user-gesture button so mobile
    // browsers can display their native permission prompt reliably.
    if (gps.diagnostics.permissionState === "granted") {
      setLocationRequested(true);
      gps.start();
    }

    return gps.stop;
  }, [
    gps.diagnostics.permissionState,
    gps.start,
    gps.stop,
  ]);

  function requestLocation() {
    setLocationRequested(true);
    gps.retry();
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;

      const parsed = JSON.parse(raw) as FieldDraft;
      if (parsed?.version === 1 && parsed.routeId === routeId) {
        setDraft(parsed);
      }
    } catch {
      // Broken local draft must never block Field Recorder.
    }
  }, [routeId, storageKey]);

  useEffect(() => {
    if (!dirty || !route) return;

    const snapshot: FieldDraft = {
      version: 1,
      routeId,
      routeVersion: route.version,
      points: recorder.points,
      recording: recorder.snapshot(),
      checkpoints: route.checkpoints,
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
      setDraft(snapshot);
      setDraftStorageFailed(false);
    } catch {
      setDraftStorageFailed(true);
    }
  }, [
    dirty,
    recorder.revision,
    recorder.points,
    route?.checkpoints,
    routeId,
    storageKey,
  ]);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    configureMapLibreWorker();
    const map = new maplibregl.Map({
      container: mapEl.current,
      center: [44.11, 41.98],
      zoom: 16,
      pitch: 0,
    });

    const disposeNavigationMapStyle = installNavigationMapStyle(map, styleUrl);

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      map.addSource("saved-field-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [] },
        },
      });

      map.addLayer({
        id: "saved-field-route-line",
        type: "line",
        source: "saved-field-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#7481ff",
          "line-width": 6,
          "line-opacity": 0.32,
          "line-dasharray": [2, 1.6],
        },
      });

      map.addSource("recorded-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [] },
        },
      });

      map.addLayer({
        id: "recorded-route-line-halo",
        type: "line",
        source: "recorded-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 13,
          "line-opacity": 0.88,
        },
      });

      map.addLayer({
        id: "recorded-route-line-casing",
        type: "line",
        source: "recorded-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0a765b",
          "line-width": 9,
          "line-opacity": 1,
        },
      });

      map.addLayer({
        id: "recorded-route-line",
        type: "line",
        source: "recorded-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#27d6a2",
          "line-width": 5.5,
          "line-opacity": 1,
        },
      });

      const el = document.createElement("div");
      el.className = "field-location-dot";
      el.innerHTML = `
        <span class="field-location-dot-pulse"></span>
        <span class="field-location-dot-core"></span>
      `;

      // Create the marker, but do NOT place it on the default Gori center.
      // It becomes visible only after useLiveLocation accepts a sufficiently
      // accurate GPS fix.
      locationMarker.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
      });
      setMapReady(value => value + 1);
    });

    mapRef.current = map;

    return () => {
      checkpointMarkers.current.forEach((marker) => marker.remove());
      checkpointMarkers.current = [];
      locationMarker.current?.remove();
      locationMarker.current = null;
      disposeNavigationMapStyle();
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const render = () => {
      const saved = map.getSource("saved-field-route") as GeoJSONSource | undefined;
      saved?.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: route?.coordinates ?? [],
        },
      });

      const recorded = map.getSource("recorded-route") as
        | GeoJSONSource
        | undefined;
      recorded?.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: recorder.points,
        },
      });

      checkpointMarkers.current.forEach((marker) => marker.remove());
      checkpointMarkers.current = [];

      route?.checkpoints.forEach((checkpoint, index) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "field-checkpoint-marker";
        element.textContent = String(index + 1);
        element.title = checkpoint.title;

        checkpointMarkers.current.push(
          new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat([checkpoint.lng, checkpoint.lat])
            .addTo(map)
        );
      });
    };

    if (
      map.getSource("saved-field-route") &&
      map.getSource("recorded-route")
    ) {
      render();
    } else {
      map.once("load", render);
    }
  }, [
    mapReady,
    recorder.revision,
    recorder.points,
    route?.coordinates,
    route?.checkpoints,
    resolvedTheme,
  ]);

  useEffect(() => {
    const displaySample =
      recorder.recording || recorder.pendingCount > 0 ? roadSample : gps.sample;

    if (!mapRef.current || !locationMarker.current) return;
    if (!displaySample) {
      locationMarker.current.getElement().style.opacity = "0.4";
      return;
    }

    const map = mapRef.current;
    const coord: [number, number] = [displaySample.lng, displaySample.lat];

    const marker = locationMarker.current;
    marker.setLngLat(coord);

    // A Marker created without addTo() is intentionally invisible while
    // location is missing/too inaccurate.
    if (!marker.getElement().isConnected) {
      marker.addTo(map);
    }

    const uncertain = gps.diagnostics.isStale || (recorder.issue != null && recorder.issue !== "stationary" && recorder.issue !== "waiting");
    marker.getElement().classList.toggle("uncertain", uncertain);
    marker.getElement().style.opacity = uncertain ? "0.55" : "1";
    const speedMps = displaySample.speedMps ?? 0;
    const hasStartedMoving =
      recorder.recording &&
      (recorder.points.length >= 2 || speedMps >= 1.1);

    marker
      .getElement()
      .classList.toggle("moving", hasStartedMoving);

    const targetBearing =
      displaySample.heading != null && speedMps >= 0.8
        ? displaySample.heading
        : map.getBearing();

    // Before movement starts we keep a wider overview. As soon as real
    // movement is detected, Field Recorder moves to a closer road-level view.
    const targetZoom = hasStartedMoving
      ? 18.35
      : recorder.recording
        ? 17.25
        : 16.5;

    const targetPitch = 0;

    map.easeTo({
      center: coord,
      zoom: targetZoom,
      bearing: targetBearing,
      pitch: targetPitch,
      duration: hasStartedMoving ? 620 : 480,
      easing: (t) => 1 - Math.pow(1 - t, 2),
    });
  }, [
    mapReady,
    gps.sample?.lng,
    gps.sample?.lat,
    gps.sample?.heading,
    gps.sample?.speedMps,
    roadSample?.lng,
    roadSample?.lat,
    roadSample?.heading,
    roadSample?.speedMps,
    recorder.recording,
    recorder.pendingCount,
    recorder.issue,
    gps.diagnostics.isStale,
    recorder.points.length,
    resolvedTheme,
  ]);

  const rawAccuracy = gps.rawSample?.accuracy ?? null;
  const accuracy = rawAccuracy ?? gps.sample?.accuracy;
  const hasRejectedCoarseLocation =
    rawAccuracy != null &&
    rawAccuracy > 35;

  const locationStatusLabel = hasRejectedCoarseLocation
    ? `GPS ძალიან არაზუსტია ±${Math.round(rawAccuracy!)}მ`
    : gps.diagnostics.label;

  const hasGoodGps = Boolean(
    gps.sample && !gps.error && gps.observation?.accepted &&
      !gps.diagnostics.isStale &&
      (accuracy != null && accuracy <= MAX_CHECKPOINT_ACCURACY)
  );
  const canPlaceCheckpoint = Boolean(hasGoodGps &&
      (!recorder.recording || (roadSample && Date.now() - roadSample.timestamp <= 8_000 &&
        (recorder.issue == null || recorder.issue === "waiting" || recorder.issue === "stationary")))
  );

  const shouldShowLocationPrompt =
    !gps.sample &&
    !gps.rawSample &&
    !gps.error &&
    gps.diagnostics.permissionState !== "granted";

  const locationPromptDenied =
    gps.diagnostics.permissionState === "denied";

  function requireGoodLocation(forCheckpoint = false) {
    if (hasGoodGps && (!forCheckpoint || canPlaceCheckpoint)) return true;

    if (gps.diagnostics.isStale) {
      setStatus("GPS მონაცემი მოძველებულია — დაელოდე ახალ პოზიციას");
    } else if (hasGoodGps && forCheckpoint) {
      setStatus("გზის პოზიცია ჯერ ვერ დადასტურდა — საკონტროლო წერტილი არ დამატებულა");
    } else if (accuracy != null) {
      setStatus(
        `GPS ჯერ საკმარისად ზუსტი არაა (±${Math.round(
          accuracy
        )}მ). წერტილი დაემატება ±${MAX_CHECKPOINT_ACCURACY}მ ან უკეთეს სიზუსტეზე.`
      );
    } else {
      setStatus("GPS პოზიციას ველოდებით...");
    }

    return false;
  }

  function startNewRecording() {
    if (saving) return;
    if (!gps.sample || !requireGoodLocation()) {
      return;
    }

    if (
      (recorder.points.length > 0 || dirty) &&
      !confirm("დავიწყოთ ახალი ჩანაწერი? მიმდინარე შეუნახავი ჩანაწერი გასუფთავდება.")
    ) {
      return;
    }

    recorder.startNew();
    setDirty(true);
    setStatus("ჩაწერა დაიწყო • სიჩქარის ზონები შემდეგ Route Studio-ში მონიშნე");
  }

  function addCheckpoint(
    type: InstructionType,
    title: string,
    voice = title
  ) {
    const checkpointSample = recorder.recording ? roadSample : gps.sample;

    if (recorder.recording && !checkpointSample) {
      setStatus("საკონტროლო წერტილის დასამატებლად დაელოდე GPS-ის გზაზე ზუსტად მიბმას");
      return;
    }

    if (!route || !checkpointSample || !requireGoodLocation(true)) return;

    const routeCoordinates = recorder.recording ? recorder.points : route.coordinates;
    const routeMatch = nearestPointOnRoute(checkpointSample, routeCoordinates);
    if (routeMatch.distance > 35 || routeMatch.index < 0) {
      setStatus("საკონტროლო წერტილი მარშრუტის გზიდან 35 მეტრზე შორსაა; გადაამოწმე GPS ან გზა.");
      return;
    }
    const nextCheckpoint: RouteCheckpoint = {
      orderIndex: route.checkpoints.length,
      lng: routeMatch.point.lng,
      lat: routeMatch.point.lat,
      type,
      title,
      voice,
      ttsVoice: "ka-GE-EkaNeural",
      speedLimit: null,
      triggerMeters: 120,
      routeCoordinateIndex: routeMatch.index,
    };

    setRoute({
      ...route,
      checkpoints: [...route.checkpoints, nextCheckpoint],
    });

    setDirty(true);
    setStatus(
      `საკონტროლო წერტილი #${route.checkpoints.length + 1} დაემატა`
    );
  }


  function removeLastCheckpoint() {
    if (!route?.checkpoints.length) return;

    setRoute({
      ...route,
      checkpoints: route.checkpoints
        .slice(0, -1)
        .map((item, index) => ({ ...item, orderIndex: index })),
    });
    setDirty(true);
    setStatus("ბოლო საკონტროლო წერტილი წაიშალა");
  }

  async function restoreDraft() {
    if (!draft || !route) return;
    if (!requireGoodLocation()) return;

    if (
      draft.routeVersion != null &&
      draft.routeVersion !== route.version
    ) {
      setStatus(
        `დრაფტი შეიქმნა მარშრუტის v${draft.routeVersion}-ზე, სერვერზე კი უკვე v${route.version} არის. ძველი დრაფტის პირდაპირ აღდგენა დაბლოკილია, რომ ახალი ცვლილებები არ გადაიწეროს.`
      );
      return;
    }

    if (draft.points.length && !gps.sample) {
      setStatus("ჩანაწერის გასაგრძელებლად ჯერ GPS პოზიციას დაელოდე");
      return;
    }

    const lastPoint = draft.points.at(-1);
    if (lastPoint && gps.sample) {
      const resumeDistance = haversineMeters(
        { lng: lastPoint[0], lat: lastPoint[1] },
        gps.sample
      );

      if (resumeDistance > 25) {
        setStatus(
          `დრაფტის ბოლო წერტილიდან ${Math.round(resumeDistance)} მეტრით ხარ დაშორებული. დაბრუნდი ბოლო ადგილზე, რომ გზა შემთხვევითი ხაზით არ შეერთდეს.`
        );
        return;
      }
    }

    await recorder.startFrom(draft.points, draft.recording);
    setRoute({ ...route, checkpoints: draft.checkpoints });
    setDirty(true);
    setStatus("ჩანაწერი აღდგა • GPS მონაკვეთი ინახება და გზაზე მიბმა მოწმდება");
  }

  function discardDraft() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setDraft(null);
    setStatus("ლოკალური ჩანაწერი წაიშალა");
  }

  async function saveFieldRoute() {
    if (!route?.id) return;

    setSaving(true);
    try {
      if (recorder.recording && !recorder.paused) await recorder.pause();
      const hasNewRecording = recorder.stats.acceptedSamples > 0 || recorder.points.length >= 2;
      const coordinates = hasNewRecording ? await recorder.flush() : route.coordinates;
      if (coordinates.length < 2) throw new Error("შესანახად ჯერ დადასტურებული გზა უნდა ჩაიწეროს");
      const waypoints = hasNewRecording
        ? downsampleCoordinates(coordinates, ROUTING_WAYPOINT_LIMIT)
        : route.waypoints;

      const mapped = remapRouteReferences(
        route.coordinates,
        coordinates,
        route.checkpoints.map((checkpoint, index) => ({ ...checkpoint, orderIndex: index })),
        route.speedZones
      );
      const checkpoints = mapped.checkpoints;

      const saved = await routeService.save(route.id, {
        name: route.name,
        city: route.city,
        description: route.description,
        isPublished: route.isPublished,
        waypoints,
        waypointCoordinateIndices: hasNewRecording ? undefined : route.waypointCoordinateIndices,
        coordinates,
        speedZones: mapped.speedZones,
        checkpoints,
      }, route.version);

      setRoute(saved);
      await recorder.stop();
      recorder.setPoints(saved.coordinates);
      setDirty(false);

      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }

      setDraft(null);
      setStatus(`გზის ჩანაწერი შენახულია • მარშრუტის ვერსია v${saved.version}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "ROUTE_VERSION_CONFLICT") {
        setStatus("მარშრუტი სხვა ჩანართში შეიცვალა. ჩანაწერი შენარჩუნებულია — ჯერ განაახლე მარშრუტი და შემდეგ სცადე შენახვა.");
      } else {
        setStatus(
          error instanceof Error ? error.message : "გზის შენახვა ვერ მოხერხდა"
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function downloadGpsDiagnostics() {
    const blob = new Blob([JSON.stringify({ version: 1, release: "R35", routeId, routeVersion: route?.version,
      recordedAt: new Date().toISOString(), coordinates: recorder.points, recording: recorder.snapshot() }, null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `DriveExam-field-GPS-${routeId}-${Date.now()}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function finishConfirmedPart() {
    if (!confirm("გზის ხაზში მხოლოდ დადასტურებული ნაწილი დარჩება; საეჭვო ბოლო ნაწილი გამოირიცხება. GPS დიაგნოსტიკა შენარჩუნდება. გავაგრძელოთ?")) return;
    recorder.finishConfirmedPart();
    setStatus("დარჩა მხოლოდ დადასტურებული ნაწილი • დაკარგული მონაკვეთი შენახვამდე რედაქტორში გადაამოწმე");
  }

  const recorderState = recorder.recording
    ? recorder.paused
      ? "პაუზა"
      : "იწერება"
    : recorder.points.length
      ? "ჩაწერილია"
      : "მზადაა";
  const fieldWarning = draftStorageFailed
    ? "დრაფტი ვერ შეინახა ბრაუზერმა — გვერდის დახურვამდე ჩამოტვირთე GPS დიაგნოსტიკა"
    : gps.diagnostics.isStale
      ? "GPS მონაცემი მოძველებულია — ბოლო დადასტურებული პოზიცია ჩანს"
      : (recorder.recording || recorder.pendingCount > 0 || recorder.hasGap) && recorder.issue && recorder.issue !== "stationary"
        ? roadLockWarning
        : !hasGoodGps && (gps.sample || gps.rawSample)
          ? `GPS სიზუსტე ჯერ არასაკმარისია${rawAccuracy != null ? ` ±${Math.round(rawAccuracy)}მ` : ""} — ახალ სანდო პოზიციას ველოდებით`
          : null;

  return (
    <div
      className={`field-layout field-v14-layout ${
        mobileDockOpen ? "field-v19-mobile-dock-open" : ""
      }`}
    >
      <section className="field-map-stage field-v14-map-stage">
        <div ref={mapEl} className="map-canvas" />

        <MapThemeControl
          mode={mapThemeMode}
          resolvedTheme={resolvedTheme}
          onChange={setMapThemeMode}
          compact
        />

        <div className="field-v14-top-status">
          <Badge
            tone={
              hasRejectedCoarseLocation
                ? "warning"
                : gpsTone(gps.diagnostics.quality)
            }
          >
            <Signal size={13} /> {locationStatusLabel}
          </Badge>

          <Badge tone={recorder.recording && !recorder.paused ? "success" : "neutral"}>
            <span className={`field-v14-rec-dot ${recorder.recording && !recorder.paused ? "live" : ""}`} />
            {recorderState}
          </Badge>

          {gps.diagnostics.isStale && (
            <Badge tone="danger">
              <CloudOff size={13} /> GPS მოძველებულია
            </Badge>
          )}
        </div>

        <Surface className="field-v14-hud">
          <div className="field-v14-hud-title">
            <small>FIELD RECORDER</small>
            <h2>{route?.name || "მარშრუტი"}</h2>
            <span>{status}</span>
          </div>

          <div className="field-v14-hud-metrics">
            <Metric label="დრო" value={formatDuration(recorder.stats.durationSeconds)} />
            <Metric label="მანძილი" value={formatDistance(recorder.stats.distanceMeters)} />
            <Metric label="გზის წერტილები" value={recorder.points.length} />
            <Metric label="Checkpoints" value={route?.checkpoints.length ?? 0} />
          </div>
        </Surface>

        {shouldShowLocationPrompt && (
          <Surface className="field-v19-location-prompt">
            <div className="field-v19-location-prompt-icon">
              <LocateFixed size={20} />
            </div>
            <div>
              <b>
                {locationPromptDenied
                  ? "ლოკაციაზე წვდომა გამორთულია"
                  : locationRequested
                    ? "ლოკაციას ველოდებით..."
                    : "ჩართე შენი მდებარეობა"}
              </b>
              <small>
                {locationPromptDenied
                  ? "ბრაუზერის Site settings-ში Location ჩართე და შემდეგ ისევ სცადე."
                  : "Field Recorder-ს რეალური GPS სჭირდება. ღილაკზე დაჭერისას ბრაუზერი Location ნებართვას მოგთხოვს."}
              </small>
            </div>
            <button type="button" onClick={requestLocation}>
              <LocateFixed size={15} />
              {locationPromptDenied ? "თავიდან ცდა" : "ლოკაციის ჩართვა"}
            </button>
          </Surface>
        )}

        {gps.error && (
          <Surface className="field-v14-gps-error">
            <AlertTriangle size={18} />
            <div>
              <b>GPS ვერ ჩაირთო</b>
              <small>{gps.error.message}</small>
            </div>
            <Button variant="secondary" onClick={requestLocation}>
              <RotateCcw size={15} /> თავიდან ცდა
            </Button>
          </Surface>
        )}

        {fieldWarning && !gps.error && (
          <div className="field-v14-accuracy-warning field-v18-accuracy-warning field-gps-status" role="status">
            <AlertTriangle size={14} />
            <span>
              {fieldWarning}
            </span>
            {hasRejectedCoarseLocation && (
              <button type="button" onClick={requestLocation}>
                <RotateCcw size={13} />
                თავიდან მოთხოვნა
              </button>
            )}
          </div>
        )}

        <div className="field-v14-map-controls">
          {!recorder.recording ? (
            <Button onClick={startNewRecording} disabled={saving}>
              <Play size={18} /> ახალი ჩაწერის დაწყება
            </Button>
          ) : recorder.paused ? (
            <Button onClick={recorder.resume} disabled={saving || recorder.matching}>
              <Play size={18} /> გაგრძელება
            </Button>
          ) : (
            <Button variant="secondary" onClick={recorder.pause} disabled={saving}>
              <Pause size={18} /> პაუზა
            </Button>
          )}

          {recorder.recording && (
            <Button variant="danger" onClick={recorder.stop} disabled={saving}>
              <Check size={17} /> ჩაწერის დასრულება
            </Button>
          )}
        </div>

        <button
          type="button"
          className="field-v19-mobile-dock-toggle"
          onClick={() => setMobileDockOpen(true)}
          aria-expanded={mobileDockOpen}
          aria-controls="field-recorder-controls"
        >
          <span className="field-v19-mobile-dock-toggle-icon">
            <SlidersHorizontal size={17} />
          </span>
          <span>
            <small>Field Recorder</small>
            <b>სწრაფი მოქმედებები</b>
          </span>
          <span className={canPlaceCheckpoint ? "ready" : "wait"}>
            {route?.checkpoints.length ?? 0}
          </span>
        </button>
      </section>

      <aside
        id="field-recorder-controls"
        className={`field-action-dock field-v14-dock ${
          mobileDockOpen ? "mobile-open" : ""
        }`}
      >
        <button
          type="button"
          className="field-v19-mobile-dock-close"
          onClick={() => setMobileDockOpen(false)}
          aria-label="კონტროლების დახურვა"
        >
          <span>კონტროლები</span>
          <X size={17} />
        </button>
        {draft && !dirty && (draft.points.length > 0 || Boolean(draft.recording?.observations.length)) && (
          <Surface className="field-v14-draft-card">
            <div>
              <small>დაუმთავრებელი ჩანაწერი</small>
              <b>{draft.points.length} GPS წერტილი</b>
              <span>
                {new Date(draft.savedAt).toLocaleString("ka-GE")}
              </span>
            </div>
            <div>
              <button onClick={restoreDraft}>აღდგენა</button>
              <button onClick={discardDraft}>წაშლა</button>
            </div>
          </Surface>
        )}

        <div className="field-v14-dock-head">
          <div>
            <small>სწრაფი მოქმედებები</small>
            <h2>რას აკეთებს მძღოლი აქ?</h2>
            <p>
              საჭირო ღილაკს დააჭირე ზუსტად იმ ადგილზე, სადაც ინსტრუქცია უნდა დაფიქსირდეს.
            </p>
          </div>
          <div className={`field-v14-location-light ${canPlaceCheckpoint ? "ready" : "wait"}`}>
            <LocateFixed size={18} />
          </div>
        </div>

        <div className="field-checkpoint-grid field-v14-checkpoint-grid">
          <button disabled={!canPlaceCheckpoint} onClick={() => addCheckpoint("left", "მოუხვიეთ მარცხნივ", DEFAULT_LEFT_RECORDED_PHRASE)}>
            <span>↰</span>მარცხნივ
          </button>
          <button disabled={!canPlaceCheckpoint} onClick={() => addCheckpoint("right", "მოუხვიეთ მარჯვნივ", DEFAULT_RIGHT_RECORDED_PHRASE)}>
            <span>↱</span>მარჯვნივ
          </button>
          <button disabled={!canPlaceCheckpoint} onClick={() => addCheckpoint("straight", "გააგრძელეთ პირდაპირ", DEFAULT_STRAIGHT_RECORDED_PHRASE)}>
            <span>↑</span>პირდაპირ
          </button>
          <button disabled={!canPlaceCheckpoint} onClick={() => addCheckpoint("stop", "გაჩერდით STOP ნიშნთან")}>
            <span>■</span>STOP
          </button>
          <button disabled={!canPlaceCheckpoint} onClick={() => addCheckpoint("warning", "ყურადღება")}>
            <span>!</span>ყურადღება
          </button>
          <button disabled={!route?.checkpoints.length} onClick={removeLastCheckpoint}>
            <span>↶</span>ბოლო წაშალე
          </button>
        </div>


        <div className="field-v14-speed-note">სიჩქარის ზონები Route Studio-ში, ზუსტად მარშრუტის მონაკვეთებზე მონიშნე.</div>

        <div className="field-v14-diagnostics">
          <div>
            <span>GPS მიღებული</span>
            <b>{gps.diagnostics.acceptedSamples}</b>
          </div>
          <div>
            <span>უარყოფილი</span>
            <b>{gps.diagnostics.rejectedSamples + recorder.stats.rejectedSamples}</b>
          </div>
          <div>
            <span>გზის მოლოდინში</span>
            <b>{recorder.pendingCount}</b>
          </div>
        </div>

        <Surface className="current-location-box field-v14-location-box">
          <MapPin size={18} />
          <div>
            <b>
              {gps.sample
                ? `${gps.sample.lat.toFixed(6)}, ${gps.sample.lng.toFixed(6)}`
                : hasRejectedCoarseLocation
                  ? "ზუსტი მდებარეობა ჯერ არ მიღებულა"
                  : "GPS ველოდებით..."}
            </b>
            <small>
              {gps.sample
                ? accuracy == null
                  ? "მიმდინარე GPS მდებარეობა"
                  : `სიზუსტე ±${Math.round(accuracy)}მ`
                : hasRejectedCoarseLocation
                  ? `ბოლო პასუხი ±${Math.round(rawAccuracy!)}მ — უარყოფილია`
                  : "მიმდინარე GPS მდებარეობა"}
            </small>
          </div>
          {hasRejectedCoarseLocation ? (
            <button
              type="button"
              className="field-v18-location-retry"
              onClick={requestLocation}
              title="მდებარეობის თავიდან მოთხოვნა"
            >
              <RotateCcw size={16} />
            </button>
          ) : (
            <CarFront size={17} />
          )}
        </Surface>

        {recorder.pendingCount > 0 && (
          <Button variant="secondary" onClick={recorder.retryMatching} disabled={recorder.matching}>
            <RotateCcw size={16} /> {recorder.matching ? "გზა მოწმდება..." : "გზაზე მიბმის ხელახლა ცდა"}
          </Button>
        )}
        {(!recorder.recording || recorder.paused) && (recorder.pendingCount > 0 || recorder.hasGap) && recorder.points.length >= 2 && (
          <Button variant="secondary" onClick={finishConfirmedPart} disabled={saving || recorder.matching}>
            <Check size={16} /> მხოლოდ დადასტურებული ნაწილით დასრულება
          </Button>
        )}
        {recorder.stats.acceptedSamples > 0 && (
          <Button variant="secondary" onClick={downloadGpsDiagnostics}>
            <Download size={16} /> GPS დიაგნოსტიკის ჩამოტვირთვა
          </Button>
        )}

        <Button
          className="field-save-button field-v14-save"
          onClick={saveFieldRoute}
          disabled={!route || saving || recorder.matching}
        >
          <Save size={18} />
          {saving ? "ინახება..." : "გზისა და წერტილების შენახვა"}
        </Button>
      </aside>
    </div>
  );
}
