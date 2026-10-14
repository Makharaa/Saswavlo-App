"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, Surface } from "@/components/ui";
import { sessionService } from "@/services/sessions";
import type { PendingSession } from "@/services/session-store";

export function PendingSessions({ onSaved }: { onSaved: () => void }) {
  const [items, setItems] = useState<PendingSession[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const refresh = useCallback(async () => {
    try { setItems(await sessionService.listPending()); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "მოწყობილობის ჩანაწერები ვერ ჩაიტვირთა."); }
  }, []);
  useEffect(() => {
    void refresh();
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [refresh]);
  async function send() {
    setSending(true);
    try {
      const result = await sessionService.flushPending(true);
      await refresh();
      if (result.error) setError(result.error);
      if (result.saved) onSaved();
    } finally { setSending(false); }
  }
  function download(item: PendingSession) {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ route: item.routeSnapshot ?? null, session: item.result }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `DriveExam-${item.result.clientSessionId}.json`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!items.length && !error) return null;
  return <Surface className="pending-sessions">
    <div className="result-section-head"><div><small>მოწყობილობაზე შენახული შედეგები</small><h2>{items.length} შედეგი გაგზავნას ელოდება</h2></div>
      <Button variant="secondary" disabled={sending || !items.length} onClick={() => void send()}>{sending ? "იგზავნება..." : "გაგზავნის გამეორება"}</Button></div>
    {error && <p role="alert">{error}</p>}
    {items.map((item) => <div key={item.key} className="pending-session-row">
      <div><b>{new Date(item.result.finishedAt).toLocaleString("ka-GE")} • {item.result.mode === "real" ? "რეალური მოძრაობა" : "სიმულაცია"}</b>
        <small>{item.status === "auth_required" ? "ანგარიშში ხელახლა შესვლა საჭიროა. " : item.status === "blocked" ? "სერვერმა შედეგი ვერ მიიღო. " : "კავშირის აღდგენას ელოდება. "}{item.lastError}</small></div>
      <Button variant="secondary" onClick={() => download(item)}>ჩამოტვირთვა</Button>
    </div>)}
  </Surface>;
}
