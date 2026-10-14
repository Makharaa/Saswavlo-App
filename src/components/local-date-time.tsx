"use client";

import { useEffect, useState } from "react";

/**
 * Prevents server/client hydration mismatches caused by locale and timezone
 * differences. First render is a deterministic UTC string on both sides;
 * only after hydration do we switch to the user's local Georgian formatting.
 */
export function LocalDateTime({
  value,
  format = "datetime",
}: {
  value: string | number;
  format?: "datetime" | "time" | "date";
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <time>—</time>;

  const iso = date.toISOString();
  const stable = format === "date"
    ? `${iso.slice(0, 10)} UTC`
    : format === "time"
      ? `${iso.slice(11, 19)} UTC`
      : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const localized = !hydrated ? stable : format === "time"
    ? date.toLocaleTimeString("ka-GE")
    : format === "date"
      ? date.toLocaleDateString("ka-GE")
      : date.toLocaleString("ka-GE");
  return <time dateTime={iso}>{localized}</time>;
}
