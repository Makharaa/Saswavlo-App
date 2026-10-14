import catalog from "../../data/imports/cities/catalog.json";

export type CityRouteCatalogEntry = {
  source: string;
  file: string;
  name: string;
  city: string;
  sortOrder: number | null;
  instructionCount: number;
  voicedCount: number;
  missingAudioCount: number;
  distanceKm: number;
};

export const CITY_ROUTES = catalog as readonly CityRouteCatalogEntry[];

export function isCityRouteSource(source: string) {
  return CITY_ROUTES.some((entry) => entry.source === source && entry.city !== "გორი");
}

export function cityRouteEntry(source: string) {
  return CITY_ROUTES.find((entry) => entry.source === source && entry.city !== "გორი") ?? null;
}
