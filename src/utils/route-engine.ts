import type {
  ExamRoute,
  GeoPoint,
  RouteSpeedZone,
  RouteValidationIssue,
} from "../types/domain";
import {
  haversineMeters,
  nearestPointOnRoute,
  nearestPointOnRouteRange,
  routeCumulativeDistances,
  routeLengthMeters,
} from "./geo";
import { validWaypointCoordinateIndices } from "./route-editor";

export function normalizeAngle(value: number) {
  let angle = value;
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}

export function headingDifference(a: number, b: number) {
  return Math.abs(normalizeAngle(a - b));
}

export function routePercentForIndex(
  index: number,
  coordinates: [number, number][]
) {
  if (coordinates.length <= 1 || index <= 0) return 0;
  const clampedIndex = Math.min(coordinates.length - 1, Math.max(0, index));
  const cumulative = routeCumulativeDistances(coordinates);
  const total = cumulative.at(-1) ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (cumulative[clampedIndex] / total) * 100));
}

export function coordinateIndexForPercent(
  percent: number,
  coordinates: [number, number][]
) {
  if (!coordinates.length) return -1;
  if (coordinates.length === 1) return 0;

  const clamped = Math.max(0, Math.min(100, percent));
  const cumulative = routeCumulativeDistances(coordinates);
  const total = cumulative.at(-1) ?? 0;
  if (total <= 0) return 0;

  const target = total * (clamped / 100);
  for (let index = 1; index < cumulative.length; index += 1) {
    if (cumulative[index] >= target) return index;
  }
  return coordinates.length - 1;
}

/**
 * Converts old percentage based zones into route-index zones at read time.
 * New saves only use startCoordinateIndex/endCoordinateIndex. This keeps old
 * route snapshots compatible without keeping percentage controls in the UI.
 */
export function normalizeSpeedZones(
  zones: Array<Partial<RouteSpeedZone>>,
  coordinates: [number, number][]
): RouteSpeedZone[] {
  if (!coordinates.length) return [];
  const maxIndex = Math.max(0, coordinates.length - 1);

  return (zones ?? [])
    .map((zone, index) => {
      const legacyStart = Number(zone.startPercent);
      const legacyEnd = Number(zone.endPercent);

      const rawStart = Number.isFinite(zone.startCoordinateIndex)
        ? Number(zone.startCoordinateIndex)
        : Number.isFinite(legacyStart)
          ? coordinateIndexForPercent(legacyStart, coordinates)
          : 0;

      const rawEnd = Number.isFinite(zone.endCoordinateIndex)
        ? Number(zone.endCoordinateIndex)
        : Number.isFinite(legacyEnd)
          ? coordinateIndexForPercent(legacyEnd, coordinates)
          : maxIndex;

      const startCoordinateIndex = Math.max(
        0,
        Math.min(maxIndex, Math.round(rawStart))
      );
      const endCoordinateIndex = Math.max(
        startCoordinateIndex,
        Math.min(maxIndex, Math.round(rawEnd))
      );

      return {
        id: String(zone.id || `zone-${index + 1}`),
        startCoordinateIndex,
        endCoordinateIndex,
        speedLimit: Math.max(
          5,
          Math.min(130, Math.round(Number(zone.speedLimit) || 50))
        ),
        label: String(zone.label || "სიჩქარის ზონა"),
      } satisfies RouteSpeedZone;
    })
    .sort(
      (a, b) =>
        a.startCoordinateIndex - b.startCoordinateIndex ||
        a.endCoordinateIndex - b.endCoordinateIndex
    );
}

export function speedLimitAtRouteIndex(zones: RouteSpeedZone[], routeIndex: number, fallback?: number): number;
export function speedLimitAtRouteIndex(zones: RouteSpeedZone[], routeIndex: number, fallback: null): number | null;
export function speedLimitAtRouteIndex(
  zones: RouteSpeedZone[],
  routeIndex: number,
  fallback: number | null = 50
) {
  if (routeIndex < 0) return fallback;
  const active = [...zones]
    .sort((a, b) => a.startCoordinateIndex - b.startCoordinateIndex)
    .find(
      (zone) =>
        routeIndex >= zone.startCoordinateIndex &&
        routeIndex <= zone.endCoordinateIndex
    );
  return active?.speedLimit ?? fallback;
}

/**
 * Reprojects route-relative annotations when route geometry changes.
 * Coordinate indexes are kept for older clients and the editor UI, but are
 * regenerated from actual geometry instead of being trusted across versions.
 */
export function remapRouteReferences<T extends {
  lng: number;
  lat: number;
  routeCoordinateIndex?: number | null;
}>(
  previousCoordinates: [number, number][],
  nextCoordinates: [number, number][],
  checkpoints: T[],
  speedZones: RouteSpeedZone[]
) {
  if (nextCoordinates.length < 2) {
    return {
      checkpoints: checkpoints.map((checkpoint) => ({
        ...checkpoint,
        routeCoordinateIndex: null,
      })),
      speedZones: speedZones.map((zone) => ({
        ...zone,
        startCoordinateIndex: 0,
        endCoordinateIndex: 0,
      })),
    };
  }

  // Incremental editor operations retain exact prefix/suffix vertices. Their
  // annotations must keep those occurrences, even if the new leg visits the
  // same street again or greatly changes the overall route length.
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  let prefix = 0;
  while (prefix < Math.min(previousCoordinates.length, nextCoordinates.length) &&
    same(previousCoordinates[prefix], nextCoordinates[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(previousCoordinates.length, nextCoordinates.length) - prefix &&
    same(previousCoordinates[previousCoordinates.length - 1 - suffix], nextCoordinates[nextCoordinates.length - 1 - suffix])) suffix += 1;
  const retainedIndex = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= previousCoordinates.length) return null;
    if (index < prefix) return index;
    if (index >= previousCoordinates.length - suffix) return nextCoordinates.length - (previousCoordinates.length - index);
    return null;
  };

  const checkpointFloor = { value: 0 };
  const remappedCheckpoints = checkpoints.map((checkpoint) => {
    let expectedPercent: number | null = null;
    const oldIndex = checkpoint.routeCoordinateIndex;
    if (
      previousCoordinates.length > 1 &&
      oldIndex != null &&
      Number.isFinite(oldIndex) &&
      oldIndex >= 0 &&
      oldIndex < previousCoordinates.length
    ) {
      const oldPoint = previousCoordinates[Math.round(oldIndex)];
      if (oldPoint && haversineMeters(checkpoint, { lng: oldPoint[0], lat: oldPoint[1] }) <= 25) {
        const preserved = retainedIndex(oldIndex);
        if (preserved != null) {
          checkpointFloor.value = Math.max(checkpointFloor.value, preserved);
          return { ...checkpoint, routeCoordinateIndex: preserved };
        }
        expectedPercent = routePercentForIndex(oldIndex, previousCoordinates);
      }
    }

    const hint = expectedPercent == null
      ? nearestPointOnRoute(checkpoint, nextCoordinates).progressPercent
      : expectedPercent;
    const expectedIndex = coordinateIndexForPercent(hint, nextCoordinates);
    const window = Math.max(20, Math.ceil(nextCoordinates.length * 0.18));
    const start = Math.max(checkpointFloor.value, expectedIndex - window);
    const end = Math.min(nextCoordinates.length - 2, expectedIndex + window);
    const match = nearestPointOnRouteRange(checkpoint, nextCoordinates, start, Math.max(start, end));
    checkpointFloor.value = Math.max(checkpointFloor.value, match.index);

    return { ...checkpoint, routeCoordinateIndex: match.index };
  });

  const oldTotal = routeLengthMeters(previousCoordinates);
  // Route references from a route without geometry cannot be projected. In
  // that case the submitted indexes already refer to the new geometry.
  if (previousCoordinates.length < 2 || oldTotal <= 0) {
    return {
      checkpoints: remappedCheckpoints,
      speedZones: normalizeSpeedZones(speedZones, nextCoordinates),
    };
  }
  const zoneFloor = { value: 0 };
  const remappedZones = [...speedZones]
    .sort((a, b) => a.startCoordinateIndex - b.startCoordinateIndex)
    .map((zone) => {
      const oldStartIndex = Math.max(0, Math.min(previousCoordinates.length - 1, Math.round(zone.startCoordinateIndex)));
      const oldEndIndex = Math.max(oldStartIndex, Math.min(previousCoordinates.length - 1, Math.round(zone.endCoordinateIndex)));
      const startPoint = previousCoordinates[oldStartIndex];
      const endPoint = previousCoordinates[oldEndIndex];
      const preservedStart = retainedIndex(oldStartIndex);
      const preservedEnd = retainedIndex(oldEndIndex);

      const expectedStartPercent = oldTotal > 0
        ? routePercentForIndex(oldStartIndex, previousCoordinates)
        : 0;
      const expectedEndPercent = oldTotal > 0
        ? routePercentForIndex(oldEndIndex, previousCoordinates)
        : 100;
      const startHint = preservedStart ?? (startPoint
        ? coordinateIndexForPercent(expectedStartPercent, nextCoordinates)
        : zoneFloor.value);
      const startWindow = Math.max(20, Math.ceil(nextCoordinates.length * 0.18));
      const startSegment = Math.max(zoneFloor.value, startHint - startWindow);
      const startMatch = startPoint
        ? nearestPointOnRouteRange(
            { lng: startPoint[0], lat: startPoint[1] },
            nextCoordinates,
            startSegment,
            Math.min(nextCoordinates.length - 2, startHint + startWindow)
          )
        : nearestPointOnRouteRange(
            { lng: nextCoordinates[startHint][0], lat: nextCoordinates[startHint][1] },
            nextCoordinates,
            startSegment,
            Math.min(nextCoordinates.length - 2, startHint + startWindow)
          );

      const endHint = preservedEnd ?? coordinateIndexForPercent(expectedEndPercent, nextCoordinates);
      const endWindow = Math.max(20, Math.ceil(nextCoordinates.length * 0.18));
      const endMatch = endPoint
        ? nearestPointOnRouteRange(
            { lng: endPoint[0], lat: endPoint[1] },
            nextCoordinates,
            Math.max(startMatch.segmentIndex, endHint - endWindow),
            Math.min(nextCoordinates.length - 2, endHint + endWindow)
          )
        : startMatch;

      // Zone boundaries are inclusive, so the next zone must begin after the
      // previous zone's final coordinate to avoid accidental overlap.
      const startCoordinateIndex = Math.min(nextCoordinates.length - 2, Math.max(zoneFloor.value, preservedStart ?? startMatch.index));
      const endCoordinateIndex = Math.min(nextCoordinates.length - 1, Math.max(startCoordinateIndex + 1, preservedEnd ?? endMatch.index));
      zoneFloor.value = endCoordinateIndex + 1;
      return { ...zone, startCoordinateIndex, endCoordinateIndex };
    });

  return { checkpoints: remappedCheckpoints, speedZones: remappedZones };
}

export function speedZoneFeatures(
  coordinates: [number, number][],
  zones: RouteSpeedZone[]
) {
  return {
    type: "FeatureCollection" as const,
    features: zones
      .map((zone) => {
        if (coordinates.length < 2) return null;
        const maxIndex = coordinates.length - 1;
        const start = Math.max(
          0,
          Math.min(maxIndex, Math.round(zone.startCoordinateIndex))
        );
        const end = Math.max(
          start,
          Math.min(maxIndex, Math.round(zone.endCoordinateIndex))
        );
        if (end <= start) return null;
        const segment = coordinates.slice(start, end + 1);
        if (segment.length < 2) return null;
        return {
          type: "Feature" as const,
          properties: {
            id: zone.id,
            speedLimit:
              typeof zone.speedLimit === "number" &&
              Number.isFinite(zone.speedLimit)
                ? zone.speedLimit
                : 50,
            label: typeof zone.label === "string" ? zone.label : "",
          },
          geometry: {
            type: "LineString" as const,
            coordinates: segment,
          },
        };
      })
      .filter(Boolean),
  };
}

export function createCirclePolygon(
  center: GeoPoint,
  radiusMeters: number,
  steps = 64
) {
  const earth = 6_378_137;
  const lat = (center.lat * Math.PI) / 180;
  const coords: [number, number][] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    const dx = Math.cos(angle) * radiusMeters;
    const dy = Math.sin(angle) * radiusMeters;
    const latOffset = (dy / earth) * (180 / Math.PI);
    const lngOffset =
      (dx / (earth * Math.max(0.1, Math.cos(lat)))) * (180 / Math.PI);
    coords.push([center.lng + lngOffset, center.lat + latOffset]);
  }
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [coords] },
  };
}

export function validateRoute(route: ExamRoute): RouteValidationIssue[] {
  const issues: RouteValidationIssue[] = [];

  if (route.waypointCoordinateIndices && !validWaypointCoordinateIndices(route)) {
    issues.push({ level: "error", code: "waypoint-indices", message: "საყრდენების რიგითობა არსებულ გზას არ ემთხვევა." });
  }

  if (!route.name.trim()) {
    issues.push({
      level: "error",
      code: "name-empty",
      message: "მარშრუტის სახელი აუცილებელია.",
    });
  }

  if (route.coordinates.length < 2) {
    issues.push({
      level: "error",
      code: "route-empty",
      message: "მარშრუტს მინიმუმ ორი გზის წერტილი სჭირდება.",
    });
  }

  if (!route.fieldTestedAt) issues.push({ level: "warning", code: "field-test-required", message: "მარშრუტი ავტომობილში ჯერ არ არის დადასტურებული. შეამოწმე ორივე მიმართულება, დავალებები და ხმოვანი ინსტრუქციები." });
  const routeLength = routeLengthMeters(route.coordinates);
  if (route.coordinates.length >= 2 && routeLength < 120) {
    issues.push({
      level: "warning",
      code: "route-short",
      message: "მარშრუტი ძალიან მოკლეა. გადაამოწმე დაწყებისა და ფინიშის წერტილები.",
    });
  }

  let previousCheckpointProgress = -1;
  route.checkpoints.forEach((checkpoint, index) => {
    if (!checkpoint.title.trim()) {
      issues.push({
        level: "error",
        code: `checkpoint-title-${index}`,
        message: `საკონტროლო წერტილს #${index + 1} ეკრანის ტექსტი არ აქვს.`,
      });
    }

    if (!checkpoint.voice.trim()) {
      issues.push({
        level: "warning",
        code: `checkpoint-voice-${index}`,
        message: `საკონტროლო წერტილს #${index + 1} ჩაწერილი ხმოვანი ინსტრუქცია არ აქვს.`,
      });
    }

    if (checkpoint.triggerMeters < 10 || checkpoint.triggerMeters > 1000) {
      issues.push({
        level: "error",
        code: `checkpoint-trigger-${index}`,
        message: `საკონტროლო წერტილის #${index + 1} გაფრთხილების მანძილი უნდა იყოს 10–1000 მეტრი.`,
      });
    }

    if (route.coordinates.length < 2) return;
    const nearest = nearestPointOnRoute(checkpoint, route.coordinates);
    const distance = nearest.distance;
    if (distance > Math.max(80, checkpoint.triggerMeters)) {
      issues.push({
        level: "error",
        code: `checkpoint-offroute-${index}`,
        message: `საკონტროლო წერტილი #${index + 1} მარშრუტიდან ${Math.round(distance)} მეტრითაა დაშორებული.`,
      });
    }
    const rawIndex = checkpoint.routeCoordinateIndex;
    const indexedCoordinate = rawIndex == null
      ? null
      : route.coordinates[Math.round(rawIndex)];
    const checkpointProgress = indexedCoordinate &&
      haversineMeters(checkpoint, { lng: indexedCoordinate[0], lat: indexedCoordinate[1] }) <= 50
      ? routePercentForIndex(Math.round(rawIndex!), route.coordinates)
      : nearest.progressPercent;
    if (checkpointProgress + 0.5 < previousCheckpointProgress) {
      issues.push({
        level: "error",
        code: `checkpoint-order-${index}`,
        message: `საკონტროლო წერტილი #${index + 1} მარშრუტის რიგს არღვევს. გადაალაგე ან გზაზე თავიდან მიაბი.`,
      });
    }
    previousCheckpointProgress = Math.max(previousCheckpointProgress, checkpointProgress);
    if (checkpoint.routeCoordinateIndex != null) {
      const anchorIndex = Math.round(checkpoint.routeCoordinateIndex);
      const anchor = route.coordinates[anchorIndex];
      if (!anchor || haversineMeters(checkpoint, { lng: anchor[0], lat: anchor[1] }) > 50) {
        issues.push({
          level: "error",
          code: `checkpoint-index-${index}`,
          message: `საკონტროლო წერტილი #${index + 1} ძველ გზის წერტილს ებმის. გადააბი გზაზე Route Studio-ში.`,
        });
      }
    }
  });

  const maxIndex = Math.max(0, route.coordinates.length - 1);
  const zones = [...route.speedZones].sort(
    (a, b) => a.startCoordinateIndex - b.startCoordinateIndex
  );

  zones.forEach((zone, index) => {
    if (
      zone.startCoordinateIndex < 0 ||
      zone.endCoordinateIndex > maxIndex ||
      zone.startCoordinateIndex >= zone.endCoordinateIndex
    ) {
      issues.push({
        level: "error",
        code: `speed-zone-range-${zone.id}`,
        message: `სიჩქარის ზონა #${index + 1} არასწორ მონაკვეთს იყენებს.`,
      });
    }

    const next = zones[index + 1];
    if (next && next.startCoordinateIndex <= zone.endCoordinateIndex) {
      issues.push({
        level: "error",
        code: `speed-zone-overlap-${zone.id}`,
        message: `სიჩქარის ზონები #${index + 1} და #${index + 2} ერთმანეთს ფარავს.`,
      });
    }

    if (next && next.startCoordinateIndex > zone.endCoordinateIndex + 1) {
      issues.push({
        level: "error",
        code: `speed-zone-gap-${zone.id}`,
        message: `სიჩქარის ზონებს #${index + 1} და #${index + 2} შორის დაუფარავი მონაკვეთია.`,
      });
    }
  });

  if (zones.length) {
    if (zones[0].startCoordinateIndex > 0) {
      issues.push({
        level: "error",
        code: "speed-zone-start-gap",
        message: "სიჩქარის ზონები მარშრუტის დასაწყისიდან არ იწყება.",
      });
    }
    if (zones[zones.length - 1].endCoordinateIndex < maxIndex) {
      issues.push({
        level: "error",
        code: "speed-zone-end-gap",
        message: "სიჩქარის ზონები მარშრუტის ბოლომდე არ გრძელდება.",
      });
    }
  }

  if (!route.speedZones.length) {
    issues.push({
      level: "error",
      code: "no-speed-zones",
      message: "მარშრუტზე სიჩქარის ზონები ჯერ არ არის განსაზღვრული.",
    });
  }

  if (!route.checkpoints.length) {
    issues.push({
      level: "warning",
      code: "no-checkpoints",
      message: "მარშრუტს საკონტროლო წერტილები ჯერ არ აქვს.",
    });
  }

  return issues;
}
