"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DrivingTracePoint, GpsSample } from "@/types/domain";
import { createGpsFilterState, filterGpsSample } from "@/utils/gps-filter";
import type { GpsRejectReason as FilterRejectReason } from "@/utils/gps-filter";

export type LocationErrorCode =
  | "unsupported"
  | "permission_denied"
  | "unavailable"
  | "timeout"
  | "unknown";

export type LocationError = {
  code: LocationErrorCode;
  message: string;
};

export type GpsQuality =
  | "waiting"
  | "excellent"
  | "good"
  | "weak"
  | "poor";

export type GpsRejectReason = FilterRejectReason | null;

export type LiveLocationOptions = {
  smoothing?: boolean;
  staleAfterMs?: number;
  jumpSpeedKmh?: number;
  maxAcceptedAccuracyMeters?: number | null;
};

export type GpsDiagnostics = {
  quality: GpsQuality;
  label: string;
  ageMs: number | null;
  isStale: boolean;
  acceptedSamples: number;
  rejectedSamples: number;
  lastRejectedReason: GpsRejectReason;
  permissionState: PermissionState | "unsupported" | "unknown";
};

const DEFAULT_OPTIONS: Required<LiveLocationOptions> = {
  smoothing: true,
  staleAfterMs: 8_000,
  jumpSpeedKmh: 220,
  maxAcceptedAccuracyMeters: null,
};

function mapError(error: GeolocationPositionError): LocationError {
  if (error.code === error.PERMISSION_DENIED) {
    return {
      code: "permission_denied",
      message:
        "მდებარეობის წვდომა გამორთულია. ბრაუზერში მდებარეობის წვდომა დაუშვი და თავიდან სცადე.",
    };
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return {
      code: "unavailable",
      message: "GPS პოზიცია დროებით მიუწვდომელია.",
    };
  }

  if (error.code === error.TIMEOUT) {
    return {
      code: "timeout",
      message: "GPS პასუხს ძალიან დიდხანს ველოდეთ. თავიდან სცადე.",
    };
  }

  return {
    code: "unknown",
    message: error.message || "GPS მდებარეობის მიღება ვერ მოხერხდა.",
  };
}

function qualityForAccuracy(
  accuracy: number | null | undefined
): Pick<GpsDiagnostics, "quality" | "label"> {
  if (accuracy == null) {
    return { quality: "waiting", label: "GPS-ის მოლოდინი" };
  }

  if (accuracy <= 8) {
    return {
      quality: "excellent",
      label: `ძალიან ზუსტი GPS ±${Math.round(accuracy)}მ`,
    };
  }

  if (accuracy <= 15) {
    return {
      quality: "good",
      label: `კარგი GPS ±${Math.round(accuracy)}მ`,
    };
  }

  if (accuracy <= 30) {
    return {
      quality: "weak",
      label: `საშუალო GPS ±${Math.round(accuracy)}მ`,
    };
  }

  return {
    quality: "poor",
    label: `სუსტი GPS ±${Math.round(accuracy)}მ`,
  };
}

function normalizeHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function toSample(position: GeolocationPosition): GpsSample {
  return {
    lng: position.coords.longitude,
    lat: position.coords.latitude,
    accuracy: Number.isFinite(position.coords.accuracy)
      ? position.coords.accuracy
      : null,
    speedMps:
      position.coords.speed != null && Number.isFinite(position.coords.speed) && position.coords.speed >= 0
        ? position.coords.speed
        : null,
    heading:
      position.coords.heading != null &&
      Number.isFinite(position.coords.heading)
        ? normalizeHeading(position.coords.heading)
        : null,
    timestamp: position.timestamp,
  };
}

export function useLiveLocation(options: LiveLocationOptions = {}) {
  const config = useMemo(
    () => ({ ...DEFAULT_OPTIONS, ...options }),
    [
      options.smoothing,
      options.staleAfterMs,
      options.jumpSpeedKmh,
      options.maxAcceptedAccuracyMeters,
    ]
  );

  const watchId = useRef<number | null>(null);
  const filterRef = useRef(createGpsFilterState());
  const acceptedCount = useRef(0);
  const rejectedCount = useRef(0);

  const [sample, setSample] = useState<GpsSample | null>(null);
  const [rawSample, setRawSample] = useState<GpsSample | null>(null);
  const [observation, setObservation] = useState<DrivingTracePoint | null>(null);
  const [error, setError] = useState<LocationError | null>(null);
  const [watching, setWatching] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [lastRejectedReason, setLastRejectedReason] =
    useState<GpsRejectReason>(null);
  const [permissionState, setPermissionState] = useState<
    PermissionState | "unsupported" | "unknown"
  >("unknown");

  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !("permissions" in navigator) ||
      !navigator.permissions?.query
    ) {
      setPermissionState("unsupported");
      return;
    }

    let mounted = true;
    let permission: PermissionStatus | null = null;

    void navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (!mounted) return;
        permission = status;
        setPermissionState(status.state);
        status.onchange = () => setPermissionState(status.state);
      })
      .catch(() => setPermissionState("unknown"));

    return () => {
      mounted = false;
      if (permission) permission.onchange = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stop = useCallback(() => {
    if (watchId.current != null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchId.current);
    }

    watchId.current = null;
    setWatching(false);
  }, []);

  const acceptPosition = useCallback(
    (position: GeolocationPosition) => {
      const raw = toSample(position);
      const observedAt = Date.now();
      setRawSample(raw);
      const filtered = filterGpsSample(filterRef.current, raw, observedAt, config);
      filterRef.current = filtered.state;
      setObservation({ observedAt, raw: Number.isFinite(raw.lng) && Math.abs(raw.lng) <= 180 && Number.isFinite(raw.lat) && Math.abs(raw.lat) <= 90 && Number.isFinite(raw.timestamp) ? raw : null, sample: filtered.sample, accepted: filtered.sample != null,
        reason: filtered.reason, visible: document.visibilityState === "visible" });
      setClock(observedAt);
      if (!filtered.sample) {
        rejectedCount.current += 1;
        setLastRejectedReason(filtered.reason);
        return;
      }
      acceptedCount.current += 1;
      setSample(filtered.sample);
      setError(null);
      setWatching(true);
      setLastRejectedReason(null);
    },
    [config]
  );

  const start = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setError({
        code: "unsupported",
        message: "ამ მოწყობილობაზე მდებარეობის განსაზღვრა ხელმისაწვდომი არ არის.",
      });
      setWatching(false);
      return;
    }

    stop();
    setError(null);
    setWatching(true);

    watchId.current = navigator.geolocation.watchPosition(
      acceptPosition,
      (geoError) => {
        setError(mapError(geoError));
        setWatching(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 20_000,
      }
    );
  }, [acceptPosition, stop]);

  const retry = useCallback(() => {
    filterRef.current = createGpsFilterState();
    setObservation(null);
    setSample(null);
    setRawSample(null);
    start();
  }, [start]);

  useEffect(() => stop, [stop]);

  const diagnostics = useMemo<GpsDiagnostics>(() => {
    const quality = qualityForAccuracy(rawSample?.accuracy ?? sample?.accuracy);
    const ageMs = sample ? Math.max(0, clock - sample.timestamp) : null;
    const isStale = ageMs != null && ageMs > config.staleAfterMs;
    const rejected = lastRejectedReason != null && lastRejectedReason !== "duplicate" && lastRejectedReason !== "out_of_order";

    return {
      ...quality,
      ...(isStale ? { quality: "poor" as const, label: "GPS მოძველებულია — პოზიციას ველოდებით" }
        : rejected ? { quality: "poor" as const, label: `GPS წერტილი ვერ დადასტურდა${rawSample?.accuracy != null ? ` ±${Math.round(rawSample.accuracy)}მ` : ""}` } : {}),
      ageMs,
      isStale,
      acceptedSamples: acceptedCount.current,
      rejectedSamples: rejectedCount.current,
      lastRejectedReason,
      permissionState,
    };
  }, [clock, config.staleAfterMs, lastRejectedReason, permissionState, rawSample, sample]);

  return {
    sample,
    rawSample,
    observation,
    error,
    watching,
    diagnostics,
    start,
    retry,
    stop,
  };
}
