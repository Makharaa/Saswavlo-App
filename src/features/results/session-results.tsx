"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { Map, Marker } from "maplibre-gl";
import { configureMapLibreWorker } from "@/utils/maplibre-runtime";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  MapPinned,
  Milestone,
  Navigation,
  Route as RouteIcon,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Badge, Button, Surface } from "@/components/ui";
import { LocalDateTime } from "@/components/local-date-time";
import { MapThemeControl } from "@/components/map-theme-control";
import { useMapTheme } from "@/hooks/use-map-theme";
import { installNavigationMapStyle } from "@/utils/maplibre-style-guard";
import { buildTraceReview, traceReasonLabel } from "@/utils/trace-review";
import { createCirclePolygon } from "@/utils/route-engine";
import type { DrivingEvent, DrivingSessionDetail } from "@/types/domain";

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function issueTitle(event: DrivingEvent) {
  if (event.type === "speeding") return "სიჩქარის გადაჭარბება";
  if (event.type === "off_route") return "მარშრუტიდან გადახვევა";
  if (event.type === "wrong_direction") return "საპირისპირო მიმართულება";
  if (event.type === "checkpoint_missed") return "დავალება ვერ შესრულდა";
  if (event.type === "checkpoint_uncertain") return "შესრულება დაუზუსტებელია";
  return "მოვლენა";
}

export function SessionResults({ session }: { session: DrivingSessionDetail }) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const rawMarker = useRef<Marker | null>(null);
  const matchedMarker = useRef<Marker | null>(null);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frames = useMemo(() => session.routeSnapshot && session.trace?.length ? buildTraceReview(session.routeSnapshot, session.trace, session.mode) : [], [session.routeSnapshot, session.trace, session.mode]);
  const frame = frames[reviewIndex];
  const selectedFrame = useRef(frame);
  selectedFrame.current = frame;
  useEffect(() => {
    if (!playing) return;
    if (reviewIndex >= frames.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setReviewIndex((index) => index + 1), 300);
    return () => window.clearTimeout(timer);
  }, [frames.length, playing, reviewIndex]);

  function updateReplayMarkers() {
    const selected = selectedFrame.current;
    const map = mapRef.current;
    if (!selected || !map || !map.isStyleLoaded()) return;
    const raw = selected.raw ?? selected.sample;
    if (raw) {
      rawMarker.current?.setLngLat([raw.lng, raw.lat]);
      if (rawMarker.current) rawMarker.current.getElement().hidden = false;
      const source = map.getSource("session-gps-accuracy") as maplibregl.GeoJSONSource | undefined;
      source?.setData(createCirclePolygon(raw, Math.min(raw.accuracy ?? 0, 1000)));
    } else if (rawMarker.current) rawMarker.current.getElement().hidden = true;
    if (selected.matched) {
      matchedMarker.current?.setLngLat([selected.matched.lng, selected.matched.lat]);
      if (matchedMarker.current) matchedMarker.current.getElement().hidden = false;
    } else if (matchedMarker.current) matchedMarker.current.getElement().hidden = true;
  }
  useEffect(updateReplayMarkers, [frame]);
  function downloadTrace() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ route: session.routeSnapshot, session }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `DriveExam-session-${session.id}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function focusIssue(event: DrivingEvent) {
    if (event.lng == null || event.lat == null) return;
    setPlaying(false);
    const index = frames.findIndex((point) => point.observedAt >= event.timestamp);
    if (index >= 0) setReviewIndex(index);
    mapRef.current?.flyTo({ center: [event.lng, event.lat], zoom: 18, duration: 500 });
  }
  const { mode: mapThemeMode, resolvedTheme, styleUrl, setMode: setMapThemeMode } = useMapTheme();

  const positionEvents = useMemo(
    () => session.events.filter((event) => event.type === "position" && event.lng != null && event.lat != null),
    [session.events]
  );

  const checkpointEvents = useMemo(
    () => session.events.filter((event) => event.type === "checkpoint" && event.lng != null && event.lat != null),
    [session.events]
  );

  const issues = useMemo(
    () => session.events.filter((event) => event.type === "speeding" || event.type === "off_route" || event.type === "wrong_direction" || event.type === "checkpoint_missed" || event.type === "checkpoint_uncertain"),
    [session.events]
  );

  const completion = session.checkpointsTotal > 0
    ? Math.min(100, (session.checkpointsCompleted / session.checkpointsTotal) * 100)
    : 0;
  const missedCheckpoints = session.evaluation?.missedCheckpoints ?? Math.max(0, session.checkpointsTotal - session.checkpointsCompleted);
  const unfinished = Math.max(0, session.checkpointsTotal - session.checkpointsCompleted - missedCheckpoints - (session.evaluation?.uncertainCheckpoints ?? 0));
  const averageSpeed = session.durationSeconds > 0
    ? (session.distanceMeters / 1000) / (session.durationSeconds / 3600)
    : 0;

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    const allPointEvents = session.events.filter((event) => event.lng != null && event.lat != null);
    const center: [number, number] = allPointEvents.length
      ? [allPointEvents[0].lng as number, allPointEvents[0].lat as number]
      : [44.11, 41.98];

    configureMapLibreWorker();
    const map = new maplibregl.Map({
      container: mapEl.current,
      center,
      zoom: 13.8,
    });

    const disposeNavigationMapStyle = installNavigationMapStyle(map, styleUrl);

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      if (session.routeSnapshot?.coordinates.length) {
        map.addSource("session-reference-route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: session.routeSnapshot.coordinates } } });
        map.addLayer({ id: "session-reference-route", type: "line", source: "session-reference-route", paint: { "line-color": "#8591a8", "line-width": 3, "line-dasharray": [2, 2] } });
      }
      if (frames.length) {
        map.addSource("session-gps-accuracy", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "session-gps-accuracy", type: "fill", source: "session-gps-accuracy", paint: { "fill-color": "#8390a7", "fill-opacity": 0.12 } });
        const raw = document.createElement("div"); raw.className = "review-position raw"; raw.title = "ტელეფონის პოზიცია"; raw.hidden = true;
        const matched = document.createElement("div"); matched.className = "review-position matched"; matched.title = "მარშრუტზე მიბმული პოზიცია"; matched.hidden = true;
        rawMarker.current = new Marker({ element: raw }).setLngLat(center).addTo(map);
        matchedMarker.current = new Marker({ element: matched }).setLngLat(center).addTo(map);
        updateReplayMarkers();
      }

      const coords = positionEvents.map(
        (event) => [event.lng as number, event.lat as number] as [number, number]
      );

      if (coords.length >= 2) {
        map.addSource("session-trace", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          },
        });
        map.addLayer({
          id: "session-trace-line",
          type: "line",
          source: "session-trace",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#5c6cff",
            "line-width": 6,
            "line-opacity": 1,
          },
        });

        const start = document.createElement("div");
        start.className = "result-endpoint-marker start";
        start.textContent = "S";
        start.title = "სესიის დასაწყისი";
        new Marker({ element: start, anchor: "center" }).setLngLat(coords[0]).addTo(map);

        const finish = document.createElement("div");
        finish.className = "result-endpoint-marker finish";
        finish.textContent = "F";
        finish.title = "სესიის დასასრული";
        new Marker({ element: finish, anchor: "center" }).setLngLat(coords[coords.length - 1]).addTo(map);

        const bounds = new maplibregl.LngLatBounds();
        coords.forEach((coord) => bounds.extend(coord));
        map.fitBounds(bounds, { padding: 90, duration: 0, maxZoom: 16 });
      }

      checkpointEvents.forEach((event) => {
        const el = document.createElement("div");
        el.className = "result-checkpoint-marker";
        el.textContent = String((event.checkpointIndex ?? 0) + 1);
        el.title = event.note || "საკონტროლო წერტილი";
        new Marker({ element: el, anchor: "center" })
          .setLngLat([event.lng as number, event.lat as number])
          .addTo(map);
      });

      issues.forEach((event) => {
        if (event.lng == null || event.lat == null) return;
        const el = document.createElement("div");
        el.className = `result-event-marker ${event.type === "speeding" ? "speeding" : "offroute"}`;
        el.title = `${issueTitle(event)}: ${event.note ?? ""}`;
        el.addEventListener("click", () => focusIssue(event));
        new Marker({ element: el, anchor: "center" })
          .setLngLat([event.lng, event.lat])
          .addTo(map);
      });
    });

    mapRef.current = map;
    return () => {
      disposeNavigationMapStyle();
      map.remove();
      mapRef.current = null;
      rawMarker.current = null; matchedMarker.current = null;
    };
  }, [checkpointEvents, issues, positionEvents, session.events, session.id, styleUrl, session.routeSnapshot, frames]);

  return (
    <div className="session-results-layout session-results-v18">
      <section className="session-result-main">
        <Surface className="session-result-hero result-hero-v18">
          <div className="result-hero-icon"><CheckCircle2 size={28} /></div>
          <div>
            <small>სესია #{session.id}</small>
            <h1>{session.routeName || "მარშრუტი"}</h1>
            <p><MapPinned size={15} /> {session.city || "—"}{session.routeVersion ? ` • v${session.routeVersion}` : ""} • <LocalDateTime value={session.finishedAt} /></p>
            {session.userName && <p className="result-user"><UserRound size={14} /> {session.userName}</p>}
          </div>
          <div className="history-badges">
            <Badge tone={session.assistMode === "exam" ? "warning" : "neutral"}>{session.assistMode === "exam" ? "გამოცდა" : "ვარჯიში"}</Badge>
            <Badge tone={session.mode === "real" ? "success" : "neutral"}>{session.mode === "real" ? "რეალური GPS" : "სიმულაცია"}</Badge>
          </div>
        </Surface>

        <div className="result-metric-grid result-metric-grid-v18">
          <Surface><Clock3 size={18} /><span>{session.mode === "simulation" ? "სიმულაციის დრო" : "დრო"}</span><b>{formatDuration(session.durationSeconds)}</b></Surface>
          <Surface><RouteIcon size={18} /><span>მანძილი</span><b>{(session.distanceMeters / 1000).toFixed(2)} კმ</b></Surface>
          <Surface><Gauge size={18} /><span>საშ. სიჩქარე</span><b>{Math.round(averageSpeed)} კმ/სთ</b></Surface>
          <Surface><Gauge size={18} /><span>მაქს. სიჩქარე</span><b>{Math.round(session.maxSpeedKmh)} კმ/სთ</b></Surface>
          <Surface><Navigation size={18} /><span>საკონტროლო</span><b>{session.checkpointsCompleted}/{session.checkpointsTotal}</b></Surface>
          <Surface><ShieldCheck size={18} /><span>დასრულება</span><b>{Math.round(completion)}%</b></Surface>
        </div>

        <Surface className="trace-review-panel">
          <div className="result-section-head"><div><small>GPS მონაცემით გადამოწმება</small><h2>{session.evaluation?.status === "replayed" ? "სერვერზე გადაანგარიშებულია" : session.evaluation?.status === "incomplete" ? "ჩანაწერი არასრულია" : "ძველი სესიის შეჯამება"}</h2></div>
            <Button variant="secondary" onClick={downloadTrace}>ჩანაწერის ჩამოტვირთვა</Button></div>
          {!frames.length && <p>ამ სესიას სრული GPS ჩანაწერი არ ახლავს. შენახული შეჯამება ხელმისაწვდომია.</p>}
          {frame && <>
            <div className="trace-review-controls"><Button variant="secondary" onClick={() => { if (reviewIndex === frames.length - 1) setReviewIndex(0); setPlaying((value) => !value); }}>{playing ? "პაუზა" : "გადახედვა"}</Button>
              <input type="range" aria-label="GPS ჩანაწერის დრო" min={0} max={frames.length - 1} value={reviewIndex} onChange={(event) => { setPlaying(false); setReviewIndex(Number(event.target.value)); }} />
              <span>{reviewIndex + 1}/{frames.length}</span></div>
            <div className="trace-review-values"><span><LocalDateTime value={frame.observedAt} format="time" /></span><b>{traceReasonLabel(frame.reason)}</b>
              <span>სიზუსტის რადიუსი: {frame.raw?.accuracy ?? frame.sample?.accuracy ?? "—"} მ</span><span>მარშრუტი: {Math.round(frame.progressPercent)}%</span></div>
          </>}
        </Surface>

        <Surface className="result-map-card result-map-card-v18">
          <div className="result-section-head">
            <div><small>გავლილი გზის განხილვა</small><h2>გავლილი გზა და მოვლენები</h2></div>
            <Badge tone={issues.length || unfinished ? "warning" : "success"}>
              {issues.length || unfinished ? `${issues.length + unfinished} საყურადღებო` : "დაფიქსირებული შეცდომა არ არის"}
            </Badge>
          </div>
          <div className="result-map-legend-v18">
            <span><i className="trace" /> გავლილი გზა</span>
            <span><i className="checkpoint" /> საკონტროლო წერტილი</span>
            <span><i className="speeding" /> გადაჭარბება</span>
            <span><i className="offroute" /> გადახვევა</span>
            {frames.length > 0 && <><span><i className="raw-gps" /> ტელეფონის პოზიცია</span><span><i className="trace" /> მარშრუტზე მიბმული პოზიცია</span></>}
          </div>
          <div className="result-map-wrap">
            <div ref={mapEl} className="result-map" />
            <MapThemeControl
              mode={mapThemeMode}
              resolvedTheme={resolvedTheme}
              onChange={setMapThemeMode}
              compact
            />
          </div>
        </Surface>
      </section>

      <aside className="session-result-side">
        <Surface className="issue-summary-card issue-summary-v18">
          <small>შედეგების განხილვა</small>
          <h2>სესიის შეჯამება</h2>
          <div className="result-completion-v18">
            <div><span style={{ width: `${completion}%` }} /></div>
            <b>{Math.round(completion)}%</b>
          </div>
          <div className="issue-counters issue-counters-v18">
            <div className={session.speedingEvents ? "warning" : ""}><AlertTriangle size={17} /><span>გადაჭარბება</span><b>{session.speedingEvents}</b></div>
            <div className={session.offRouteEvents ? "warning" : ""}><AlertTriangle size={17} /><span>გადახვევა</span><b>{session.offRouteEvents}</b></div>
            <div><Milestone size={17} /><span>დაუზუსტებელი</span><b>{session.evaluation?.uncertainCheckpoints ?? 0}</b></div>
            <div><Navigation size={17} /><span>საპირისპირო მიმართულება</span><b>{session.evaluation?.wrongDirectionEvents ?? 0}</b></div>
            <div className={missedCheckpoints ? "warning" : ""}><Milestone size={17} /><span>გამოტოვებული</span><b>{missedCheckpoints}</b></div>
          </div>
        </Surface>

        <div className="event-list event-list-v18">
          <div className="event-list-heading-v18">მოვლენების ქრონოლოგია</div>
          {issues.map((event, index) => (
            <Surface key={event.id ?? index} className="event-row">
              <span className={`event-dot ${event.type}`} />
              <div>
                <b>{issueTitle(event)}</b>
                <small><LocalDateTime value={event.timestamp} format="time" /> • {event.note}</small>
              </div>
              <strong>{event.type === "speeding" ? `${Math.round(event.value ?? 0)} / ${Math.round(event.limitValue ?? 0)}` : event.type === "off_route" ? `${Math.round(event.value ?? 0)} მ` : event.checkpointIndex != null ? `#${event.checkpointIndex + 1}` : ""}</strong>
              {event.lng != null && <button type="button" className="event-focus" onClick={() => focusIssue(event)}>რუკაზე</button>}
            </Surface>
          ))}
          {!issues.length && <Surface className="empty-state">ამ სესიაში დაფიქსირებული შეცდომის მოვლენა არ არის.</Surface>}
        </div>
      </aside>
    </div>
  );
}
