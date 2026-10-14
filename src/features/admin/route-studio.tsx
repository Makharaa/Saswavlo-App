"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { GeoJSONSource, Map, Marker } from "maplibre-gl";
import { configureMapLibreWorker } from "@/utils/maplibre-runtime";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  CircleDot,
  Crosshair,
  Download,
  GitBranch,
  LocateFixed,
  MapPinned,
  Play,
  Plus,
  Radio,
  Redo2,
  RefreshCw,
  Route as RouteIcon,
  Save,
  Trash2,
  Undo2,
  Volume2,
} from "lucide-react";
import Link from "next/link";

import { Button, Surface } from "@/components/ui";
import { MapThemeControl } from "@/components/map-theme-control";
import { AppSelect } from "@/components/app-select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { mapEngineService } from "@/services/map-engine";
import { routeDrivingFingerprint } from "@/utils/route-readiness";
import { useMapTheme } from "@/hooks/use-map-theme";
import { installNavigationMapStyle } from "@/utils/maplibre-style-guard";
import { addNavigationRouteLayers } from "@/utils/navigation-route-style";
import { editorCenterlineLayers, setEditorCenterlineVisibility } from "@/utils/editor-centerline";
import { BUNDLED_ROUTES, type BundledRouteSource } from "@/lib/route-import-catalog";
import { CITY_ROUTES } from "@/lib/city-route-catalog";
import { CitySelect } from "@/components/city-select";
import { cityCenter, readCurrentUserId, readSelectedCity, writeSelectedCity } from "@/utils/selected-city";
import { ApiError, routeService } from "@/services/routes";
import { speakGeorgian } from "@/services/speech";
import {
  DEFAULT_STRAIGHT_RECORDED_PHRASE,
  RECORDED_CHECKPOINT_PROMPTS,
  getRecordedCheckpointPrompt,
} from "@/lib/recorded-voice-catalog";
import type {
  ExamRoute,
  RouteCheckpoint,
  RouteSpeedZone,
  RouteVersionSummary,
} from "@/types/domain";
import {
  createCirclePolygon,
  remapRouteReferences,
  speedZoneFeatures,
  validateRoute,
} from "@/utils/route-engine";
import { nearestPointOnRoute, nearestPointOnRouteRange, routeCumulativeDistances } from "@/utils/geo";
import {
  appendRouteWaypoint,
  editorWaypoints,
  moveRouteWaypoint,
  manualRouteLeg,
  pinRouteLeg,
  removeLastRouteWaypoint,
  routeLegDetour,
  RouteEditQueue,
  type RouteLegRouter,
} from "@/utils/route-editor";

type EditorMode = "path" | "checkpoint";
type DrawingMode = "automatic" | "manual";
type RouteReview = {
  coordinates: [number, number][];
  distanceMeters: number;
  resolve: (accept: boolean) => void;
  manualAction: () => void;
};
type SidebarTab = "route" | "checkpoints" | "speed";
type SpeedBoundary = "start" | "end";
type SpeedPick = { zoneId: string; boundary: SpeedBoundary } | null;

function cloneRoute(route: ExamRoute): ExamRoute {
  return JSON.parse(JSON.stringify(route)) as ExamRoute;
}

function routeFingerprint(route: ExamRoute) {
  return JSON.stringify({
    name: route.name,
    city: route.city,
    description: route.description,
    isPublished: route.isPublished,
    fieldTestedAt: route.fieldTestedAt ?? null,
    waypoints: route.waypoints,
    waypointCoordinateIndices: route.waypointCoordinateIndices,
    coordinates: route.coordinates,
    speedZones: route.speedZones,
    checkpoints: route.checkpoints.map(({ id: _id, routeId: _routeId, ...checkpoint }) => checkpoint),
  });
}

function routePathFingerprint(route: ExamRoute) {
  return JSON.stringify([route.id, route.waypoints, route.coordinates, route.waypointCoordinateIndices]);
}

function getRouteBounds(coordinates: [number, number][]) {
  if (!coordinates.length) return null;
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  coordinates.slice(1).forEach((coordinate) => bounds.extend(coordinate));
  return bounds;
}

function makeMarkerElement(className: string, label?: string) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.addEventListener("click", (event) => event.stopPropagation());
  if (label) el.textContent = label;
  return el;
}

export function RouteStudio() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const routeRef = useRef<ExamRoute | null>(null);
  const checkpointMarkers = useRef<Marker[]>([]);
  const waypointMarkers = useRef<Marker[]>([]);
  const endpointMarkers = useRef<Marker[]>([]);
  const modeRef = useRef<EditorMode>("path");
  const drawingModeRef = useRef<DrawingMode>("automatic");
  const routeReviewRef = useRef<RouteReview | null>(null);
  const editQueueRef = useRef<RouteEditQueue | null>(null);
  const speedPickRef = useRef<SpeedPick>(null);
  const lastFocusedRouteId = useRef<number | null>(null);
  const selectedPointRef = useRef(0);
  const savedFingerprintRef = useRef("");

  const [routes, setRoutes] = useState<ExamRoute[]>([]);
  const [route, setRoute] = useState<ExamRoute | null>(null);
  const [selectedPoint, setSelectedPoint] = useState(0);
  const [mode, setMode] = useState<EditorMode>("path");
  const [showEditCenterline, setShowEditCenterline] = useState(false);
  const showEditCenterlineRef = useRef(false);
  const [drawingMode, setDrawingMode] = useState<DrawingMode>("automatic");
  const [routeReview, setRouteReview] = useState<RouteReview | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("checkpoints");
  const [status, setStatus] = useState("იტვირთება...");
  const [saving, setSaving] = useState(false);
  const [routing, setRouting] = useState(false);
  if (!editQueueRef.current) editQueueRef.current = new RouteEditQueue(setRouting);
  const [historyPast, setHistoryPast] = useState<ExamRoute[]>([]);
  const [historyFuture, setHistoryFuture] = useState<ExamRoute[]>([]);
  const [serverVersions, setServerVersions] = useState<RouteVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [importing, setImporting] = useState(false);
  const importLockRef = useRef(false);
  const [importSource, setImportSource] = useState<BundledRouteSource>("simulatori-gori-route-1");
  const [editorCity, setEditorCity] = useState("გორი");
  const [cityReady, setCityReady] = useState(false);
  const [knownCities, setKnownCities] = useState<string[]>([]);
  const editorCityRef = useRef("გორი");
  const [importError, setImportError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingRoute, setDeletingRoute] = useState(false);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [speedPick, setSpeedPick] = useState<SpeedPick>(null);

  const { mode: mapThemeMode, resolvedTheme, styleUrl, setMode: setMapThemeMode } = useMapTheme();

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => () => {
    editQueueRef.current?.invalidate();
    routeReviewRef.current?.resolve(false);
    routeReviewRef.current = null;
  }, []);

  useEffect(() => {
    setSpeedPick(null);
  }, [route?.id]);

  useEffect(() => {
    selectedPointRef.current = selectedPoint;
  }, [selectedPoint]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    speedPickRef.current = speedPick;
  }, [speedPick]);

  const validation = useMemo(() => (route ? validateRoute(route) : []), [route]);
  const validationErrors = validation.filter((issue) => issue.level === "error");
  const isDirty = useMemo(
    () => Boolean(route && routeFingerprint(route) !== savedFingerprintRef.current),
    [route]
  );

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    const id = route?.id;
    if (!id) {
      setServerVersions([]);
      return;
    }

    let cancelled = false;
    setVersionsLoading(true);
    routeService
      .versions(id, 8)
      .then((items) => {
        if (!cancelled) setServerVersions(items);
      })
      .catch(() => {
        if (!cancelled) setServerVersions([]);
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [route?.id, route?.version]);

  function assignRoute(next: ExamRoute | null) {
    routeRef.current = next;
    setRoute(next);
  }

  function markRouteClean(next: ExamRoute | null) {
    cancelPendingEdits();
    savedFingerprintRef.current = next ? routeFingerprint(next) : "";
    setConflictVersion(null);
    assignRoute(next);
  }

  function canDiscardUnsavedChanges() {
    return (
      !isDirty ||
      window.confirm(
        "ამ მარშრუტზე შეუნახავი ცვლილებები გაქვს. თუ გააგრძელებ, ისინი დაიკარგება. გავაგრძელოთ?"
      )
    );
  }

  function clearMapVisuals() {
    const map = mapRef.current;

    checkpointMarkers.current.forEach((marker) => marker.remove());
    checkpointMarkers.current = [];

    waypointMarkers.current.forEach((marker) => marker.remove());
    waypointMarkers.current = [];

    endpointMarkers.current.forEach((marker) => marker.remove());
    endpointMarkers.current = [];

    if (!map) return;

    const routeSource = map.getSource("studio-route") as GeoJSONSource | undefined;
    routeSource?.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [] },
    });

    const zonesSource = map.getSource("studio-speed-zones") as GeoJSONSource | undefined;
    zonesSource?.setData({
      type: "FeatureCollection",
      features: [],
    });

    const triggerSource = map.getSource("studio-trigger") as GeoJSONSource | undefined;
    triggerSource?.setData({
      type: "FeatureCollection",
      features: [],
    });
  }

  function renderCurrentRouteVisuals() {
    const map = mapRef.current;
    const currentRoute = routeRef.current;
    const currentSelectedPoint = selectedPointRef.current;

    if (!map) return false;

    const routeSource = map.getSource("studio-route") as GeoJSONSource | undefined;
    const zonesSource = map.getSource("studio-speed-zones") as GeoJSONSource | undefined;
    const triggerSource = map.getSource("studio-trigger") as GeoJSONSource | undefined;

    // During the first map/style load the custom sources do not exist yet.
    // The map "load" callback will call this function again using the latest routeRef.
    if (!routeSource || !zonesSource || !triggerSource) return false;

    checkpointMarkers.current.forEach((marker) => marker.remove());
    checkpointMarkers.current = [];

    waypointMarkers.current.forEach((marker) => marker.remove());
    waypointMarkers.current = [];

    endpointMarkers.current.forEach((marker) => marker.remove());
    endpointMarkers.current = [];

    if (!currentRoute) {
      routeSource.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [] },
      });
      zonesSource.setData({
        type: "FeatureCollection",
        features: [],
      });
      triggerSource.setData({
        type: "FeatureCollection",
        features: [],
      });
      return true;
    }

    routeSource.setData({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: currentRoute.coordinates,
      },
    });

    zonesSource.setData(
      speedZoneFeatures(
        currentRoute.coordinates,
        currentRoute.speedZones
      ) as any
    );

    const selected =
      currentRoute.checkpoints[currentSelectedPoint] ?? null;

    triggerSource.setData(
      selected
        ? {
            type: "FeatureCollection",
            features: [
              createCirclePolygon(selected, selected.triggerMeters),
            ],
          }
        : {
            type: "FeatureCollection",
            features: [],
          }
    );

    currentRoute.checkpoints.forEach((checkpoint, index) => {
      const el = makeMarkerElement(
        `studio-marker-v11 ${
          currentSelectedPoint === index ? "active" : ""
        }`,
        String(index + 1)
      );

      el.title = checkpoint.title;
      el.onclick = (event) => {
        event.stopPropagation();
        selectedPointRef.current = index;
        setSelectedPoint(index);
        setSidebarTab("checkpoints");
      };

      const marker = new maplibregl.Marker({
        element: el,
        draggable: true,
        anchor: "center",
      })
        .setLngLat([checkpoint.lng, checkpoint.lat])
        .addTo(map);

      marker.on("dragend", () => {
        const latest = routeRef.current;
        if (!latest) return;

        const pos = marker.getLngLat();
        const routeMatch = latest.coordinates.length
          ? nearestPointOnRoute(
              { lng: pos.lng, lat: pos.lat },
              latest.coordinates
            )
          : null;
        const snapped = routeMatch?.point ?? { lng: pos.lng, lat: pos.lat };

        commitRoute(
          {
            ...latest,
            checkpoints: latest.checkpoints.map((item, itemIndex) =>
              itemIndex === index
                ? {
                    ...item,
                    lng: snapped.lng,
                    lat: snapped.lat,
                    routeCoordinateIndex: routeMatch?.index ?? null,
                  }
                : item
            ),
          },
          `საკონტროლო წერტილი #${index + 1} გადაადგილდა`
        );
      });

      checkpointMarkers.current.push(marker);
    });

    const allWaypoints = editorWaypoints(currentRoute);

    const stride = Math.max(
      1,
      Math.ceil(allWaypoints.length / 50)
    );

    allWaypoints.forEach((waypoint, index) => {
      const isLast = index === allWaypoints.length - 1;
      if (index !== 0 && !isLast && index % stride !== 0) return;

      const el = makeMarkerElement("studio-waypoint-v11");
      el.title = `საყრდენი წერტილი #${index + 1}`;

      const marker = new maplibregl.Marker({
        element: el,
        draggable: true,
        anchor: "center",
      })
        .setLngLat(waypoint)
        .addTo(map);

      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        void updateWaypointPosition(index, [pos.lng, pos.lat]);
      });

      waypointMarkers.current.push(marker);
    });

    if (currentRoute.coordinates.length) {
      const startEl = makeMarkerElement(
        "studio-endpoint-v11 start",
        "S"
      );
      startEl.title = "დაწყება";

      endpointMarkers.current.push(
        new maplibregl.Marker({
          element: startEl,
          anchor: "center",
        })
          .setLngLat(currentRoute.coordinates[0])
          .addTo(map)
      );

      if (currentRoute.coordinates.length > 1) {
        const finishEl = makeMarkerElement(
          "studio-endpoint-v11 finish",
          "F"
        );
        finishEl.title = "ფინიში";

        endpointMarkers.current.push(
          new maplibregl.Marker({
            element: finishEl,
            anchor: "center",
          })
            .setLngLat(
              currentRoute.coordinates[
                currentRoute.coordinates.length - 1
              ]
            )
            .addTo(map)
        );
      }
    }

    return true;
  }

  function commitRoute(next: ExamRoute, message?: string) {
    const current = routeRef.current;
    if (current) {
      setHistoryPast((items) => [...items.slice(-39), cloneRoute(current)]);
      if (JSON.stringify(current.coordinates) !== JSON.stringify(next.coordinates)) {
        const mapped = remapRouteReferences(
          current.coordinates,
          next.coordinates,
          next.checkpoints,
          next.speedZones
        );
        next = { ...next, checkpoints: mapped.checkpoints, speedZones: mapped.speedZones };
      }
    }
    if (current && routeDrivingFingerprint(current) !== routeDrivingFingerprint(next)) next = { ...next, fieldTestedAt: null };
    setHistoryFuture([]);
    assignRoute(next);
    if (message) setStatus(message);
  }

  function updateRouteDirect(next: ExamRoute) {
    if (routeRef.current && routeDrivingFingerprint(routeRef.current) !== routeDrivingFingerprint(next)) next = { ...next, fieldTestedAt: null };
    assignRoute(next);
  }

  function undo() {
    const hadPendingEdits = editQueueRef.current?.busy;
    cancelPendingEdits();
    const current = routeRef.current;
    if (!current || !historyPast.length) {
      if (hadPendingEdits) setStatus("მიმდინარე მონიშვნა გაუქმდა");
      renderCurrentRouteVisuals();
      return;
    }
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((items) => items.slice(0, -1));
    setHistoryFuture((items) => [cloneRoute(current), ...items.slice(0, 39)]);
    assignRoute(cloneRoute(previous));
    setStatus("ბოლო ცვლილება გაუქმდა");
  }

  function redo() {
    cancelPendingEdits();
    const current = routeRef.current;
    if (!current || !historyFuture.length) return;
    const next = historyFuture[0];
    setHistoryFuture((items) => items.slice(1));
    setHistoryPast((items) => [...items.slice(-39), cloneRoute(current)]);
    assignRoute(cloneRoute(next));
    setStatus("ცვლილება აღდგა");
  }

  async function reload(preferredId?: number, cityName = editorCityRef.current) {
    try {
      const list = await routeService.list(`?city=${encodeURIComponent(cityName)}`);
      setRoutes(list);
      const next = list.find((item) => item.id === preferredId) || list[0] || null;
      clearMapVisuals();
      markRouteClean(next);
      setSelectedPoint(0);
      setHistoryPast([]);
      setHistoryFuture([]);
      lastFocusedRouteId.current = null;
      setStatus(next ? "მარშრუტების რედაქტორი მზადაა" : "მარშრუტი ჯერ არ არის");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "სერვერთან კავშირი ვერ მოხერხდა");
    }
  }

  useEffect(() => {
    const stored = readSelectedCity(readCurrentUserId()) || "გორი";
    editorCityRef.current = stored;
    setEditorCity(stored);
    setCityReady(true);
    void routeService.cities(false).then(setKnownCities).catch(() => setKnownCities([]));
  }, []);

  useEffect(() => {
    if (!cityReady) return;
    void reload(undefined, editorCity);
  }, [cityReady, editorCity]);

  async function snapAnchor(coordinate: [number, number]) {
    try {
      // A wide nearest-road search can silently choose a parallel street.
      // Keep the editor lock tight and require the click to be close to a road.
      const snapped = await mapEngineService.snap(coordinate[0], coordinate[1], {
        radiusMeters: 10,
      });
      if (snapped.distance > 8) {
        throw new Error(
          `წერტილი გზიდან ${Math.round(snapped.distance)} მ-ითაა დაშორებული. მიუახლოვდი გზას და მონიშნე თავიდან.`
        );
      }
      return snapped;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("წერტილი გზიდან")) throw error;
      throw new Error("გზაზე მიბმა ვერ შესრულდა. შეამოწმე კავშირი და სცადე თავიდან.");
    }
  }

  function renderRouteReview() {
    const source = mapRef.current?.getSource("studio-route-proposal") as GeoJSONSource | undefined;
    source?.setData({ type: "Feature", properties: {}, geometry: {
      type: "LineString", coordinates: routeReviewRef.current?.coordinates ?? [],
    } });
  }

  function finishRouteReview(accept: boolean) {
    const pending = routeReviewRef.current;
    routeReviewRef.current = null;
    setRouteReview(null);
    renderRouteReview();
    pending?.resolve(accept);
  }

  function cancelPendingEdits() {
    editQueueRef.current?.invalidate();
    finishRouteReview(false);
  }

  function changeDrawingMode(next: DrawingMode) {
    cancelPendingEdits();
    drawingModeRef.current = next;
    setDrawingMode(next);
    setMode("path");
    setSpeedPick(null);
    setStatus(next === "manual" ? "ხელით მონიშვნა: გზის მოხაზულობას მიჰყევი მოკლე მონაკვეთებით" : "ავტომატური მონიშვნა: ახალი წერტილი არსებულ გზას დაემატება");
    renderCurrentRouteVisuals();
  }

  function createLegRouter(selectedMode: DrawingMode, isCurrent: () => boolean, manualAction: () => void): RouteLegRouter {
    if (selectedMode === "manual") return manualRouteLeg;
    return async (endpoints, options) => {
      const result = await mapEngineService.routeLeg(endpoints, options);
      if (!isCurrent()) throw new Error("მონიშვნა გაუქმდა");
      const coordinates = pinRouteLeg(...endpoints, result.coordinates);
      const detour = routeLegDetour(endpoints, coordinates);
      if (detour) {
        const accepted = await new Promise<boolean>((resolve) => {
          const pending = { coordinates, distanceMeters: detour.distanceMeters, resolve, manualAction };
          routeReviewRef.current = pending;
          setRouteReview(pending);
          renderRouteReview();
          setStatus("რუკამ შემოვლა შემოგთავაზა — აირჩიე გაგრძელების გზა");
        });
        if (!accepted) throw new Error("შემოთავაზებული მონაკვეთი გაუქმდა");
      }
      return coordinates;
    };
  }

  function queueRouteEdit(
    prepare: (current: ExamRoute, isCurrent: () => boolean) => Promise<Partial<ExamRoute> | ((latest: ExamRoute) => Partial<ExamRoute>)>,
    message: string | ((next: ExamRoute) => string)
  ) {
    return editQueueRef.current!.enqueue(async (isCurrent) => {
      const current = routeRef.current;
      if (!current) return;
      const pathFingerprint = routePathFingerprint(current);
      setStatus("მონიშვნა მუშავდება...");
      try {
        const patch = await prepare(current, isCurrent);
        const latest = routeRef.current;
        if (!isCurrent() || !latest || routePathFingerprint(latest) !== pathFingerprint) return;
        const next = { ...latest, ...(typeof patch === "function" ? patch(latest) : patch) };
        commitRoute(next, typeof message === "function" ? message(next) : message);
      } catch (error) {
        if (!isCurrent()) return;
        setStatus(error instanceof Error ? error.message : "მონიშვნა ვერ შესრულდა — სცადე თავიდან.");
        renderCurrentRouteVisuals();
      }
    });
  }

  function addWaypoint(coordinate: [number, number], selectedMode = drawingModeRef.current) {
    return queueRouteEdit(async (current, isCurrent) => {
      const snapped = selectedMode === "manual" ? { coordinate, hint: undefined } : await snapAnchor(coordinate);
      if (!isCurrent()) return {};
      const router = createLegRouter(selectedMode, isCurrent, () => {
        changeDrawingMode("manual");
        void addWaypoint(coordinate, "manual");
      });
      return appendRouteWaypoint(current, snapped.coordinate, router, snapped.hint);
    }, (next) => `საყრდენი წერტილი #${next.waypoints.length} დაემატა`);
  }

  async function addCheckpoint(coordinate: [number, number]) {
    return queueRouteEdit(async (current) => {
      let point = { lng: coordinate[0], lat: coordinate[1] };
      let routeCoordinateIndex: number | null = null;
      if (current.coordinates.length) {
        const routeMatch = nearestPointOnRoute(point, current.coordinates);
        point = routeMatch.point;
        routeCoordinateIndex = routeMatch.index;
      } else {
        const snapped = await snapAnchor(coordinate);
        point = { lng: snapped.coordinate[0], lat: snapped.coordinate[1] };
      }
      return (latest) => ({ checkpoints: [...latest.checkpoints, {
        orderIndex: latest.checkpoints.length,
        lng: point.lng, lat: point.lat, type: "straight", title: "გააგრძელეთ პირდაპირ",
        voice: DEFAULT_STRAIGHT_RECORDED_PHRASE, ttsVoice: "ka-GE-EkaNeural",
        speedLimit: null, triggerMeters: 120, routeCoordinateIndex,
      }] });
    }, (next) => {
      setSelectedPoint(next.checkpoints.length - 1);
      return `საკონტროლო წერტილი #${next.checkpoints.length} დაემატა`;
    });
  }

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    configureMapLibreWorker();
    const map = new maplibregl.Map({
      container: mapEl.current,
      center: [44.11, 41.98],
      zoom: 13.2,
    });

    const disposeNavigationMapStyle = installNavigationMapStyle(map, styleUrl);

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      map.addSource("studio-route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      });
      // The preview matches the driving/simulation route exactly.
      // The original geographic path remains available as a separate,
      // optional editing guide so clicks and saved checkpoints never move.
      addNavigationRouteLayers(map, "studio-route", "studio-route");
      for (const layer of editorCenterlineLayers("studio-route", showEditCenterlineRef.current)) {
        map.addLayer(layer);
      }
      map.addSource("studio-route-proposal", {
        type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      });
      map.addLayer({
        id: "studio-route-proposal-line", type: "line", source: "studio-route-proposal",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f5ae45", "line-width": 5, "line-dasharray": [2, 2] },
      });
      map.addSource("studio-speed-zones", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "studio-speed-zones-line",
        type: "line",
        source: "studio-speed-zones",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": 5,
          "line-opacity": .95,
          "line-color": [
            "step",
            ["to-number", ["get", "speedLimit"], 50],
            "#27d6a2",
            31, "#6fc6ff",
            41, "#7d88ff",
            51, "#ffbd59",
            71, "#ff6574",
          ],
        },
      });
      map.addSource("studio-trigger", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "studio-trigger-fill",
        type: "fill",
        source: "studio-trigger",
        paint: { "fill-color": "#7d88ff", "fill-opacity": .08 },
      });
      map.addLayer({
        id: "studio-trigger-line",
        type: "line",
        source: "studio-trigger",
        paint: { "line-color": "#7d88ff", "line-width": 2, "line-opacity": .65, "line-dasharray": [3, 2] },
      });

      // Always draw whatever route is current when the style becomes ready.
      renderCurrentRouteVisuals();
      renderRouteReview();
    });

    map.on("click", (event) => {
      if (routeReviewRef.current) {
        setStatus("ჯერ აირჩიე შემოთავაზებული მონაკვეთი ან ხელით მონიშვნა");
        return;
      }
      const coordinate: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      const activeSpeedPick = speedPickRef.current;
      if (activeSpeedPick) {
        pickSpeedZoneBoundary(activeSpeedPick.zoneId, activeSpeedPick.boundary, coordinate);
        return;
      }
      if (modeRef.current === "path") void addWaypoint(coordinate);
      else void addCheckpoint(coordinate);
    });

    mapRef.current = map;
    return () => {
      checkpointMarkers.current.forEach((marker) => marker.remove());
      waypointMarkers.current.forEach((marker) => marker.remove());
      endpointMarkers.current.forEach((marker) => marker.remove());
      disposeNavigationMapStyle();
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  // Toggle only a visual centerline guide; do not mutate route geometry or
  // its saved checkpoints. Default OFF so preview == the driving map.
  useEffect(() => {
    showEditCenterlineRef.current = showEditCenterline;
    setEditorCenterlineVisibility(mapRef.current, showEditCenterline);
  }, [showEditCenterline, styleUrl]);

  async function updateWaypointPosition(waypointIndex: number, coordinate: [number, number], selectedMode = drawingModeRef.current) {
    if (routeReviewRef.current) {
      setStatus("ჯერ აირჩიე შემოთავაზებული მონაკვეთი ან ხელით მონიშვნა");
      renderCurrentRouteVisuals();
      return;
    }
    return queueRouteEdit(async (current, isCurrent) => {
      const snapped = selectedMode === "manual" ? { coordinate, hint: undefined } : await snapAnchor(coordinate);
      if (!isCurrent()) return {};
      const router = createLegRouter(selectedMode, isCurrent, () => {
        changeDrawingMode("manual");
        void updateWaypointPosition(waypointIndex, coordinate, "manual");
      });
      return moveRouteWaypoint(current, waypointIndex, snapped.coordinate, router, snapped.hint);
    }, `საყრდენი წერტილი #${waypointIndex + 1} გადაადგილდა`);
  }

  useEffect(() => {
    // Do not gate this on map.isStyleLoaded().
    // MapLibre can report false while map resources are still loading even
    // though our GeoJSON sources already exist. That was the cause of the
    // "route appears only after clicking a sidebar control" bug.
    renderCurrentRouteVisuals();
  }, [
    route?.id,
    route?.coordinates,
    route?.waypoints,
    route?.speedZones,
    route?.checkpoints,
    selectedPoint,
    resolvedTheme,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route?.id) return;
    if (lastFocusedRouteId.current === route.id) return;
    lastFocusedRouteId.current = route.id;
    const focus = () => {
      const bounds = getRouteBounds(route.coordinates);
      if (bounds && route.coordinates.length > 1) {
        map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: 550 });
      } else if (route.coordinates[0]) {
        map.easeTo({ center: route.coordinates[0], zoom: 15, duration: 450 });
      } else {
        map.easeTo({
          center: cityCenter(editorCityRef.current),
          zoom: 13.2,
          bearing: 0,
          pitch: 0,
          duration: 350,
        });
      }
    };
    // Camera movement is safe here even if map tiles are still loading.
    focus();
  }, [route?.id, resolvedTheme]);

  async function createRoute() {
    if (!canDiscardUnsavedChanges()) return;

    const created = await routeService.create({
      name: `${editorCityRef.current} • მარშრუტი #${routes.length + 1}`,
      city: editorCityRef.current,
      description: "",
      waypoints: [],
      coordinates: [],
      speedZones: [],
      checkpoints: [],
      isPublished: false,
    });
    await reload(created.id);
  }

  async function importBundledRoutes(sources: readonly string[]) {
    if (importLockRef.current || saving || routing || deletingRoute || restoringVersion != null) return;
    if (!canDiscardUnsavedChanges()) return;
    const before = routeRef.current ? routeFingerprint(routeRef.current) : null;
    importLockRef.current = true;
    setImporting(true);
    setImportError(null);
    const results: { route: ExamRoute; reused: boolean }[] = [];
    const errors: string[] = [];
    try {
      for (const source of sources) {
        const entryName = BUNDLED_ROUTES.find((item) => item.source === source)?.name
          ?? CITY_ROUTES.find((item) => item.source === source)?.name
          ?? source;
        setStatus(`${entryName} შემოდის...`);
        try {
          const result = await routeService.importBundledRoute(source);
          results.push(result);
          if (result.route.city === editorCityRef.current) {
            setRoutes((items) => [result.route, ...items.filter((item) => item.id !== result.route.id)]);
          }
        } catch (error) {
          errors.push(`${entryName}: ${error instanceof Error ? error.message : "შემოტანა ვერ მოხერხდა"}`);
        }
      }
      if (errors.length) setImportError(`${errors.join("; ")}. ხელახლა შემოტანა უკვე შენახულ მარშრუტებს არ გააორმაგებს.`);
      const latest = routeRef.current ? routeFingerprint(routeRef.current) : null;
      const opened = results.find((item) => item.route.city === editorCityRef.current);
      if (opened && latest === before) {
        markRouteClean(opened.route);
        setHistoryPast([]);
        setHistoryFuture([]);
        setSelectedPoint(0);
        setSidebarTab("route");
        changeDrawingMode("manual");
      }
      const added = results.filter((item) => !item.reused).length;
      const reused = results.length - added;
      setStatus(results.length
        ? `შემოტანა დასრულდა • ${added} ახალი • ${reused} უკვე არსებული${errors.length ? ` • ${errors.length} ვერ შემოვიდა` : ""}${latest !== before ? " • აირჩიე სიიდან მიმდინარე ცვლილებების დასრულების შემდეგ" : ""}`
        : "მარშრუტების შემოტანა ვერ მოხერხდა");
    } finally {
      importLockRef.current = false;
      setImporting(false);
    }
  }


  async function save(expectedVersionOverride?: number) {
    if (editQueueRef.current?.busy) {
      setStatus("შენახვამდე დაელოდე გზის მონიშვნის დასრულებას");
      return;
    }
    const current = routeRef.current;
    if (!current?.id) return;
    const issues = validateRoute(current);
    const errors = issues.filter((issue) => issue.level === "error");
    if (current.isPublished && errors.length) {
      setSidebarTab("route");
      setStatus("გამოქვეყნებამდე მარშრუტის შეცდომები უნდა გაასწორო");
      return;
    }
    setSaving(true);
    setStatus("ინახება...");
    try {
      const saved = await routeService.save(current.id, {
        name: current.name,
        city: current.city,
        description: current.description,
        isPublished: current.isPublished,
        fieldTestedAt: current.fieldTestedAt ?? null,
        waypoints: current.waypoints,
        waypointCoordinateIndices: current.waypointCoordinateIndices,
        coordinates: current.coordinates,
        speedZones: current.speedZones,
        checkpoints: current.checkpoints.map((point, index) => ({ ...point, orderIndex: index })),
      }, expectedVersionOverride ?? current.version);
      setRoutes((items) => items.map((item) => item.id === saved.id ? saved : item));
      const latest = routeRef.current;
      if (latest?.id === current.id) {
        if (routeFingerprint(latest) === routeFingerprint(current) && !editQueueRef.current?.busy) {
          markRouteClean(saved);
          setHistoryPast([]);
          setHistoryFuture([]);
          setStatus(`ყველაფერი შენახულია • ვერსია ${saved.version}`);
        } else {
          savedFingerprintRef.current = routeFingerprint(saved);
          assignRoute({ ...latest, version: saved.version });
          setStatus(`v${saved.version} შენახულია • ახალი ცვლილებები ჯერ შესანახია`);
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "ROUTE_VERSION_CONFLICT") {
        const data = error.data as { currentVersion?: number } | undefined;
        setConflictVersion(data?.currentVersion ?? null);
        setStatus("კონფლიქტი: მარშრუტის ახალი ვერსია უკვე არსებობს სერვერზე");
        return;
      }
      setStatus(error instanceof Error ? error.message : "შენახვა ვერ მოხერხდა");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const current = routeRef.current;
    if (!current?.id || deletingRoute) return;

    setDeletingRoute(true);
    setStatus("მარშრუტი იშლება...");

    try {
      await routeService.remove(current.id, current.version);
      setDeleteDialogOpen(false);
      setStatus("მარშრუტი წაიშალა");
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === "ROUTE_VERSION_CONFLICT") {
        const data = error.data as { currentVersion?: number } | undefined;
        setConflictVersion(data?.currentVersion ?? null);
        setDeleteDialogOpen(false);
      }
      setStatus(error instanceof Error ? error.message : "მარშრუტის წაშლა ვერ მოხერხდა");
    } finally {
      setDeletingRoute(false);
    }
  }

  async function duplicateCurrentRoute() {
    const current = routeRef.current;
    if (!current || duplicating) return;
    if (isDirty) {
      setStatus("ასლის შექმნამდე ჯერ შეინახე მიმდინარე ცვლილებები");
      return;
    }

    setDuplicating(true);
    setStatus("მარშრუტის ასლი იქმნება...");
    try {
      const created = await routeService.create({
        name: `${current.name} • ასლი`,
        city: current.city,
        description: current.description,
        isPublished: false,
        waypoints: current.waypoints,
        waypointCoordinateIndices: current.waypointCoordinateIndices,
        coordinates: current.coordinates,
        speedZones: current.speedZones,
        checkpoints: current.checkpoints.map(({ id: _id, routeId: _routeId, ...checkpoint }, index) => ({
          ...checkpoint,
          orderIndex: index,
        })),
      });
      await reload(created.id);
      setStatus("მარშრუტის ასლი შეიქმნა • გამოქვეყნება გამორთულია");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "ასლის შექმნა ვერ მოხერხდა");
    } finally {
      setDuplicating(false);
    }
  }

  async function restoreServerVersion(version: number) {
    const current = routeRef.current;
    if (!current?.id || restoringVersion != null) return;
    if (isDirty && !window.confirm("ვერსიის აღდგენა მიმდინარე დაუმახსოვრებელ ცვლილებებს გააუქმებს. გავაგრძელოთ?")) return;

    setRestoringVersion(version);
    setStatus(`ვერსია v${version} აღდგება...`);
    try {
      const restored = await routeService.restoreVersion(current.id, version, current.version);
      markRouteClean(restored);
      setRoutes((items) => items.map((item) => item.id === restored.id ? restored : item));
      setHistoryPast([]);
      setHistoryFuture([]);
      setSelectedPoint(0);
      setStatus(`v${version} აღდგა როგორც ახალი v${restored.version} • გამოქვეყნება გამორთულია`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "ვერსიის აღდგენა ვერ მოხერხდა");
    } finally {
      setRestoringVersion(null);
    }
  }

  async function reloadCurrentFromServer() {
    const current = routeRef.current;
    if (!current?.id) return;
    try {
      const fresh = await routeService.get(current.id);
      markRouteClean(fresh);
      setRoutes((items) => items.map((item) => item.id === fresh.id ? fresh : item));
      setHistoryPast([]);
      setHistoryFuture([]);
      setSelectedPoint(0);
      setStatus(`სერვერის ბოლო ვერსია ჩაიტვირთა • v${fresh.version}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "განახლება ვერ მოხერხდა");
    }
  }

  function selectRoute(id: number) {
    const next = routes.find((item) => item.id === id);
    if (!next || next.id === routeRef.current?.id) return;
    if (!canDiscardUnsavedChanges()) return;

    clearMapVisuals();
    lastFocusedRouteId.current = null;
    selectedPointRef.current = 0;
    markRouteClean(next);
    setSelectedPoint(0);

    // Render synchronously when the custom map sources are available.
    // React's effect will run as a second safety pass.
    queueMicrotask(() => renderCurrentRouteVisuals());
    setHistoryPast([]);
    setHistoryFuture([]);
  }

  function updateCheckpoint<K extends keyof RouteCheckpoint>(key: K, value: RouteCheckpoint[K]) {
    const current = routeRef.current;
    if (!current) return;
    updateRouteDirect({
      ...current,
      checkpoints: current.checkpoints.map((point, index) => index === selectedPoint ? { ...point, [key]: value } : point),
    });
  }

  function deleteCheckpoint() {
    const current = routeRef.current;
    if (!current) return;
    const checkpoints = current.checkpoints
      .filter((_, index) => index !== selectedPoint)
      .map((checkpoint, index) => ({ ...checkpoint, orderIndex: index }));
    setSelectedPoint((currentIndex) => Math.max(0, Math.min(currentIndex, checkpoints.length - 1)));
    commitRoute({ ...current, checkpoints }, "საკონტროლო წერტილი წაიშალა");
  }

  function moveCheckpoint(direction: -1 | 1) {
    const current = routeRef.current;
    if (!current) return;
    const from = selectedPointRef.current;
    const to = from + direction;
    if (to < 0 || to >= current.checkpoints.length) return;

    const checkpoints = [...current.checkpoints];
    [checkpoints[from], checkpoints[to]] = [checkpoints[to], checkpoints[from]];
    const normalized = checkpoints.map((checkpoint, index) => ({
      ...checkpoint,
      orderIndex: index,
    }));

    selectedPointRef.current = to;
    setSelectedPoint(to);
    commitRoute({ ...current, checkpoints: normalized }, `საკონტროლო წერტილი #${from + 1} გადაადგილდა`);
  }

  async function removeLastWaypoint() {
    return queueRouteEdit(async (current) => removeLastRouteWaypoint(current), "ბოლო საყრდენი და მისი მონაკვეთი წაიშალა");
  }

  function addSpeedZone() {
    const current = routeRef.current;
    if (!current) return;
    if (current.coordinates.length < 2) {
      setStatus("ჯერ მარშრუტის გზა უნდა არსებობდეს");
      return;
    }

    const maxIndex = current.coordinates.length - 1;
    const sorted = [...current.speedZones].sort(
      (a, b) => a.startCoordinateIndex - b.startCoordinateIndex
    );
    const previousEnd = sorted.at(-1)?.endCoordinateIndex ?? -1;
    if (previousEnd >= maxIndex - 1) {
      setStatus("მარშრუტის ბოლო უკვე დაფარულია. არსებული ზონის დასასრული გადაასწორე ან წაშალე ზონა.");
      return;
    }
    const startCoordinateIndex = Math.min(maxIndex - 1, Math.max(0, previousEnd + 1));
    const suggestedSpan = Math.max(2, Math.round(maxIndex * 0.2));
    const endCoordinateIndex = Math.min(maxIndex, startCoordinateIndex + suggestedSpan);
    const zone: RouteSpeedZone = {
      id: `zone-${Date.now()}`,
      startCoordinateIndex,
      endCoordinateIndex,
      speedLimit: 50,
      label: "50 კმ/სთ",
    };

    commitRoute(
      { ...current, speedZones: [...current.speedZones, zone] },
      "სიჩქარის ზონა დაემატა — ახლა დასაწყისი და დასასრული მონიშნე რუკაზე"
    );
    setSidebarTab("speed");
    setSpeedPick({ zoneId: zone.id, boundary: "start" });
  }

  function updateSpeedZone(id: string, patch: Partial<RouteSpeedZone>) {
    const current = routeRef.current;
    if (!current) return;
    updateRouteDirect({
      ...current,
      speedZones: current.speedZones.map((zone) =>
        zone.id === id ? { ...zone, ...patch } : zone
      ),
    });
  }

  function deleteSpeedZone(id: string) {
    const current = routeRef.current;
    if (!current) return;
    if (speedPickRef.current?.zoneId === id) setSpeedPick(null);
    commitRoute(
      {
        ...current,
        speedZones: current.speedZones.filter((zone) => zone.id !== id),
      },
      "სიჩქარის ზონა წაიშალა"
    );
  }

  function beginSpeedPick(zoneId: string, boundary: SpeedBoundary) {
    setSidebarTab("speed");
    setSpeedPick({ zoneId, boundary });
    setStatus(
      boundary === "start"
        ? "რუკაზე დააჭირე ზუსტად იმ ადგილს, საიდანაც ეს სიჩქარის ლიმიტი იწყება"
        : "რუკაზე დააჭირე ზუსტად იმ ადგილს, სადაც ეს სიჩქარის ლიმიტი მთავრდება"
    );
  }

  function pickSpeedZoneBoundary(
    zoneId: string,
    boundary: SpeedBoundary,
    coordinate: [number, number]
  ) {
    const current = routeRef.current;
    if (!current || current.coordinates.length < 2) return;

    const sorted = [...current.speedZones].sort(
      (a, b) => a.startCoordinateIndex - b.startCoordinateIndex
    );
    const orderIndex = sorted.findIndex((zone) => zone.id === zoneId);
    const zone = sorted[orderIndex];
    if (!zone) return;

    const previous = orderIndex > 0 ? sorted[orderIndex - 1] : null;
    const next = orderIndex >= 0 ? sorted[orderIndex + 1] ?? null : null;
    const maxSegment = current.coordinates.length - 2;

    // Search only inside the chronological route window that belongs to this
    // zone. This is important when the same physical street is driven twice
    // in opposite directions: an earlier overlapping branch cannot steal the
    // selection.
    const startSegment =
      boundary === "start"
        ? Math.max(0, previous?.endCoordinateIndex ?? 0)
        : Math.max(0, Math.min(maxSegment, zone.startCoordinateIndex));
    const endSegment =
      boundary === "start"
        ? Math.max(
            startSegment,
            Math.min(
              maxSegment,
              next ? Math.max(startSegment, next.startCoordinateIndex - 1) : maxSegment
            )
          )
        : Math.max(
            startSegment,
            Math.min(
              maxSegment,
              next ? Math.max(startSegment, next.startCoordinateIndex - 1) : maxSegment
            )
          );

    const match = nearestPointOnRouteRange(
      { lng: coordinate[0], lat: coordinate[1] },
      current.coordinates,
      startSegment,
      endSegment
    );
    const index = Math.max(0, Math.min(current.coordinates.length - 1, match.index));

    const nextZones = current.speedZones.map((item) => {
      if (item.id !== zoneId) return item;
      if (boundary === "start") {
        const startCoordinateIndex = index;
        const endCoordinateIndex = Math.max(
          item.endCoordinateIndex,
          Math.min(current.coordinates.length - 1, startCoordinateIndex + 1)
        );
        return { ...item, startCoordinateIndex, endCoordinateIndex };
      }
      const endCoordinateIndex = index;
      const startCoordinateIndex = Math.min(
        item.startCoordinateIndex,
        Math.max(0, endCoordinateIndex - 1)
      );
      return { ...item, startCoordinateIndex, endCoordinateIndex };
    });

    commitRoute(
      { ...current, speedZones: nextZones },
      boundary === "start"
        ? "ზონის დასაწყისი მონიშნულია"
        : "ზონის დასასრული მონიშნულია"
    );
    setSpeedPick(null);
  }

  function routePositionLabel(index: number) {
    const current = routeRef.current;
    if (!current?.coordinates.length) return "—";
    const cumulative = routeCumulativeDistances(current.coordinates);
    const safeIndex = Math.max(0, Math.min(cumulative.length - 1, Math.round(index)));
    const meters = cumulative[safeIndex] ?? 0;
    return meters >= 1000
      ? `${(meters / 1000).toFixed(2)} კმ`
      : `${Math.round(meters)} მ`;
  }

  const point = route?.checkpoints[selectedPoint] ?? null;

  return (
    <div className="studio-layout studio-v11">
      <section className="studio-map-stage">
        <div ref={mapEl} className="map-canvas" />

        <MapThemeControl
          mode={mapThemeMode}
          resolvedTheme={resolvedTheme}
          onChange={setMapThemeMode}
        />

        <Surface className="studio-v11-toolbar">
          <div className="studio-v11-toolbar-route">
            <div className="studio-v11-toolbar-icon"><RouteIcon size={19} /></div>
            <div><small>მარშრუტის რედაქტორი</small><strong>{route?.name ?? `${editorCity} • მარშრუტები`}</strong></div>
          </div>
          <div className="studio-v11-mode-switch">
            <button className={mode === "path" ? "active" : ""} onClick={() => { setSpeedPick(null); setMode("path"); }}><MapPinned size={16} /> გზის მონიშვნა</button>
            <button className={mode === "checkpoint" ? "active" : ""} onClick={() => { setSpeedPick(null); setMode("checkpoint"); }}><Crosshair size={16} /> საკონტროლო წერტილი</button>
          </div>
          <button
            type="button"
            className={`studio-route-centerline-toggle ${showEditCenterline ? "active" : ""}`}
            aria-pressed={showEditCenterline}
            title="რეალური კოორდინატების ცენტრალური ხაზი; ვიზუალური ზოლი მხოლოდ გვერდითაა გადაწეული"
            aria-label="რედაქტირების ცენტრალური ხაზის ჩვენება ან დამალვა"
            onClick={() => {
              const next = !showEditCenterlineRef.current;
              showEditCenterlineRef.current = next;
              setShowEditCenterline(next);
              setEditorCenterlineVisibility(mapRef.current, next);
            }}
          >
            <CircleDot size={15} /> <span>{showEditCenterline ? "ცენტრის ხაზის დამალვა" : "ცენტრის ხაზი"}</span>
          </button>
          {showEditCenterline && (
            <div className="studio-route-centerline-indicator" role="status">
              <span className="studio-route-centerline-swatch" aria-hidden="true" />
              GPS ტრაექტორია ჩართულია
            </div>
          )}
          <div className="studio-v11-history">
            <button onClick={undo} disabled={!historyPast.length && !routing} title="უკან დაბრუნება"><Undo2 size={16} /></button>
            <button onClick={redo} disabled={!historyFuture.length} title="წინ დაბრუნება"><Redo2 size={16} /></button>
          </div>
        </Surface>


        <Surface className="studio-v11-map-hint">
          <CircleDot size={15} />
          <div>
            <b>{speedPick ? (speedPick.boundary === "start" ? "სიჩქარის ზონის დასაწყისი" : "სიჩქარის ზონის დასასრული") : mode === "path" ? "გზის მონიშვნა" : "საკონტროლო წერტილის დამატება"}</b>
            <small>{speedPick ? "დააჭირე მარშრუტის შესაბამის ადგილს — არჩევა მიბმული იქნება მარშრუტის რიგითობაზე" : mode === "path" ? drawingMode === "manual" ? "წერტილები სწორი ხაზებით ერთდება. გზის მოხაზულობას მოკლე მონაკვეთებით მიჰყევი." : "ახალი წერტილი გზის ბოლოს დაემატება. უკვე გავლებული გზა შენარჩუნდება." : "წერტილი ავტომატურად დაჯდება შენს მარშრუტზე"}</small>
            {mode === "path" && !speedPick && <div className="studio-route-drawing-modes" role="group" aria-label="გზის მონიშვნის მეთოდი">
              <button type="button" aria-pressed={drawingMode === "automatic"} onClick={() => changeDrawingMode("automatic")}>ავტომატურად</button>
              <button type="button" aria-pressed={drawingMode === "manual"} onClick={() => changeDrawingMode("manual")}>ხელით</button>
            </div>}
            {routeReview && <div className="studio-route-review" role="status">
              <b>შემოთავაზებული შემოვლა: {Math.round(routeReview.distanceMeters)} მ</b>
              <small>ნარინჯისფერი წყვეტილი ხაზი აჩვენებს შემოთავაზებას. მარშრუტს შენი არჩევანის შემდეგ დაემატება.</small>
              <div className="studio-route-review-actions">
                <button type="button" onClick={() => finishRouteReview(true)}>შემოვლით გაგრძელება</button>
                <button type="button" onClick={routeReview.manualAction}>ხელით მონიშვნა</button>
                <button type="button" onClick={() => { cancelPendingEdits(); setStatus("შემოთავაზებული მონაკვეთი გაუქმდა"); }}>გაუქმება</button>
              </div>
            </div>}
          </div>
        </Surface>

        <div className="studio-v11-map-status"><span className={`studio-v11-status-dot ${routing ? "busy" : ""}`} /><b>{status}</b></div>

        <button
          type="button"
          className={`studio-v19-mobile-editor-toggle ${mobileEditorOpen ? "open" : ""}`}
          onClick={() => setMobileEditorOpen((value) => !value)}
          aria-expanded={mobileEditorOpen}
          aria-controls="route-studio-editor-panel"
        >
          <span className="studio-v19-mobile-editor-icon">
            <SlidersHorizontal size={16} />
          </span>
          <span className="studio-v19-mobile-editor-copy">
            <small>რედაქტორი</small>
            <strong>{route?.name ?? "მარშრუტის პარამეტრები"}</strong>
          </span>
          <span className="studio-v19-mobile-editor-count">
            {route ? route.checkpoints.length : 0}
          </span>
        </button>
      </section>

      {mobileEditorOpen && (
        <button
          type="button"
          className="studio-v19-mobile-editor-backdrop"
          onClick={() => setMobileEditorOpen(false)}
          aria-label="რედაქტორის დახურვა"
        />
      )}

      <aside
        id="route-studio-editor-panel"
        className={`studio-sidebar studio-v11-sidebar ${mobileEditorOpen ? "mobile-open" : ""}`}
      >
        <button
          type="button"
          className="studio-v19-mobile-editor-close"
          onClick={() => setMobileEditorOpen(false)}
          aria-label="რედაქტორის დახურვა"
        >
          <span />
          <ChevronDown size={17} />
          <b>რუკაზე დაბრუნება</b>
        </button>
        <div className="studio-v11-sidebar-top">
          <div className="studio-city-picker">
            <CitySelect
              cities={[...new Set(["გორი", editorCity, ...knownCities, ...CITY_ROUTES.map((item) => item.city)])].sort((a, b) => a.localeCompare(b, "ka"))}
              value={editorCity}
              disabled={importing || saving || routing || deletingRoute || restoringVersion != null}
              onChange={(next) => {
                if (next === editorCity) return;
                if (!canDiscardUnsavedChanges()) return;
                writeSelectedCity(readCurrentUserId(), next);
                editorCityRef.current = next;
                setEditorCity(next);
              }}
            />
          </div>
          <div className="studio-v11-route-select-wrap">
            <AppSelect
              value={route?.id ?? null}
              onChange={(value) => selectRoute(Number(value))}
              label="აქტიური მარშრუტი"
              disabled={!route}
              options={routes.map((item) => ({
                value: item.id!,
                label: item.name,
                description: `${item.city} · ${item.checkpoints.length} საკონტროლო · v${item.version}`,
                badge: item.isPublished ? "გამოქვეყნებული" : "მონახაზი",
              }))}
              ariaLabel="აქტიური მარშრუტის არჩევა"
            />
          </div>
          <button className="studio-v11-new" onClick={createRoute}><Plus size={17} /> ახალი</button>
        </div>

        <div className="studio-route-import">
          <b>გორის მარშრუტების შემოტანა</b>
          <AppSelect
            value={importSource}
            onChange={setImportSource}
            disabled={importing}
            options={BUNDLED_ROUTES.map((item) => ({
              value: item.source,
              label: item.name,
              description: `${item.distanceKm.toFixed(2)} კმ · ${item.instructionCount} მინიშნება`,
              badge: item.missingAudioCount ? `${item.missingAudioCount} აუდიო აკლია` : undefined,
            }))}
            ariaLabel="შესამოტანი მარშრუტის არჩევა"
          />
          <div className="studio-route-import-actions">
            <Button variant="secondary" onClick={() => void importBundledRoutes([importSource])} disabled={importing || saving || routing || deletingRoute || restoringVersion != null}>
              <Download size={16} /> {importing ? "შემოდის..." : "არჩეულის შემოტანა"}
            </Button>
            <Button variant="secondary" onClick={() => void importBundledRoutes(BUNDLED_ROUTES.filter((item) => item.source.startsWith("simulatori-gori-")).map((item) => item.source))} disabled={importing || saving || routing || deletingRoute || restoringVersion != null}>Simulatori.ge (4) - მარშრუტების შემოტანა</Button>
          </div>
          <p>ინახება მონახაზებად. ხელახალი შემოტანა დუბლიკატებს არ ქმნის. ტესტირება გამოქვეყნების გარეშეც შეგიძლია; გამოქვეყნებამდე გადაამოწმე გზა და დაამატე სიჩქარის ზონები.</p>
          <p>გორის ოთხივე მარშრუტზე ორიგინალი ხმოვანი ჩანაწერები ხელმისაწვდომია. რეალურ მოძრაობამდე საჭიროა GPS-ის შემოწმება. ეს ღილაკი გორის ფაილებს ხელახლა არ გადააწერს.</p>
          {editorCity !== "გორი" && CITY_ROUTES.some((item) => item.city === editorCity) && (
            <div className="studio-route-import-actions">
              <Button
                variant="secondary"
                onClick={() => void importBundledRoutes(CITY_ROUTES.filter((item) => item.city === editorCity).map((item) => item.source))}
                disabled={importing || saving || routing || deletingRoute || restoringVersion != null}
              >
                {editorCity} — {CITY_ROUTES.filter((item) => item.city === editorCity).length} მარშრუტის შემოტანა
              </Button>
            </div>
          )}
          {importError && <p className="studio-route-import-error" role="alert">{importError}</p>}
        </div>

        {route ? <>
          <div className="studio-v11-summary">
            <div><span>ვერსია</span><strong>v{route.version}</strong></div>
            <div><span>საყრდენი</span><strong>{editorWaypoints(route).length}</strong></div>
            <div><span>წერტილები</span><strong>{route.checkpoints.length}</strong></div>
            <div><span>ზონები</span><strong>{route.speedZones.length}</strong></div>
          </div>

          {conflictVersion != null && <div className="studio-v16-conflict">
            <AlertTriangle size={17} />
            <div><b>სერვერზე უკვე არის v{conflictVersion}</b><small>შენი ცვლილებები არ დაკარგულა. შეგიძლია ჩაიტვირთო სერვერის ვერსია ან შეგნებულად გადააწერო შენი მიმდინარე რედაქცია.</small></div>
            <button type="button" onClick={reloadCurrentFromServer}><RefreshCw size={14} /> სერვერის ჩატვირთვა</button>
            <button type="button" className="force" onClick={() => void save(conflictVersion)}>ჩემი ვერსიის შენახვა</button>
          </div>}

          {isDirty && <div className="studio-v16-dirty"><span /><div><b>შეუნახავი ცვლილებები</b><small>ცვლილებები ჯერ სერვერზე არ არის შენახული.</small></div></div>}

          <div className="studio-v11-tabs">
            <button className={sidebarTab === "route" ? "active" : ""} onClick={() => { setSpeedPick(null); setSidebarTab("route"); }}><RouteIcon size={15} /> მარშრუტი</button>
            <button className={sidebarTab === "checkpoints" ? "active" : ""} onClick={() => { setSpeedPick(null); setSidebarTab("checkpoints"); }}><Crosshair size={15} /> წერტილები <span>{route.checkpoints.length}</span></button>
            <button className={sidebarTab === "speed" ? "active" : ""} onClick={() => setSidebarTab("speed")}><GitBranch size={15} /> სიჩქარე <span>{route.speedZones.length}</span></button>
          </div>

          <div className="studio-v11-scroll">
            {sidebarTab === "route" && <div className="studio-v11-panel">
              <div className="studio-v11-section-head"><div><small>მარშრუტის პარამეტრები</small><h3>ძირითადი ინფორმაცია</h3></div></div>
              <div className="field-modern"><label>მარშრუტის სახელი</label><input value={route.name} onChange={(event) => updateRouteDirect({ ...route, name: event.target.value })} /></div>
              <div className="field-modern"><label>აღწერა</label><textarea rows={4} value={route.description} onChange={(event) => updateRouteDirect({ ...route, description: event.target.value })} /></div>
              <div className="studio-v11-route-actions">
                <button onClick={removeLastWaypoint} disabled={editorWaypoints(route).length <= 2}><Trash2 size={16} /> ბოლო საყრდენის წაშლა</button>
              </div>

              <div className="studio-v16-route-tools">
                <button type="button" onClick={duplicateCurrentRoute} disabled={duplicating}><Copy size={15} /> {duplicating ? "იქმნება..." : "მარშრუტის ასლის შექმნა"}</button>
              </div>

              <div className="studio-v16-version-card">
                <div className="studio-v11-section-head"><div><small>სერვერზე შენახული ისტორია</small><h3>ვერსიები</h3></div><Clock3 size={15} /></div>
                {versionsLoading && <div className="studio-v11-empty">ვერსიები იტვირთება...</div>}
                {!versionsLoading && !serverVersions.length && <div className="studio-v11-empty">შენახული ვერსიები ჯერ არ არის.</div>}
                <div className="studio-v16-version-list">{serverVersions.map((item) => <div key={item.id} className={item.version === route.version ? "current" : ""}><div><b>v{item.version}{item.version === route.version ? " • მიმდინარე" : ""}</b><small>{new Date(item.createdAt).toLocaleString("ka-GE")}{item.editedByName ? ` • ${item.editedByName}` : ""}</small></div>{item.version !== route.version && <button type="button" disabled={restoringVersion != null} onClick={() => void restoreServerVersion(item.version)}>{restoringVersion === item.version ? "აღდგება..." : "აღდგენა"}</button>}</div>)}</div>
                <small className="studio-v16-version-note">ძველი ვერსიის აღდგენა ქმნის ახალ ვერსიას და უსაფრთხოების მიზნით Publish-ს თიშავს.</small>
              </div>

              <div className="studio-v11-validation">
                <div className="studio-v11-section-head"><div><small>გამოქვეყნებამდე შემოწმება</small><h3>{validationErrors.length ? `${validationErrors.length} შეცდომაა` : "მარშრუტი მზადაა"}</h3></div><span className={validationErrors.length ? "bad" : "good"}>{validationErrors.length ? <AlertTriangle size={15} /> : <Check size={15} />}</span></div>
                {validation.length ? <div className="studio-v11-validation-list">{validation.map((issue) => <div key={issue.code} className={issue.level}>{issue.level === "error" ? <AlertTriangle size={14} /> : <CircleDot size={14} />}<span>{issue.message}</span></div>)}</div> : <div className="studio-v11-validation-ok"><CheckCircle2 size={16} /> შეცდომა ვერ მოიძებნა.</div>}
              </div>


              <label className="studio-v11-publish"><div><b>ავტომობილში შემოწმებულია</b><small>{route.fieldTestedAt ? `დადასტურდა ${new Date(route.fieldTestedAt).toLocaleDateString("ka-GE")}` : "ჯერ შეინახე გზა, შეამოწმე მოძრაობაში და მონიშნე აქ. გზის ან დავალების შეცვლა ამ სტატუსს მოხსნის."}</small></div><input type="checkbox" checked={Boolean(route.fieldTestedAt)} disabled={isDirty && !route.fieldTestedAt} onChange={(event) => updateRouteDirect({ ...route, fieldTestedAt: event.target.checked ? new Date().toISOString() : null })} /><span className="studio-v11-toggle" /></label>
              <label className="studio-v11-publish"><div><b>მარშრუტის გამოქვეყნება</b><small>მძღოლები მხოლოდ გამოქვეყნებულ მარშრუტებს დაინახავენ</small></div><input type="checkbox" checked={route.isPublished} onChange={(event) => updateRouteDirect({ ...route, isPublished: event.target.checked })} /><span className="studio-v11-toggle" /></label>
              <div className="studio-v14-workflow-links">
                <Link className="studio-v11-field-link" href={`/admin/field?route=${route.id}`}><div className="studio-v11-field-icon"><Radio size={19} /></div><div><b>გზის ჩაწერა მანქანიდან</b><small>რეალური GPS-ით ჩაიწერე გზა და დავალებები</small></div><ChevronRight size={17} /></Link>
                {isDirty ? <button type="button" className="studio-v14-test-link studio-v16-test-disabled" onClick={() => setStatus("ტესტირებამდე ჯერ შეინახე ცვლილებები")}><div><Play size={17} /></div><span><b>მარშრუტის ტესტირება</b><small>ჯერ შეინახე მიმდინარე ცვლილებები</small></span><ChevronRight size={16} /></button> : <Link className="studio-v14-test-link" href={`/drive?route=${route.id}&test=1`}><div><Play size={17} /></div><span><b>მარშრუტის ტესტირება</b><small>შენახული ვერსია გახსენი Simulation-ში Publish-ის გარეშე</small></span><ChevronRight size={16} /></Link>}
              </div>
            </div>}

            {sidebarTab === "checkpoints" && <div className="studio-v11-panel">
              <div className="studio-v11-section-head"><div><small>საკონტროლო წერტილების რედაქტორი</small><h3>{point ? `წერტილი #${selectedPoint + 1}` : "საკონტროლო წერტილები"}</h3></div>{point && <span className="studio-v11-selected-pill">{point.type === "straight" ? "პირდაპირ" : point.type === "left" ? "მარცხნივ" : point.type === "right" ? "მარჯვნივ" : point.type === "stop" ? "გაჩერება" : point.type === "speed" ? "სიჩქარე" : "გაფრთხილება"}</span>}</div>
              <div className="studio-v11-checkpoint-strip">{route.checkpoints.map((checkpoint, index) => <button key={checkpoint.id ?? index} className={selectedPoint === index ? "active" : ""} onClick={() => setSelectedPoint(index)} title={checkpoint.title}><span>{index + 1}</span></button>)}{!route.checkpoints.length && <div className="studio-v11-empty">საკონტროლო წერტილი ჯერ არ არის. აირჩიე ზემოთ შესაბამისი რეჟიმი და დააკლიკე რუკაზე.</div>}</div>

              {point && <div className="checkpoint-form studio-v11-form">
                <label className="studio-instruction-only">
                  <input type="checkbox" checked={point.evaluation?.instructionOnly === true} onChange={(event) => updateCheckpoint("evaluation", { ...point.evaluation, instructionOnly: event.target.checked })} />
                  <span><b>მხოლოდ ხმოვანი მინიშნება</b><small>ამ წერტილზე მოსახვევის ან გაჩერების შესრულება არ ფასდება.</small></span>
                </label>
                <div className="field-modern"><label>ინსტრუქციის ტიპი</label><AppSelect value={point.type} onChange={(value) => updateCheckpoint("type", value as RouteCheckpoint["type"])} options={[{ value: "straight", label: "პირდაპირ" }, { value: "left", label: "მარცხნივ" }, { value: "right", label: "მარჯვნივ" }, { value: "stop", label: "გაჩერება" }, { value: "speed", label: "სიჩქარის ცვლილება" }, { value: "warning", label: "გაფრთხილება" }]} ariaLabel="ინსტრუქციის ტიპი" /></div>
                <div className="field-modern"><label>ეკრანზე გამოსაჩენი ინსტრუქცია</label><input value={point.title} onChange={(event) => updateCheckpoint("title", event.target.value)} /></div>
                <div className="field-modern studio-recorded-audio-field">
                  <div className="studio-recorded-audio-label"><label>ხმოვანი ინსტრუქცია</label><span>მზა აუდიო</span></div>
                  <div className="studio-recorded-audio-row">
                    <AppSelect value={getRecordedCheckpointPrompt(point.voice)?.phrase ?? null} onChange={(value) => { const prompt = getRecordedCheckpointPrompt(String(value)); if (!prompt) return; updateCheckpoint("voice", prompt.phrase); if (prompt.suggestedType) updateCheckpoint("type", prompt.suggestedType); if (prompt.recommendedTriggerMeters) updateCheckpoint("triggerMeters", prompt.recommendedTriggerMeters); }} options={RECORDED_CHECKPOINT_PROMPTS.map((prompt) => ({ value: prompt.phrase, label: prompt.label, description: prompt.description, badge: prompt.recommendedTriggerMeters ? `${prompt.recommendedTriggerMeters} მ` : "ფინიში" }))} placeholder="აირჩიე ჩაწერილი ხმა" ariaLabel="ჩაწერილი ინსტრუქციის არჩევა" />
                    <button type="button" className="voice-preview-button studio-recorded-audio-preview" disabled={!getRecordedCheckpointPrompt(point.voice)} onClick={() => speakGeorgian(point.voice, point.ttsVoice)} title="ხმის მოსმენა" aria-label="არჩეული ხმოვანი ინსტრუქციის მოსმენა"><Volume2 size={17} /></button>
                  </div>
                  {!getRecordedCheckpointPrompt(point.voice) && <small className="studio-recorded-audio-note">აირჩიე ჩანაწერი ხმოვანი პაკეტიდან.</small>}
                </div>
                <div className="field-modern"><label>გაფრთხილების მანძილი</label><div className="studio-v11-input-unit"><input type="number" min={10} value={point.triggerMeters} onChange={(event) => updateCheckpoint("triggerMeters", Math.max(10, Number(event.target.value) || 10))} /><span>მ</span></div></div>
                {point.type === "stop" && <>
                  <div className="field-modern"><label>სასწავლო გაჩერების ხანგრძლივობა</label><div className="studio-v11-input-unit"><input type="number" min={1} max={10} step={0.5} value={point.evaluation?.stopSeconds ?? 2} onChange={(event) => updateCheckpoint("evaluation", { ...point.evaluation, stopSeconds: Math.max(1, Math.min(10, Number(event.target.value) || 2)) })} /><span>წმ</span></div></div>
                  <div className="field-modern"><label>გაჩერების მონაკვეთის რადიუსი</label><div className="studio-v11-input-unit"><input type="number" min={5} max={25} value={point.evaluation?.stopRadiusMeters ?? 12} onChange={(event) => updateCheckpoint("evaluation", { ...point.evaluation, stopRadiusMeters: Math.max(5, Math.min(25, Number(event.target.value) || 12)) })} /><span>მ</span></div></div>
                  <small className="studio-recorded-audio-note">გაჩერება დასტურდება სანდო სიჩქარით, არაუმეტეს 3 კმ/სთ. ეს სასწავლო პარამეტრებია.</small>
                </>}
                {(point.type === "left" || point.type === "right") && <div className="field-modern"><label>მოსახვევის შემდეგ შემოწმების მანძილი</label><div className="studio-v11-input-unit"><input type="number" min={5} max={40} value={point.evaluation?.departureMeters ?? 15} onChange={(event) => updateCheckpoint("evaluation", { ...point.evaluation, departureMeters: Math.max(5, Math.min(40, Number(event.target.value) || 15)) })} /><span>მ</span></div></div>}
                <div className="studio-v16-checkpoint-actions"><button type="button" disabled={selectedPoint <= 0} onClick={() => moveCheckpoint(-1)}><ArrowLeft size={14} /> წინ გადატანა</button><button type="button" disabled={selectedPoint >= route.checkpoints.length - 1} onClick={() => moveCheckpoint(1)}>უკან გადატანა <ArrowRight size={14} /></button></div>
                <button className="studio-v11-delete-checkpoint" onClick={deleteCheckpoint}><Trash2 size={15} /> წერტილის წაშლა</button>
              </div>}
            </div>}

            {sidebarTab === "speed" && <div className="studio-v11-panel studio-v28-speed-panel">
              <div className="studio-v11-section-head"><div><small>ზუსტად მარშრუტის მონაკვეთებზე</small><h3>სიჩქარის ზონები</h3></div><button className="studio-v11-inline-add" onClick={addSpeedZone}><Plus size={15} /> ზონის დამატება</button></div>
              <div className="studio-v28-speed-help">
                პროცენტები აღარ გამოიყენება. თითო ზონას რუკაზე ხელით უთითებ დასაწყისსა და დასასრულს. თუ ერთი ქუჩა მარშრუტში ორჯერ გვხვდება, სისტემა არჩევანს მარშრუტის რიგითობით არჩევს.
              </div>
              <div className="studio-v11-speed-legend"><span className="s20">20–30</span><span className="s40">40</span><span className="s50">50</span><span className="s60">60–70</span><span className="s80">80+</span></div>
              {!route.speedZones.length && <div className="studio-v11-empty">სიჩქარის ზონა ჯერ არ არის. დაამატე ზონა, აირჩიე ლიმიტი და რუკაზე მონიშნე მისი დასაწყისი და დასასრული.</div>}
              <div className="studio-v11-zone-list">{[...route.speedZones].sort((a,b) => a.startCoordinateIndex - b.startCoordinateIndex).map((zone, index) => <Surface key={zone.id} className="studio-v11-zone-card studio-v28-zone-card">
                <div className="studio-v11-zone-head"><div><small>მონაკვეთი #{index + 1}</small><input value={zone.label} onChange={(event) => updateSpeedZone(zone.id, { label: event.target.value })} /></div><button onClick={() => deleteSpeedZone(zone.id)} title="ზონის წაშლა"><Trash2 size={15} /></button></div>
                <div className="studio-v28-zone-points">
                  <button type="button" className={speedPick?.zoneId === zone.id && speedPick.boundary === "start" ? "active" : ""} onClick={() => beginSpeedPick(zone.id, "start")}>
                    <span>დასაწყისი</span><b>{routePositionLabel(zone.startCoordinateIndex)}</b><small>რუკაზე მონიშვნა</small>
                  </button>
                  <span className="studio-v11-zone-arrow">→</span>
                  <button type="button" className={speedPick?.zoneId === zone.id && speedPick.boundary === "end" ? "active" : ""} onClick={() => beginSpeedPick(zone.id, "end")}>
                    <span>დასასრული</span><b>{routePositionLabel(zone.endCoordinateIndex)}</b><small>რუკაზე მონიშვნა</small>
                  </button>
                </div>
                <div className="studio-v11-zone-limit"><label>მაქსიმალური სიჩქარე <strong>{zone.speedLimit} კმ/სთ</strong></label><div>{[20,30,40,50,60,70,80,90].map((limit) => <button key={limit} className={zone.speedLimit === limit ? "active" : ""} onClick={() => updateSpeedZone(zone.id, { speedLimit: limit, label: `${limit} კმ/სთ` })}>{limit}</button>)}</div></div>
              </Surface>)}</div>
            </div>}
          </div>

          <div className="studio-v11-actions">
            <button
              className="studio-v11-delete-route studio-v19-delete-route"
              type="button"
              onClick={() => setDeleteDialogOpen(true)}
              title="მარშრუტის წაშლა"
            >
              <Trash2 size={17} />
              <span>წაშლა</span>
            </button>
            <Button className="studio-v11-save" onClick={() => void save()} disabled={saving || routing || !isDirty}><Save size={17} /> {saving ? "ინახება..." : isDirty ? "ცვლილებების შენახვა" : "ყველაფერი შენახულია"}</Button>
          </div>

          <ConfirmDialog
            open={deleteDialogOpen}
            title={`წავშალოთ „${route.name}“?`}
            description={route.isPublished
              ? "ეს მარშრუტი გამოქვეყნებულია. წაშლის შემდეგ მძღოლებისთვის გაქრება. ძველი სესიების შედეგები და ისტორიული snapshot-ები შენარჩუნდება, მაგრამ თავად მარშრუტის აღდგენა ვეღარ მოხერხდება."
              : "მარშრუტი, მისი საკონტროლო წერტილები, სიჩქარის ზონები და შენახული ვერსიები წაიშლება. ძველი სესიების ისტორიული მონაცემები შენარჩუნდება."
            }
            confirmLabel="მარშრუტის წაშლა"
            busy={deletingRoute}
            onClose={() => setDeleteDialogOpen(false)}
            onConfirm={() => void remove()}
          />
        </> : <div className="studio-v11-no-route"><RouteIcon size={30} /><h3>მარშრუტი ჯერ არ არის</h3><p>{editorCity === "გორი" ? "შექმენი პირველი გორის მარშრუტი და დაიწყე მისი მონიშვნა." : "ამ ქალაქში მარშრუტი ჯერ არ არის. შემოიტანე კატალოგიდან ან შექმენი ახალი."}</p><Button onClick={createRoute}><Plus size={17} /> ახალი მარშრუტი</Button></div>}
      </aside>
    </div>
  );
}
