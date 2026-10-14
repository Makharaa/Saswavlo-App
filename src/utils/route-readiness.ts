import type { RouteDraft } from "../types/domain";
/** Metadata and database IDs do not alter what must be checked on the road. */
export function routeDrivingFingerprint(route: Pick<RouteDraft, "coordinates" | "speedZones" | "checkpoints">): string {
  return JSON.stringify({ coordinates: route.coordinates,
    zones: [...route.speedZones].sort((a, b) => a.startCoordinateIndex - b.startCoordinateIndex).map((zone) => [zone.startCoordinateIndex, zone.endCoordinateIndex, zone.speedLimit]),
    checkpoints: route.checkpoints.map((checkpoint) => [checkpoint.orderIndex, checkpoint.lng, checkpoint.lat, checkpoint.type, checkpoint.title,
      checkpoint.voice, checkpoint.ttsVoice, checkpoint.speedLimit, checkpoint.triggerMeters, checkpoint.routeCoordinateIndex ?? null,
      checkpoint.evaluation?.stopSeconds ?? 2, checkpoint.evaluation?.stopRadiusMeters ?? 12, checkpoint.evaluation?.departureMeters ?? 15,
      checkpoint.evaluation?.instructionOnly ?? false]),
  });
}
export function carryFieldTest(oldRoute: RouteDraft & { fieldTestedAt?: string | null }, nextRoute: RouteDraft): string | null {
  return nextRoute.fieldTestedAt && routeDrivingFingerprint(oldRoute) === routeDrivingFingerprint(nextRoute)
    ? oldRoute.fieldTestedAt || new Date().toISOString() : null;
}
