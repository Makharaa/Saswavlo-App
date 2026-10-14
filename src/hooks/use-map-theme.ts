"use client";

import { useEffect, useMemo, useState } from "react";

export type MapThemeMode = "auto" | "day" | "night";
export type ResolvedMapTheme = "day" | "night";

export const MAP_STYLE_URLS: Record<ResolvedMapTheme, string> = {
  day: "https://tiles.openfreemap.org/styles/liberty",
  night: "https://tiles.openfreemap.org/styles/dark",
};

const STORAGE_KEY = "driveexam-map-theme-v1";
const CHANGE_EVENT = "driveexam-map-theme-change";

function resolveAutomaticTheme(now = new Date()): ResolvedMapTheme {
  const hour = now.getHours();
  return hour >= 19 || hour < 7 ? "night" : "day";
}

function readStoredMode(): MapThemeMode {
  if (typeof window === "undefined") return "auto";
  try {
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (value === "day" || value === "night" || value === "auto") {
    return value;
  }

  // Preserve the preference saved while the temporary V20 map stack was active.
  const temporaryV20Value = window.localStorage.getItem("driveexam-map-theme-v2");
  return temporaryV20Value === "day" ||
    temporaryV20Value === "night" ||
    temporaryV20Value === "auto"
    ? temporaryV20Value
    : "auto";
  } catch { return "auto"; }
}

export function useMapTheme() {
  const [mode, setModeState] = useState<MapThemeMode>("auto");
  const [clockTick, setClockTick] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    setModeState(readStoredMode());

    const onStorage = (event: StorageEvent) => {
      if (
        event.key === STORAGE_KEY ||
        event.key === "driveexam-map-theme-v2"
      ) {
        setModeState(readStoredMode());
      }
    };

    const onCustomChange = () => {
      setModeState(readStoredMode());
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onCustomChange);

    const timer = window.setInterval(() => {
      setClockTick((value) => value + 1);
    }, 60_000);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onCustomChange);
      window.clearInterval(timer);
    };
  }, []);

  const resolvedTheme = useMemo<ResolvedMapTheme>(() => {
    void clockTick;
    if (!hydrated) return "day";
    return mode === "auto" ? resolveAutomaticTheme() : mode;
  }, [mode, clockTick, hydrated]);

  function setMode(next: MapThemeMode) {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
  }

  return {
    mode,
    resolvedTheme,
    styleUrl: MAP_STYLE_URLS[resolvedTheme],
    setMode,
  };
}
