"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Surface } from "@/components/ui";
import { FieldRecorder } from "@/features/admin/field-recorder";

function FieldContent() {
  const search = useSearchParams();
  const routeId = Number(search.get("route"));
  if (!Number.isFinite(routeId) || routeId <= 0) return <Surface className="empty-state page-loading">ჯერ Route Studio-დან აირჩიე მარშრუტი.</Surface>;
  return <FieldRecorder routeId={routeId} />;
}

export default function FieldPage() {
  return <main className="admin-shell"><AppHeader admin /><Suspense fallback={<Surface className="empty-state page-loading">იტვირთება...</Surface>}><FieldContent /></Suspense></main>;
}
