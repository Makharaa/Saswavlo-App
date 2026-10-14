"use client";

import { Suspense, useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Surface } from "@/components/ui";
import { CitySelect } from "@/components/city-select";
import { DriveRouteSelect } from "@/components/drive-route-select";
import { DrivingExperience } from "@/features/driving/driving-experience";
import { useSelectedCity } from "@/hooks/use-selected-city";
import { routeService } from "@/services/routes";
import type { RouteSummary } from "@/services/routes";
import type { ExamRoute } from "@/types/domain";

function DriveContent() {
  const search = useSearchParams();
  const requestedId = Number(search.get("route"));
  const testMode = search.get("test") === "1";
  const [cities, setCities] = useState<string[] | null>(null);
  const { city, setCity, ready } = useSelectedCity(cities);
  const [followTestRoute, setFollowTestRoute] = useState(testMode);

  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [activeRoute, setActiveRoute] = useState<ExamRoute | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(
    Number.isFinite(requestedId) && requestedId > 0 ? requestedId : null
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [driveLocked, setDriveLocked] = useState(false);

  useEffect(() => {
    let mounted = true;
    routeService.cities(true)
      .then((list) => { if (mounted) setCities(list); })
      .catch(() => { if (mounted) setCities(["გორი"]); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    setLoading(true);
    setLoadError(null);

    const request =
      followTestRoute && Number.isFinite(requestedId) && requestedId > 0
        ? routeService.get(requestedId).then((route) => [{
            id: route.id, name: route.name, city: route.city,
            description: route.description, version: route.version,
            isPublished: route.isPublished, checkpointCount: route.checkpoints.length,
          }])
        : routeService.listSummaries(`?published=1&city=${encodeURIComponent(city)}`);

    request
      .then((data) => {
        if (!mounted) return;
        setRoutes(data);

        if (
          !selectedId ||
          !data.some((item) => item.id === selectedId)
        ) {
          setSelectedId(data[0]?.id ?? null);
        }
        if (followTestRoute && data[0]?.city && data[0].city !== city) {
          setCity(data[0].city);
        }
      })
      .catch((error) => {
        if (!mounted) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "მარშრუტის ჩატვირთვა ვერ მოხერხდა"
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [ready, city, followTestRoute, requestedId]);

  useEffect(() => {
    if (!selectedId) { setActiveRoute(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    setLoadError(null);
    routeService.get(selectedId)
      .then((detail) => { if (!cancelled) setActiveRoute(detail); })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "მარშრუტი ვერ ჩაიტვირთა."); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const route = activeRoute?.id === selectedId ? activeRoute : null;

  if (loading || (routes.length > 0 && (detailLoading || (!route && !loadError)))) {
    return (
      <Surface className="empty-state page-loading">
        მართვის რეჟიმი იტვირთება...
      </Surface>
    );
  }

  if (loadError) {
    return (
      <Surface className="empty-state page-loading">
        {loadError}
      </Surface>
    );
  }

  if (!route) {
    return (
      <Surface className="empty-state page-loading">
        <CitySelect
          cities={[...new Set([...(cities ?? []), city])].sort((a, b) => a.localeCompare(b, "ka"))}
          value={city}
          disabled={!ready}
          onChange={setCity}
        />
        <p>არჩეულ ქალაქში გამოქვეყნებული მარშრუტი ჯერ არ არის.</p>
      </Surface>
    );
  }

  return (
    <>
      {followTestRoute && (
        <div className="drive-v14-preview-banner">
          <FlaskConical size={14} />
          Admin ტესტი • მარშრუტი შეიძლება ჯერ გამოქვეყნებული არ იყოს
        </div>
      )}

      <DrivingExperience
        key={`${route.id}-${route.version}`}
        route={route}
        onSessionStateChange={setDriveLocked}
        routeSelector={
          <div className="drive-route-switcher drive-v17-route-switcher">
            <CitySelect
              cities={[...new Set([...(cities ?? []), city])].sort((a, b) => a.localeCompare(b, "ka"))}
              value={city}
              disabled={!ready || driveLocked}
              onChange={(next) => {
                if (next === city || driveLocked) return;
                setFollowTestRoute(false);
                setSelectedId(null);
                setCity(next);
              }}
            />
            <DriveRouteSelect
              routes={routes}
              value={route.id!}
              onChange={(nextId) => {
                if (nextId === route.id || driveLocked) return;
                setSelectedId(nextId);
              }}
              disabled={driveLocked}
              testMode={testMode}
            />
          </div>
        }
      />
    </>
  );
}

export default function DrivePage() {
  return (
    <main className="drive-page-shell">
      <AppHeader />
      <Suspense
        fallback={
          <Surface className="empty-state page-loading">
            იტვირთება...
          </Surface>
        }
      >
        <DriveContent />
      </Suspense>
    </main>
  );
}
