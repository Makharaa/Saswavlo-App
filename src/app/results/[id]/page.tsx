"use client";

import { use, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { Surface } from "@/components/ui";
import { SessionResults } from "@/features/results/session-results";
import { sessionService } from "@/services/sessions";
import type { DrivingSessionDetail } from "@/types/domain";

export default function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<DrivingSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    sessionService
      .get(Number(id))
      .then(setSession)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "სესია ვერ ჩაიტვირთა."))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main className="page-shell">
      <AppHeader />
      {loading && <Surface className="empty-state page-loading">შედეგი იტვირთება...</Surface>}
      {!loading && !session && <Surface className="empty-state page-loading">{error || "სესია ვერ მოიძებნა."}</Surface>}
      {session && <SessionResults session={session} />}
    </main>
  );
}
