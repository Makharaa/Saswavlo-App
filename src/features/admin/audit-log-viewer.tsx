"use client";

import { useEffect, useMemo, useState } from "react";
import { Filter, Search, ScrollText, X } from "lucide-react";
import { Badge, Surface } from "@/components/ui";
import type { AuditLogEntry } from "@/types/domain";

type EntityFilter = "all" | "route" | "user" | "session" | "system";

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    "route.created": "მარშრუტი შეიქმნა",
    "route.updated": "მარშრუტი შეიცვალა",
    "route.deleted": "მარშრუტი წაიშალა",
    "route.version_restored": "ვერსია აღდგა",
    "user.created": "მომხმარებელი შეიქმნა",
    "user.updated": "მომხმარებელი შეიცვალა",
  };
  return labels[action] || action;
}

export function AuditLogViewer() {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState<EntityFilter>("all");

  useEffect(() => {
    fetch("/api/admin/audit-logs?limit=300", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error || "აუდიტი ვერ ჩაიტვირთა.");
        return body as AuditLogEntry[];
      })
      .then(setItems)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "აუდიტი ვერ ჩაიტვირთა."))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ka-GE");
    return items.filter((entry) => {
      const text = `${entry.summary} ${entry.action} ${entry.actorName ?? ""} ${entry.entityId ?? ""}`.toLocaleLowerCase("ka-GE");
      return (!needle || text.includes(needle)) && (entity === "all" || entry.entityType === entity);
    });
  }, [entity, items, query]);

  return (
    <div className="audit-viewer-v18">
      <Surface className="audit-toolbar-v18">
        <div className="history-v16-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ქმედება, მომხმარებელი ან ობიექტი" />
          {query && <button type="button" onClick={() => setQuery("")}><X size={14} /></button>}
        </div>
        <div className="history-v16-filters">
          <Filter size={15} />
          {([[
            "all", "ყველა"
          ], ["route", "მარშრუტი"], ["user", "მომხმარებელი"], ["session", "სესია"], ["system", "სისტემა"]] as [EntityFilter, string][]).map(([value, label]) => (
            <button key={value} type="button" className={entity === value ? "active" : ""} onClick={() => setEntity(value)}>{label}</button>
          ))}
        </div>
      </Surface>

      {loading && <Surface className="empty-state">აუდიტი იტვირთება...</Surface>}
      {!loading && error && <Surface className="empty-state">{error}</Surface>}
      {!loading && !error && !filtered.length && <Surface className="empty-state">ჩანაწერი ვერ მოიძებნა.</Surface>}

      <div className="audit-list-v18">
        {filtered.map((entry) => (
          <Surface className="audit-row-v18" key={entry.id}>
            <span className="audit-row-icon-v18"><ScrollText size={17} /></span>
            <div className="audit-row-copy-v18">
              <div><strong>{entry.summary}</strong><Badge tone="neutral">{actionLabel(entry.action)}</Badge></div>
              <p>{entry.actorName || "System"} • {new Date(entry.createdAt).toLocaleString("ka-GE")}</p>
            </div>
            <div className="audit-row-meta-v18">
              <code>{entry.entityType}{entry.entityId ? ` #${entry.entityId}` : ""}</code>
              {Object.keys(entry.metadata || {}).length > 0 && <small>{JSON.stringify(entry.metadata)}</small>}
            </div>
          </Surface>
        ))}
      </div>
    </div>
  );
}
