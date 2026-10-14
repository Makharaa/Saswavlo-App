import { densifyRoute, haversineMeters, routeLengthMeters } from "./geo";

export type Coordinate = [number, number];
export type EditorGeometry = {
  waypoints: Coordinate[];
  coordinates: Coordinate[];
  waypointCoordinateIndices?: number[];
};
export type RouteLegOptions = { targetHint?: string };
export type RouteLegRouter = (
  endpoints: [Coordinate, Coordinate],
  options: RouteLegOptions
) => Promise<Coordinate[]>;

const point = ([lng, lat]: Coordinate) => ({ lng, lat });
const distance = (a: Coordinate, b: Coordinate) => haversineMeters(point(a), point(b));

export function validWaypointCoordinateIndices(geometry: EditorGeometry) {
  const { coordinates, waypoints, waypointCoordinateIndices: indices } = geometry;
  return Boolean(
    indices && indices.length === waypoints.length &&
    (indices.length === 0 ? coordinates.length === 0 :
      indices[0] === 0 && indices.at(-1) === coordinates.length - 1 &&
      indices.every((index, i) => Number.isInteger(index) && index >= 0 &&
        index < coordinates.length && (i === 0 || index > indices[i - 1]) &&
        distance(waypoints[i], coordinates[index]) <= 3))
  );
}

export function editorWaypoints(geometry: EditorGeometry): Coordinate[] {
  if (geometry.waypoints.length > 1 || (geometry.waypoints.length && geometry.coordinates.length <= 1)) return geometry.waypoints;
  if (geometry.coordinates.length <= 1) return geometry.coordinates;
  return [geometry.coordinates[0], geometry.coordinates.at(-1)!];
}

/** Bind anchors to the existing trace, without routing or simplifying it. */
export function prepareEditorGeometry(geometry: EditorGeometry): Required<EditorGeometry> {
  const coordinates = [...geometry.coordinates];
  if (!coordinates.length) return { coordinates: [], waypoints: [], waypointCoordinateIndices: [] };
  const waypoints = editorWaypoints(geometry);
  if (validWaypointCoordinateIndices({ ...geometry, waypoints })) {
    const indices = [...geometry.waypointCoordinateIndices!];
    return { coordinates, waypoints: indices.map((i) => coordinates[i]), waypointCoordinateIndices: indices };
  }

  // Older saves have no leg boundaries. OSRM waypoints and recorder samples
  // are geometry vertices; find them in travel order, including repeat visits.
  const indices: number[] = [];
  for (let i = 0; i < waypoints.length; i += 1) {
    const first = i === 0;
    const last = i === waypoints.length - 1;
    let bestIndex = first ? 0 : last ? coordinates.length - 1 : -1;
    let bestDistance = bestIndex >= 0 ? distance(waypoints[i], coordinates[bestIndex]) : Infinity;
    if (!first && !last) {
      const maxIndex = coordinates.length - (waypoints.length - i);
      for (let j = indices[i - 1] + 1; j <= maxIndex; j += 1) {
        const candidate = distance(waypoints[i], coordinates[j]);
        if (candidate < bestDistance - 0.01) {
          bestDistance = candidate;
          bestIndex = j;
        }
      }
    }
    if (bestIndex < 0 || bestDistance > 10 || (i > 0 && bestIndex <= indices[i - 1])) {
      throw new Error(`საყრდენი #${i + 1} არსებულ გზას არ ემთხვევა. გააუქმე აცდენილი მონაკვეთი და თავიდან მონიშნე.`);
    }
    indices.push(bestIndex);
  }
  return { coordinates, waypoints: indices.map((i) => coordinates[i]), waypointCoordinateIndices: indices };
}

export function pinRouteLeg(start: Coordinate, end: Coordinate, leg: Coordinate[]) {
  if (leg.length < 2 || leg.some((p) => !Array.isArray(p) || p.length !== 2 ||
    !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
    throw new Error("რუკამ არასწორი გზის მონაკვეთი დააბრუნა.");
  }
  if (distance(start, leg[0]) > 3 || distance(end, leg.at(-1)!) > 3) {
    throw new Error("ახალი მონაკვეთი არჩეულ გზას არ უერთდება. მონიშნე წერტილი სასურველ გზაზე უფრო ზუსტად.");
  }
  // Keep boundary vertices exact so repeated visits retain distinct indices.
  return [start, ...leg.slice(1, -1), end];
}

/** A longer route is a reviewable proposal, not evidence of an invalid turn. */
export function routeLegDetour(endpoints: [Coordinate, Coordinate], leg: Coordinate[]) {
  const directMeters = distance(...endpoints);
  const distanceMeters = routeLengthMeters(leg);
  return directMeters < 500 && distanceMeters > directMeters * 4 + 200
    ? { directMeters, distanceMeters } : null;
}

/** Explicit manual authoring follows the user's exact clicks, without OSRM. */
export const manualRouteLeg: RouteLegRouter = async (endpoints) => densifyRoute(endpoints, 8);

async function buildLeg(start: Coordinate, end: Coordinate, router: RouteLegRouter, targetHint?: string) {
  if (distance(start, end) < 2) throw new Error("ახალი საყრდენი წინა წერტილთან ძალიან ახლოსაა. მონიშნე უფრო წინ.");
  return pinRouteLeg(start, end, await router([start, end], { targetHint }));
}

export async function appendRouteWaypoint(
  geometry: EditorGeometry,
  target: Coordinate,
  router: RouteLegRouter,
  targetHint?: string
): Promise<Required<EditorGeometry>> {
  const prepared = prepareEditorGeometry(geometry);
  if (prepared.waypoints.length >= 500) throw new Error("მარშრუტზე საყრდენი წერტილების მაქსიმალური რაოდენობაა 500.");
  if (!prepared.coordinates.length) {
    return { waypoints: [target], coordinates: [target], waypointCoordinateIndices: [0] };
  }
  const start = prepared.coordinates.at(-1)!;
  const leg = await buildLeg(start, target, router, targetHint);
  const coordinates = [...prepared.coordinates, ...leg.slice(1)];
  if (coordinates.length > 20_000) throw new Error("მარშრუტი ძალიან დიდია. გაანაწილე რამდენიმე მარშრუტად.");
  return {
    coordinates,
    waypoints: [...prepared.waypoints, target],
    waypointCoordinateIndices: [...prepared.waypointCoordinateIndices, coordinates.length - 1],
  };
}

export async function moveRouteWaypoint(
  geometry: EditorGeometry,
  index: number,
  target: Coordinate,
  router: RouteLegRouter,
  targetHint?: string
): Promise<Required<EditorGeometry>> {
  const prepared = prepareEditorGeometry(geometry);
  const { coordinates: old, waypoints, waypointCoordinateIndices: indices } = prepared;
  if (!Number.isInteger(index) || index < 0 || index >= waypoints.length) throw new Error("საყრდენი წერტილი აღარ არსებობს.");
  if (waypoints.length === 1) return { coordinates: [target], waypoints: [target], waypointCoordinateIndices: [0] };

  const left = index > 0 ? indices[index - 1] : 0;
  const right = index < indices.length - 1 ? indices[index + 1] : old.length - 1;
  const prefix = index > 0 ? old.slice(0, left + 1) : [];
  const before = index > 0 ? await buildLeg(old[left], target, router, targetHint) : [target];
  const targetIndex = prefix.length ? prefix.length - 1 + before.length - 1 : 0;
  const throughTarget = prefix.length ? [...prefix, ...before.slice(1)] : before;
  const after = index < waypoints.length - 1 ? await buildLeg(target, old[right], router) : [target];
  const replacement = [...throughTarget, ...after.slice(1)];
  const coordinates = [...replacement, ...old.slice(right + 1)];
  if (coordinates.length > 20_000) throw new Error("მარშრუტი ძალიან დიდია. გაანაწილე რამდენიმე მარშრუტად.");
  const rightIndex = replacement.length - 1;
  return {
    coordinates,
    waypoints: waypoints.map((p, i) => i === index ? target : p),
    waypointCoordinateIndices: indices.map((oldIndex, i) =>
      i < index ? oldIndex : i === index ? targetIndex : rightIndex + oldIndex - right),
  };
}

export function removeLastRouteWaypoint(geometry: EditorGeometry): Required<EditorGeometry> {
  const prepared = prepareEditorGeometry(geometry);
  if (prepared.waypoints.length <= 2) throw new Error("მარშრუტზე მინიმუმ ორი საყრდენი წერტილი დატოვე.");
  const indices = prepared.waypointCoordinateIndices.slice(0, -1);
  return {
    coordinates: prepared.coordinates.slice(0, indices.at(-1)! + 1),
    waypoints: prepared.waypoints.slice(0, -1),
    waypointCoordinateIndices: indices,
  };
}

/** Serialize map edits; invalidation discards running and queued old results. */
export class RouteEditQueue {
  private epoch = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private onBusy: (busy: boolean) => void = () => {}) {}
  get busy() { return this.pending > 0; }

  invalidate() {
    this.epoch += 1;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.onBusy(false);
  }

  enqueue(edit: (isCurrent: () => boolean) => Promise<void>) {
    const epoch = this.epoch;
    this.pending += 1;
    this.onBusy(true);
    const job = this.tail.then(async () => {
      if (epoch === this.epoch) await edit(() => epoch === this.epoch);
    });
    this.tail = job.catch(() => {}).finally(() => {
      if (epoch === this.epoch) {
        this.pending -= 1;
        this.onBusy(this.busy);
      }
    });
    return job;
  }
}
