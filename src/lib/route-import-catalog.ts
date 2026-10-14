// Small client-safe catalog. Geometry and original source JSON stay server-side.
// Only licensed Simulatori.ge Gori routes are offered in new releases.
export const BUNDLED_ROUTE_SOURCES = [
  "simulatori-gori-route-1",
  "simulatori-gori-route-2",
  "simulatori-gori-route-3",
  "simulatori-gori-route-4",
] as const;
export type BundledRouteSource = typeof BUNDLED_ROUTE_SOURCES[number];
export const BUNDLED_ROUTES: readonly {
  source: BundledRouteSource;
  name: string;
  city: string;
  sourceId: number;
  instructionCount: number;
  distanceKm: number;
  missingAudioCount: number;
}[] = [
  {
    "source": "simulatori-gori-route-1",
    "name": "Simulatori.ge - Gori N1 (B/BE)",
    "city": "გორი",
    "sourceId": -1,
    "instructionCount": 38,
    "distanceKm": 13.17,
    "missingAudioCount": 0
  },
  {
    "source": "simulatori-gori-route-2",
    "name": "Simulatori.ge - Gori N2 (B/BE)",
    "city": "გორი",
    "sourceId": -2,
    "instructionCount": 31,
    "distanceKm": 12.89,
    "missingAudioCount": 0
  },
  {
    "source": "simulatori-gori-route-3",
    "name": "Simulatori.ge - Gori N3 (B/BE)",
    "city": "გორი",
    "sourceId": -3,
    "instructionCount": 37,
    "distanceKm": 11.93,
    "missingAudioCount": 0
  },
  {
    "source": "simulatori-gori-route-4",
    "name": "Simulatori.ge - Gori N4 (B/BE)",
    "city": "გორი",
    "sourceId": -4,
    "instructionCount": 36,
    "distanceKm": 11.38,
    "missingAudioCount": 0
  }
];
