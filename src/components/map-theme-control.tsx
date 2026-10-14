"use client";

import { Clock3, Moon, Sun } from "lucide-react";
import type { MapThemeMode, ResolvedMapTheme } from "@/hooks/use-map-theme";

export function MapThemeControl({
  mode,
  resolvedTheme,
  onChange,
  compact = false,
}: {
  mode: MapThemeMode;
  resolvedTheme: ResolvedMapTheme;
  onChange: (mode: MapThemeMode) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`map-theme-control ${compact ? "compact" : ""}`}
      data-resolved-theme={resolvedTheme}
      aria-label="რუკის ფერის რეჟიმი"
    >
      <button
        type="button"
        className={mode === "day" ? "active" : ""}
        onClick={() => onChange("day")}
        title="დღის რუკა"
        aria-label="დღის რუკა"
      >
        <Sun size={14} />
        {!compact && <span>დღე</span>}
      </button>

      <button
        type="button"
        className={mode === "auto" ? "active" : ""}
        onClick={() => onChange("auto")}
        title={`ავტომატური რეჟიმი • ახლა ${resolvedTheme === "night" ? "ღამე" : "დღე"}`}
        aria-label="რუკის ავტომატური რეჟიმი"
      >
        <Clock3 size={14} />
        {!compact && <span>ავტო</span>}
      </button>

      <button
        type="button"
        className={mode === "night" ? "active" : ""}
        onClick={() => onChange("night")}
        title="ღამის რუკა"
        aria-label="ღამის რუკა"
      >
        <Moon size={14} />
        {!compact && <span>ღამე</span>}
      </button>
    </div>
  );
}
