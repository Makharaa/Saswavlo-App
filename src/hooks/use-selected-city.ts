"use client";

import { useEffect, useRef, useState } from "react";
import {
  readCurrentUserId,
  readSelectedCity,
  resolveSelectedCity,
  writeSelectedCity,
} from "@/utils/selected-city";

export function useSelectedCity(cities: string[] | null) {
  const [city, setCityState] = useState("გორი");
  const [ready, setReady] = useState(false);
  const userIdRef = useRef<number | null>(null);
  const signature = cities == null ? null : cities.join("\u0000");

  useEffect(() => {
    if (signature == null || !cities) return;
    let cancelled = false;

    async function restore() {
      let userId = readCurrentUserId();
      if (userId == null) {
        try {
          const response = await fetch("/api/auth/me", { cache: "no-store" });
          const body = await response.json().catch(() => null);
          const id = Number(body?.user?.id);
          if (Number.isInteger(id) && id > 0) {
            userId = id;
            window.localStorage.setItem("driveexam-current-user-id", String(id));
          }
        } catch {
          userId = null;
        }
      }
      if (cancelled || !cities) return;
      userIdRef.current = userId;
      setCityState(resolveSelectedCity(cities, readSelectedCity(userId)));
      setReady(true);
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [cities, signature]);

  function setCity(next: string) {
    writeSelectedCity(userIdRef.current, next);
    setCityState(next);
  }

  return { city, setCity, ready };
}
