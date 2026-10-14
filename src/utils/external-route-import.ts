import type { GeoPoint, RouteCheckpoint, RouteDraft } from "../types/domain";
import { getRecordedCheckpointPrompt } from "../lib/recorded-voice-catalog";
import { haversineMeters, routeCumulativeDistances } from "./geo";

type Coordinate = [number, number];
type SourceInstructionType = "turn_left" | "turn_right" | "straight" | "roundabout";
type SourceMarker = {
  id: number;
  order_index: number;
  location: GeoPoint;
  type: SourceInstructionType;
  trigger_radius_m: number;
  lead_distance_m: number;
  speak_text_ka: string;
  speak_text_en: string;
  speak_text_ru: string;
};
type SourceRoute = {
  id: number;
  name: string;
  city: string;
  coordinates: Coordinate[];
  start: GeoPoint;
  finish: GeoPoint;
  markers: SourceMarker[];
};
type Projection = {
  segment: number;
  t: number;
  coordinate: Coordinate;
  distanceMeters: number;
  alongMeters: number;
};

export interface ExternalRouteImportReport {
  sourceId: number;
  sourceCoordinateCount: number;
  coordinateCount: number;
  insertedCoordinateCount: number;
  instructionCount: number;
  distanceMeters: number;
  maxSegmentMeters: number;
  maxMarkerOffsetMeters: number;
  startOffsetMeters: number;
  finishOffsetMeters: number;
  normalizedVoiceCount: number;
  normalizedInstructionTypeCount: number;
  warnings: string[];
  markers: {
    sourceId: number;
    sourceOrderIndex: number;
    sourceType: SourceInstructionType;
    importedType: RouteCheckpoint["type"];
    sourceLocation: GeoPoint;
    routeCoordinateIndex: number;
    distanceAlongMeters: number;
    offsetMeters: number;
  }[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}: მოსალოდნელია JSON ობიექტი.`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field}: საჭიროა რიცხვი ${min}–${max} დიაპაზონში.`);
  }
  return value;
}

function integer(value: unknown, field: string) {
  const result = number(value, field, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(result)) throw new Error(`${field}: საჭიროა მთელი რიცხვი.`);
  return result;
}

function text(value: unknown, field: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new Error(`${field}: არასწორი ტექსტი.`);
  }
  return value;
}

function point(value: unknown, field: string): GeoPoint {
  const record = object(value, field);
  return {
    lng: number(record.lng, `${field}.lng`, -180, 180),
    lat: number(record.lat, `${field}.lat`, -90, 90),
  };
}

function readSource(value: unknown): SourceRoute {
  const source = object(value, "მარშრუტი");
  const path = object(source.path, "path");
  if (path.type !== "LineString" || !Array.isArray(path.coordinates) ||
      path.coordinates.length < 2 || path.coordinates.length > 20_000) {
    throw new Error("path: საჭიროა LineString, 2–20 000 კოორდინატით.");
  }
  const coordinates = path.coordinates.map((coordinate, index): Coordinate => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      throw new Error(`path.coordinates[${index}]: საჭიროა [longitude, latitude].`);
    }
    return [number(coordinate[0], `longitude #${index}`, -180, 180),
      number(coordinate[1], `latitude #${index}`, -90, 90)];
  });
  if (!Array.isArray(source.points) || source.points.length < 1 || source.points.length > 300) {
    throw new Error("points: საჭიროა 1–300 ინსტრუქციის ნიშნული.");
  }
  // Bound the projection work as well as the output size for large sources.
  if (source.points.length * (coordinates.length - 1) > 2_000_000) {
    throw new Error("მარშრუტი ერთჯერადი იმპორტისთვის ძალიან რთულია. დაყავი რამდენიმე მარშრუტად.");
  }
  const markers = source.points.map((value, index): SourceMarker => {
    const marker = object(value, `points[${index}]`);
    const type = marker.type;
    if (type !== "turn_left" && type !== "turn_right" && type !== "straight" && type !== "roundabout") {
      throw new Error(`points[${index}].type: უცნობი ინსტრუქციის ტიპი.`);
    }
    const triggerRadius = number(marker.trigger_radius_m, `points[${index}].trigger_radius_m`, 10, 1000);
    if (!Number.isInteger(triggerRadius)) throw new Error(`points[${index}].trigger_radius_m: საჭიროა მთელი რიცხვი.`);
    return {
      id: integer(marker.id, `points[${index}].id`),
      order_index: integer(marker.order_index, `points[${index}].order_index`),
      location: point(marker.location, `points[${index}].location`),
      type,
      trigger_radius_m: triggerRadius,
      lead_distance_m: number(marker.lead_distance_m, `points[${index}].lead_distance_m`, 0, 10_000),
      speak_text_ka: text(marker.speak_text_ka, `points[${index}].speak_text_ka`, 500),
      speak_text_en: text(marker.speak_text_en, `points[${index}].speak_text_en`, 1000, true),
      speak_text_ru: text(marker.speak_text_ru, `points[${index}].speak_text_ru`, 1000, true),
    };
  }).sort((a, b) => a.order_index - b.order_index);
  if (new Set(markers.map((marker) => marker.id)).size !== markers.length ||
      new Set(markers.map((marker) => marker.order_index)).size !== markers.length) {
    throw new Error("ინსტრუქციის ID და order_index უნიკალური უნდა იყოს.");
  }
  return {
    id: integer(source.id, "id"),
    name: text(source.name, "name", 180).trim(),
    city: text(source.city, "city", 120).trim(),
    coordinates,
    start: point(source.start, "start"),
    finish: point(source.finish, "finish"),
    markers,
  };
}

/** Normalizations select existing recordings; the display text stays original. */
export function externalInstructionVoice(phrase: string) {
  return phrase.trim()
    .replace(/^მალე\s+/, "")
    .replace(/^სამას\s+/, "300 ")
    .replace(/^ხუთას\s+/, "500 ")
    .replace(/წრიულ მოძრაობისას/g, "წრიული მოძრაობისას")
    .replace(/\s+/g, " ")
    .replace(/^300 მეტრში გთხოვთ იმოძრავეთ პირდაპირ$/, "300 მეტრში გთხოვთ იმოძრაოთ პირდაპირ")
    .replace(/^შემდეგ მინიშნებამდე გთხოვთ იმოძრაოთ პირდაპირ$/, "შემდეგ მინიშნებამდე იმოძრავეთ პირდაპირ");
}

function candidates(marker: GeoPoint, coordinates: Coordinate[], cumulative: number[]): Projection[] {
  const result: Projection[] = [];
  const scaleX = 111_320 * Math.max(0.01, Math.cos(marker.lat * Math.PI / 180));
  const scaleY = 110_540;
  for (let segment = 0; segment < coordinates.length - 1; segment += 1) {
    const a = coordinates[segment];
    const b = coordinates[segment + 1];
    const dx = (b[0] - a[0]) * scaleX;
    const dy = (b[1] - a[1]) * scaleY;
    const lengthSquared = dx * dx + dy * dy;
    const projectedT = lengthSquared < 0.000001 ? 0 : Math.max(0, Math.min(1,
      ((marker.lng - a[0]) * scaleX * dx + (marker.lat - a[1]) * scaleY * dy) / lengthSquared));
    // Endpoints make a monotonic solution available even when neighboring
    // markers project in reverse order within a single sparse source segment.
    for (const t of [0, projectedT, 1]) {
      const coordinate: Coordinate = t === 0 ? [...a] : t === 1 ? [...b] :
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      result.push({ segment, t, coordinate,
        distanceMeters: haversineMeters(marker, { lng: coordinate[0], lat: coordinate[1] }),
        alongMeters: cumulative[segment] + (cumulative[segment + 1] - cumulative[segment]) * t });
    }
  }
  return result;
}

/**
 * Minimize total marker offsets in travel order across the entire route. A
 * greedy nearest lookup can attach the first warning to the final road visit
 * and leave every subsequent warning behind it.
 */
function projectInTravelOrder(markers: SourceMarker[], coordinates: Coordinate[], cumulative: number[]) {
  let previous: Projection[] = [];
  let previousCosts = new Float64Array();
  const parents: Int32Array[] = [];
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const current = candidates(markers[markerIndex].location, coordinates, cumulative);
    const costs = new Float64Array(current.length).fill(Infinity);
    const parent = new Int32Array(current.length).fill(-1);
    let cursor = 0;
    let bestIndex = -1;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current[index];
      if (markerIndex === 0) {
        costs[index] = candidate.distanceMeters ** 2;
        continue;
      }
      while (cursor < previous.length && previous[cursor].alongMeters <= candidate.alongMeters + 1e-7) {
        if (bestIndex < 0 || previousCosts[cursor] < previousCosts[bestIndex]) bestIndex = cursor;
        cursor += 1;
      }
      if (bestIndex >= 0) {
        costs[index] = previousCosts[bestIndex] + candidate.distanceMeters ** 2;
        parent[index] = bestIndex;
      }
    }
    previous = current;
    previousCosts = costs;
    parents.push(parent);
  }
  let best = 0;
  for (let i = 1; i < previousCosts.length; i += 1) {
    if (previousCosts[i] < previousCosts[best]) best = i;
  }
  if (!Number.isFinite(previousCosts[best])) throw new Error("ინსტრუქციები გზას თანმიმდევრობით ვერ მიება.");
  const projections: Projection[] = new Array(markers.length);
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    projections[i] = candidates(markers[i].location, coordinates, cumulative)[best];
    best = parents[i][best];
  }
  return projections;
}

function insertAnchors(original: Coordinate[], projections: Projection[]) {
  const coordinates: Coordinate[] = [[...original[0]]];
  const indexes: number[] = new Array(projections.length);
  const groups = new Map<number, { markerIndex: number; projection: Projection }[]>();
  projections.forEach((projection, markerIndex) => {
    const group = groups.get(projection.segment) ?? [];
    group.push({ markerIndex, projection });
    groups.set(projection.segment, group);
  });
  for (let segment = 0; segment < original.length - 1; segment += 1) {
    const anchors = (groups.get(segment) ?? []).sort((a, b) => a.projection.t - b.projection.t);
    for (const { markerIndex, projection } of anchors) {
      if (projection.t <= 1e-10) indexes[markerIndex] = coordinates.length - 1;
      else if (projection.t < 1 - 1e-10) {
        // Consecutive source warnings at the same position share one anchor.
        const last = coordinates.at(-1)!;
        if (last[0] !== projection.coordinate[0] || last[1] !== projection.coordinate[1]) {
          coordinates.push([...projection.coordinate]);
        }
        indexes[markerIndex] = coordinates.length - 1;
      }
    }
    coordinates.push([...original[segment + 1]]);
    for (const { markerIndex, projection } of anchors) {
      if (projection.t >= 1 - 1e-10) indexes[markerIndex] = coordinates.length - 1;
    }
  }
  if (coordinates.length > 20_000) throw new Error("იმპორტირებულ გზაზე 20 000-ზე მეტი კოორდინატია.");
  return { coordinates, indexes };
}

/** Convert one external JSON route into an unpublished, reviewable draft. */
export function convertExternalRoute(
  value: unknown,
  metadata?: { city?: string; name?: string }
): { draft: RouteDraft; report: ExternalRouteImportReport } {
  // Explicit, reviewed metadata can fill omissions without altering the
  // archived source or any geometry/instruction fields.
  const source = readSource(metadata ? { ...object(value, "მარშრუტი"), ...metadata } : value);
  const cumulative = routeCumulativeDistances(source.coordinates);
  const distanceMeters = cumulative.at(-1)!;
  if (distanceMeters < 1) throw new Error("გზის კოორდინატები რეალურ მონაკვეთს არ ქმნის.");
  const projections = projectInTravelOrder(source.markers, source.coordinates, cumulative);
  const { coordinates, indexes } = insertAnchors(source.coordinates, projections);
  const warnings = [
    "სიჩქარის შეზღუდვები წყაროში არ არის. გამოქვეყნებამდე დაამატე გადამოწმებული სიჩქარის ზონები.",
    "ეს ნიშნულები მხოლოდ ხმოვანი ინსტრუქციებია; მოსახვევის შესრულება მათთან არ ფასდება.",
    "მარშრუტი ავტომობილში ჯერ არ არის შემოწმებული.",
  ];
  let normalizedVoiceCount = 0;
  let normalizedInstructionTypeCount = 0;
  const checkpoints = source.markers.map((marker, index): RouteCheckpoint => {
    const voice = externalInstructionVoice(marker.speak_text_ka);
    if (voice !== marker.speak_text_ka) normalizedVoiceCount += 1;
    const prompt = getRecordedCheckpointPrompt(voice);
    if (!prompt) {
      warnings.push(`ინსტრუქცია #${index + 1}: ტექსტისთვის ჩაწერილი აუდიო ვერ მოიძებნა.`);
    }
    const sourceType = marker.type === "turn_left" ? "left" : marker.type === "turn_right" ? "right" : "straight";
    const type = prompt?.suggestedType ?? sourceType;
    if (type !== sourceType) {
      normalizedInstructionTypeCount += 1;
      warnings.push(`ინსტრუქცია #${index + 1}: წყაროს ტიპი ტექსტს არ ემთხვევა; მიმართულება ქართული მითითების მიხედვით გასწორდა.`);
    }
    const [lng, lat] = coordinates[indexes[index]];
    return {
      orderIndex: index,
      lng,
      lat,
      routeCoordinateIndex: indexes[index],
      type,
      title: marker.speak_text_ka,
      voice,
      ttsVoice: "ka-GE-GiorgiNeural",
      speedLimit: null,
      // The source location is already the advance-warning location. Applying
      // lead_distance_m again would announce the instruction twice as early.
      triggerMeters: marker.trigger_radius_m,
      evaluation: { instructionOnly: true },
    };
  });
  const maxSegmentMeters = Math.max(...cumulative.slice(1).map((d, index) => d - cumulative[index]));
  const maxMarkerOffsetMeters = Math.max(...projections.map((p) => p.distanceMeters));
  const startOffsetMeters = haversineMeters(source.start, { lng: coordinates[0][0], lat: coordinates[0][1] });
  const last = coordinates.at(-1)!;
  const finishOffsetMeters = haversineMeters(source.finish, { lng: last[0], lat: last[1] });
  if (maxSegmentMeters > 100) warnings.push(`გზაზე კოორდინატებს შორის დაშორება ${Math.round(maxSegmentMeters)} მეტრამდეა. გადაამოწმე მონაკვეთები რუკაზე.`);
  if (maxMarkerOffsetMeters > 10) warnings.push(`ზოგი ინსტრუქციის ნიშნული გზიდან ${Math.round(maxMarkerOffsetMeters)} მეტრითაა დაშორებული. გადაამოწმე მიბმა.`);
  if (startOffsetMeters > 10 || finishOffsetMeters > 10) {
    warnings.push(`წყაროს დაწყება/ფინიში გზის ბოლოებს ${Math.round(startOffsetMeters)}/${Math.round(finishOffsetMeters)} მეტრით სცდება. შენარჩუნებულია წყაროს გზა.`);
  }
  const waypoints = coordinates.length <= 500 ? coordinates.map((c): Coordinate => [...c]) : [[...coordinates[0]], [...last]] as Coordinate[];
  const waypointCoordinateIndices = coordinates.length <= 500 ? coordinates.map((_, index) => index) : [0, coordinates.length - 1];
  return {
    draft: {
      name: source.name,
      city: source.city,
      description: `გარე JSON-დან შემოტანილი მარშრუტი (წყაროს ID: ${source.id}). ${source.markers.length} ხმოვანი ინსტრუქციის ნიშნული. სიჩქარის ზონები და გზა შესამოწმებელია.`,
      isPublished: false,
      fieldTestedAt: null,
      waypoints,
      waypointCoordinateIndices,
      coordinates,
      speedZones: [],
      checkpoints,
    },
    report: {
      sourceId: source.id,
      sourceCoordinateCount: source.coordinates.length,
      coordinateCount: coordinates.length,
      insertedCoordinateCount: coordinates.length - source.coordinates.length,
      instructionCount: source.markers.length,
      distanceMeters,
      maxSegmentMeters,
      maxMarkerOffsetMeters,
      startOffsetMeters,
      finishOffsetMeters,
      normalizedVoiceCount,
      normalizedInstructionTypeCount,
      warnings,
      markers: source.markers.map((marker, index) => ({
        sourceId: marker.id,
        sourceOrderIndex: marker.order_index,
        sourceType: marker.type,
        importedType: checkpoints[index].type,
        sourceLocation: { ...marker.location },
        routeCoordinateIndex: indexes[index],
        distanceAlongMeters: projections[index].alongMeters,
        offsetMeters: projections[index].distanceMeters,
      })),
    },
  };
}
