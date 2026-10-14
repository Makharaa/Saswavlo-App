import type { GeoPoint } from "../types/domain";

const EARTH_RADIUS = 6_371_000;

export function haversineMeters(a: GeoPoint, b: GeoPoint) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function routeCumulativeDistances(coordinates: [number, number][]) {
  if (!coordinates.length) return [];

  const distances = [0];
  let total = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    total += haversineMeters(
      { lng: coordinates[index - 1][0], lat: coordinates[index - 1][1] },
      { lng: coordinates[index][0], lat: coordinates[index][1] }
    );
    distances.push(total);
  }

  return distances;
}

export function routeLengthMeters(coordinates: [number, number][]) {
  const distances = routeCumulativeDistances(coordinates);
  return distances.at(-1) ?? 0;
}

function localXY(point: GeoPoint, origin: GeoPoint): [number, number] {
  const latRad = (origin.lat * Math.PI) / 180;
  const x = (point.lng - origin.lng) * 111_320 * Math.cos(latRad);
  const y = (point.lat - origin.lat) * 110_540;
  return [x, y];
}

function localLngLat(x: number, y: number, origin: GeoPoint): GeoPoint {
  const latRad = (origin.lat * Math.PI) / 180;
  const cosLat = Math.max(0.05, Math.cos(latRad));
  return {
    lng: origin.lng + x / (111_320 * cosLat),
    lat: origin.lat + y / 110_540,
  };
}

export type NearestRoutePoint = {
  point: GeoPoint;
  distance: number;
  index: number;
  segmentIndex: number;
  segmentT: number;
  distanceAlongMeters: number;
  progressPercent: number;
};

/**
 * Finds the closest point on route line segments rather than only the nearest
 * stored coordinate. This is important because OSRM geometry density is not
 * perfectly uniform and GPS/checkpoint locations commonly fall between two
 * geometry points.
 */
export function nearestPointOnRoute(
  point: GeoPoint,
  coordinates: [number, number][],
  cachedCumulative?: readonly number[]
): NearestRoutePoint {
  if (!coordinates.length) {
    return {
      point,
      distance: Number.POSITIVE_INFINITY,
      index: -1,
      segmentIndex: -1,
      segmentT: 0,
      distanceAlongMeters: 0,
      progressPercent: 0,
    };
  }

  if (coordinates.length === 1) {
    const snapped = { lng: coordinates[0][0], lat: coordinates[0][1] };
    return {
      point: snapped,
      distance: haversineMeters(point, snapped),
      index: 0,
      segmentIndex: 0,
      segmentT: 0,
      distanceAlongMeters: 0,
      progressPercent: 0,
    };
  }

  const cumulative = cachedCumulative ?? routeCumulativeDistances(coordinates);
  const totalDistance = cumulative.at(-1) ?? 0;

  let best: NearestRoutePoint | null = null;

  for (let segmentIndex = 0; segmentIndex < coordinates.length - 1; segmentIndex += 1) {
    const a = { lng: coordinates[segmentIndex][0], lat: coordinates[segmentIndex][1] };
    const b = { lng: coordinates[segmentIndex + 1][0], lat: coordinates[segmentIndex + 1][1] };
    const origin = {
      lng: (a.lng + b.lng + point.lng) / 3,
      lat: (a.lat + b.lat + point.lat) / 3,
    };

    const [ax, ay] = localXY(a, origin);
    const [bx, by] = localXY(b, origin);
    const [px, py] = localXY(point, origin);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    const t =
      lengthSquared <= 0.000001
        ? 0
        : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));

    const closestX = ax + dx * t;
    const closestY = ay + dy * t;
    const snapped = localLngLat(closestX, closestY, origin);
    const distance = Math.hypot(px - closestX, py - closestY);

    if (!best || distance < best.distance) {
      const segmentLength = cumulative[segmentIndex + 1] - cumulative[segmentIndex];
      const distanceAlongMeters = cumulative[segmentIndex] + segmentLength * t;
      best = {
        point: snapped,
        distance,
        index: t < 0.5 ? segmentIndex : segmentIndex + 1,
        segmentIndex,
        segmentT: t,
        distanceAlongMeters,
        progressPercent:
          totalDistance > 0
            ? Math.max(0, Math.min(100, (distanceAlongMeters / totalDistance) * 100))
            : 0,
      };
    }
  }

  return best!;
}

/**
 * Finds the nearest point only inside a route segment window. This is used by
 * real driving to keep progress continuous when the geometry crosses itself or
 * the same street is driven again in the opposite direction.
 */
export function nearestPointOnRouteRange(
  point: GeoPoint,
  coordinates: [number, number][],
  startSegment: number,
  endSegment: number,
  cachedCumulative?: readonly number[],
  scoreCandidate?: (segmentIndex: number, distance: number, distanceAlongMeters: number) => number
): NearestRoutePoint {
  if (coordinates.length < 2) {
    return nearestPointOnRoute(point, coordinates, cachedCumulative);
  }

  const cumulative = cachedCumulative ?? routeCumulativeDistances(coordinates);
  const totalDistance = cumulative.at(-1) ?? 0;
  const firstSegment = Math.max(
    0,
    Math.min(coordinates.length - 2, Math.floor(startSegment))
  );
  const lastSegment = Math.max(
    firstSegment,
    Math.min(coordinates.length - 2, Math.floor(endSegment))
  );

  let best: NearestRoutePoint | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (
    let segmentIndex = firstSegment;
    segmentIndex <= lastSegment;
    segmentIndex += 1
  ) {
    const a = {
      lng: coordinates[segmentIndex][0],
      lat: coordinates[segmentIndex][1],
    };
    const b = {
      lng: coordinates[segmentIndex + 1][0],
      lat: coordinates[segmentIndex + 1][1],
    };
    const origin = {
      lng: (a.lng + b.lng + point.lng) / 3,
      lat: (a.lat + b.lat + point.lat) / 3,
    };

    const [ax, ay] = localXY(a, origin);
    const [bx, by] = localXY(b, origin);
    const [px, py] = localXY(point, origin);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared <= 0.000001
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((px - ax) * dx + (py - ay) * dy) / lengthSquared
            )
          );

    const closestX = ax + dx * t;
    const closestY = ay + dy * t;
    const snapped = localLngLat(closestX, closestY, origin);
    const distance = Math.hypot(px - closestX, py - closestY);

    const segmentLength = cumulative[segmentIndex + 1] - cumulative[segmentIndex];
    const distanceAlongMeters = cumulative[segmentIndex] + segmentLength * t;
    const score = scoreCandidate?.(segmentIndex, distance, distanceAlongMeters) ?? distance;
    if (score < bestScore) {
      bestScore = score;

      best = {
        point: snapped,
        distance,
        index: t < 0.5 ? segmentIndex : segmentIndex + 1,
        segmentIndex,
        segmentT: t,
        distanceAlongMeters,
        progressPercent:
          totalDistance > 0
            ? Math.max(
                0,
                Math.min(100, (distanceAlongMeters / totalDistance) * 100)
              )
            : 0,
      };
    }
  }

  return best ?? nearestPointOnRoute(point, coordinates, cachedCumulative);
}

export function nearestCoordinateIndex(
  point: GeoPoint,
  coordinates: [number, number][]
) {
  return nearestPointOnRoute(point, coordinates).index;
}

export function nearestRouteDistance(
  point: GeoPoint,
  coordinates: [number, number][]
) {
  return nearestPointOnRoute(point, coordinates).distance;
}

export function routeProgressPercent(
  point: GeoPoint,
  coordinates: [number, number][]
) {
  return nearestPointOnRoute(point, coordinates).progressPercent;
}

export function densifyRoute(
  coordinates: [number, number][],
  spacingMeters = 8
): [number, number][] {
  if (coordinates.length <= 1) return coordinates;

  const dense: [number, number][] = [coordinates[0]];

  for (let i = 1; i < coordinates.length; i++) {
    const start = coordinates[i - 1];
    const end = coordinates[i];
    const distance = haversineMeters(
      { lng: start[0], lat: start[1] },
      { lng: end[0], lat: end[1] }
    );

    const steps = Math.max(1, Math.ceil(distance / spacingMeters));

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      dense.push([
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ]);
    }
  }

  return dense;
}

export function metersPerSecondToKmh(value: number | null | undefined) {
  return value == null || Number.isNaN(value)
    ? 0
    : Math.max(0, value * 3.6);
}

export function bearingDegrees(a: GeoPoint, b: GeoPoint) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function interpolatePoint(
  a: GeoPoint,
  b: GeoPoint,
  amount: number
): GeoPoint {
  const t = Math.min(1, Math.max(0, amount));
  return {
    lng: a.lng + (b.lng - a.lng) * t,
    lat: a.lat + (b.lat - a.lat) * t,
  };
}

function projectToMeters(
  point: [number, number],
  originLat: number
): [number, number] {
  const latRad = (originLat * Math.PI) / 180;
  const x = point[0] * 111_320 * Math.cos(latRad);
  const y = point[1] * 110_540;
  return [x, y];
}

function perpendicularDistanceMeters(
  point: [number, number],
  start: [number, number],
  end: [number, number],
  originLat: number
) {
  const [px, py] = projectToMeters(point, originLat);
  const [sx, sy] = projectToMeters(start, originLat);
  const [ex, ey] = projectToMeters(end, originLat);

  const dx = ex - sx;
  const dy = ey - sy;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - sx, py - sy);
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy))
  );

  const closestX = sx + t * dx;
  const closestY = sy + t * dy;

  return Math.hypot(px - closestX, py - closestY);
}

/**
 * Douglas–Peucker simplification using an approximate local meter projection.
 * Keeps the first and last coordinate and removes GPS noise without changing
 * the route's overall shape.
 */
export function simplifyRoute(
  coordinates: [number, number][],
  toleranceMeters = 2.5
): [number, number][] {
  if (coordinates.length <= 2) return [...coordinates];

  const originLat = coordinates.reduce((sum, item) => sum + item[1], 0) / coordinates.length;

  function simplifyRange(
    startIndex: number,
    endIndex: number,
    keep: Set<number>
  ) {
    if (endIndex <= startIndex + 1) return;

    let bestIndex = -1;
    let bestDistance = 0;

    for (let index = startIndex + 1; index < endIndex; index++) {
      const distance = perpendicularDistanceMeters(
        coordinates[index],
        coordinates[startIndex],
        coordinates[endIndex],
        originLat
      );

      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestDistance > toleranceMeters) {
      keep.add(bestIndex);
      simplifyRange(startIndex, bestIndex, keep);
      simplifyRange(bestIndex, endIndex, keep);
    }
  }

  const keep = new Set<number>([0, coordinates.length - 1]);
  simplifyRange(0, coordinates.length - 1, keep);

  return [...keep]
    .sort((a, b) => a - b)
    .map((index) => coordinates[index]);
}

/**
 * Reduces coordinates to a predictable count while preserving endpoints.
 * Useful for routing providers that limit the number of via points.
 */
export function downsampleCoordinates(
  coordinates: [number, number][],
  maxPoints = 45
): [number, number][] {
  if (coordinates.length <= maxPoints) return [...coordinates];
  if (maxPoints <= 2) return [coordinates[0], coordinates[coordinates.length - 1]];

  const result: [number, number][] = [coordinates[0]];
  const step = (coordinates.length - 1) / (maxPoints - 1);

  for (let index = 1; index < maxPoints - 1; index++) {
    result.push(coordinates[Math.round(index * step)]);
  }

  result.push(coordinates[coordinates.length - 1]);
  return result;
}
