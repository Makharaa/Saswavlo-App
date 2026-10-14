"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MapPin, Route as RouteIcon, ArrowUpRight } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { CitySelect } from "@/components/city-select";
import { Badge, Surface } from "@/components/ui";
import { useSelectedCity } from "@/hooks/use-selected-city";
import { routeService } from "@/services/routes";
import type { RouteSummary } from "@/services/routes";

export default function RoutesPage() {
  const [cities, setCities] = useState<string[] | null>(null);
  const { city, setCity, ready } = useSelectedCity(cities);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
    setError("");
    routeService
      .listSummaries(`?published=1&city=${encodeURIComponent(city)}`)
      .then((list) => { if (mounted) setRoutes(list); })
      .catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : "მარშრუტები ვერ ჩაიტვირთა."); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [ready, city]);

  return (
    <main className="site-shell">
      <AppHeader />
      <section className="page-head">
        <div>
          <Badge tone="success">{city}</Badge>
          <h1>საგამოცდო მარშრუტები</h1>
          <p>აირჩიე ქალაქი და მარშრუტი. ბოლო ქალაქი შემდეგ შესვლაზეც შენახული რჩება.</p>
          <div className="city-picker">
            <CitySelect
              cities={[...new Set([...(cities ?? []), city])].sort((a, b) => a.localeCompare(b, "ka"))}
              value={city}
              disabled={!ready}
              onChange={setCity}
            />
          </div>
        </div>
      </section>

      <section className="route-gallery">
        {loading && <Surface className="empty-state">მარშრუტები იტვირთება...</Surface>}
        {!loading && error && <Surface className="empty-state">{error}</Surface>}
        {!loading && !error && !routes.length && <Surface className="empty-state">გამოქვეყნებული მარშრუტი ჯერ არ არის.</Surface>}
        {routes.map((route, index) => (
          <Surface key={route.id} className="route-card-modern">
            <div className="route-card-map"><div className="route-index">0{index + 1}</div><RouteIcon size={42} /></div>
            <div className="route-card-body">
              <div className="route-meta"><span><MapPin size={15} /> {route.city}</span><span>{route.checkpointCount} საკონტროლო წერტილი</span></div>
              <h2>{route.name}</h2>
              <p>{route.description || `${route.city} • სავარჯიშო მარშრუტი.`}</p>
              <Link href={`/drive?route=${route.id}`} className="route-open">მარშრუტის გახსნა <ArrowUpRight size={17} /></Link>
            </div>
          </Surface>
        ))}
      </section>
    </main>
  );
}
