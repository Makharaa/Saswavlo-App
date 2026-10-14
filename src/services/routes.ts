import type { BundledRouteSource } from "@/lib/route-import-catalog";
import type {
  ExamRoute,
  RouteDraft,
  RouteVersionSummary,
} from "@/types/domain";

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      data?.error || "მოთხოვნა ვერ შესრულდა.",
      response.status,
      data?.code,
      data
    );
  }
  return data as T;
}

export type RouteSummary = Pick<ExamRoute, "id" | "name" | "city" | "description" | "version" | "isPublished"> & {
  checkpointCount: number;
};

export const routeService = {
  listSummaries(query = "") {
    return fetch(`/api/routes${query}`, { cache: "no-store" }).then((res) =>
      parse<RouteSummary[]>(res)
    );
  },
  list(query = "") {
    return fetch(`/api/routes${query}`, { cache: "no-store" }).then((res) =>
      parse<ExamRoute[]>(res)
    );
  },

  get(id: number) {
    return fetch(`/api/routes/${id}`, { cache: "no-store" }).then((res) =>
      parse<ExamRoute>(res)
    );
  },

  create(input: Partial<RouteDraft>) {
    return fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((res) => parse<ExamRoute>(res));
  },

  importBundledRoute(source: BundledRouteSource | string) {
    return fetch("/api/routes/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    }).then((res) => parse<{ route: ExamRoute; reused: boolean }>(res));
  },

  cities(published = false) {
    const query = published ? "?published=1" : "";
    return fetch(`/api/routes/cities${query}`, { cache: "no-store" }).then((res) =>
      parse<{ cities: string[] }>(res)
    ).then((body) => body.cities);
  },

  save(id: number, input: RouteDraft, expectedVersion: number) {
    return fetch(`/api/routes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedVersion }),
    }).then((res) => parse<ExamRoute>(res));
  },

  remove(id: number, expectedVersion: number) {
    return fetch(
      `/api/routes/${id}?expectedVersion=${encodeURIComponent(expectedVersion)}`,
      { method: "DELETE" }
    ).then((res) => parse<{ ok: true }>(res));
  },

  versions(id: number, limit = 12) {
    return fetch(`/api/routes/${id}/versions?limit=${limit}`, {
      cache: "no-store",
    }).then((res) => parse<RouteVersionSummary[]>(res));
  },

  restoreVersion(id: number, version: number, expectedVersion: number) {
    return fetch(`/api/routes/${id}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, expectedVersion }),
    }).then((res) => parse<ExamRoute>(res));
  },
};
