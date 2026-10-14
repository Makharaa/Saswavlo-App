"use client";

import {
  FlaskConical,
  Route as RouteIcon,
} from "lucide-react";
import { AppSelect } from "@/components/app-select";
import type { RouteSummary } from "@/services/routes";

export function DriveRouteSelect({
  routes,
  value,
  onChange,
  disabled = false,
  testMode = false,
}: {
  routes: RouteSummary[];
  value: number;
  onChange: (routeId: number) => void;
  disabled?: boolean;
  testMode?: boolean;
}) {
  const usableRoutes = routes.filter(
    (route): route is RouteSummary & { id: number } =>
      typeof route.id === "number"
  );

  const selected =
    usableRoutes.find((route) => route.id === value) ??
    usableRoutes[0] ??
    null;

  if (!selected) return null;

  return (
    <AppSelect
      value={selected.id}
      onChange={(routeId) => {
        if (disabled || testMode || routeId === value) return;
        onChange(routeId);
      }}
      disabled={disabled || testMode}
      startIcon={
        testMode ? <FlaskConical size={15} /> : <RouteIcon size={15} />
      }
      options={usableRoutes.map((route) => ({
        value: route.id,
        label: route.name,
        description: `${route.city} · ${route.checkpointCount} საკონტროლო · v${route.version}`,
        badge: testMode
          ? "Test"
          : route.isPublished
            ? "Published"
            : "Draft",
      }))}
      ariaLabel={
        testMode
          ? "ადმინისტრატორის სატესტო მარშრუტი"
          : "მარშრუტის არჩევა"
      }
      className="drive-route-app-select"
    />
  );
}
