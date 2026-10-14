"use strict";

// Turns a GPS export into unpublished drafts for every city except Gori.
// The four tested Simulatori.ge Gori files in data/imports are never written.
const fs = require("node:fs");
const path = require("node:path");

const sourceFile = process.argv[2];
if (!sourceFile) throw new Error("Usage: node scripts/prepare-city-routes.cjs SOURCE.json");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "data", "imports", "cities");
const voice = {
  "simple-turns/turn-left-soon": ["simulatori-gori/turn-left-soon", "left", "მალე გთხოვთ მოუხვიოთ მარცხნივ"],
  "simple-turns/turn-right-soon": ["simulatori-gori/turn-right-soon", "right", "მალე გთხოვთ მოუხვიოთ მარჯვნივ"],
  "simple-turns/turn-left-300m": ["simulatori-gori/turn-left-300m", "left", "300 მეტრში მოუხვიეთ მარცხნივ"],
  "simple-turns/turn-right-300m": ["simulatori-gori/turn-right-300m", "right", "300 მეტრში მოუხვიეთ მარჯვნივ"],
  "simple-turns/turn-right-500m": ["simulatori-gori/turn-right-500m", "right", "500 მეტრში მოუხვიეთ მარჯვნივ"],
  "simple-turns/turn-left-500m": ["simulatori-gori/turn-left-500m", "left", "500 მეტრში მოუხვიეთ მარცხნივ"],
  "move-straight/straight": ["simulatori-gori/straight", "straight", "შემდეგ მინიშნებამდე იმოძრავეთ პირდაპირ"],
  "move-straight/straight-soon": ["simulatori-gori/straight-soon", "straight", "მალე იმოძრავეთ პირდაპირ"],
  "move-straight/straight-300m": ["simulatori-gori/straight-300m", "straight", "300 მეტრში იმოძრავეთ პირდაპირ"],
  "roundabouts/roundabout-straight-300m": ["simulatori-gori/roundabout-straight-300m", "straight", "300 მეტრში წრიულზე იმოძრავეთ პირდაპირ"],
  "roundabouts/roundabout-straight-500m": ["simulatori-gori/roundabout-straight-500m", "straight", "500 მეტრში წრიულზე იმოძრავეთ პირდაპირ"],
};

const R = Math.PI / 180;
function haversine(a, b) {
  const dLat = (a.lat - b.lat) * R;
  const dLng = (a.lng - b.lng) * R;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function cityParts(value) {
  const match = String(value ?? "").trim().match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { name: String(value ?? "").trim(), slug: "" };
  return {
    name: match[1].trim(),
    slug: match[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, ""),
  };
}

function isGori(parts) {
  return parts.name === "გორი" || parts.slug === "gori";
}

function describe(kind) {
  const distance = kind.endsWith("-500m") ? "500 მეტრში "
    : kind.endsWith("-300m") ? "300 მეტრში "
      : /-soon(?:-2)?$/.test(kind) ? "მალე "
        : "";
  const roundabout = kind.startsWith("roundabouts/");
  const cross = kind.startsWith("crossroads/");
  const where = roundabout ? "წრიულზე " : cross ? "გზაჯვარედინზე " : "";
  let type = "warning";
  let action = "გააგრძელეთ მოძრაობა";
  if (kind.includes("turn-around")) {
    type = "warning";
    action = "მოაბრუნეთ უკან";
  } else if (kind.includes("left-left")) {
    type = "left";
    action = `${where}მკვეთრად მოუხვიეთ მარცხნივ`;
  } else if (kind.includes("left-right")) {
    type = "left";
    action = `${where}მოუხვიეთ მარცხნივ, შემდეგ მარჯვნივ`;
  } else if (kind.includes("right-left")) {
    type = "right";
    action = `${where}მოუხვიეთ მარჯვნივ, შემდეგ მარცხნივ`;
  } else if (kind.includes("left-straight")) {
    type = "left";
    action = `${where}მოუხვიეთ მარცხნივ და გააგრძელეთ პირდაპირ`;
  } else if (kind.includes("right-straight")) {
    type = "right";
    action = `${where}მოუხვიეთ მარჯვნივ და გააგრძელეთ პირდაპირ`;
  } else if (kind.includes("straight")) {
    type = "straight";
    action = roundabout ? "წრიულზე იმოძრავეთ პირდაპირ" : "იმოძრავეთ პირდაპირ";
  } else if (kind.includes("left")) {
    type = "left";
    action = `${where}მოუხვიეთ მარცხნივ`;
  } else if (kind.includes("right")) {
    type = "right";
    action = `${where}მოუხვიეთ მარჯვნივ`;
  }
  return { type, title: `${distance}${action}`.replace(/\s+/g, " ").trim(), known: type !== "warning" || kind.includes("turn-around") };
}

function convert(raw) {
  if (!Array.isArray(raw.points) || raw.points.length < 2 || !Array.isArray(raw.events)) {
    throw new Error("Bad route");
  }
  const parts = cityParts(raw.city);
  if (!parts.name || !parts.slug || isGori(parts)) throw new Error("Gori or unnamed city");
  const original = raw.points.map((point) => [point.lng, point.lat]);
  if (original.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat) || lng < 40 || lng > 47 || lat < 41 || lat > 43.8)) {
    throw new Error("Coordinates are outside Georgia");
  }
  const cum = [0];
  for (let index = 1; index < original.length; index += 1) {
    cum.push(cum.at(-1) + haversine(raw.points[index - 1], raw.points[index]));
  }
  const total = cum.at(-1);
  if (!(total > 120)) throw new Error("Route is too short");
  const events = raw.events
    .filter((event) => event && event.kind && !String(event.kind).startsWith("system/") && Number.isFinite(event.distanceAlongRoute))
    .map((event, index) => ({ ...event, _originalOrder: index }))
    .sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute || a._originalOrder - b._originalOrder);
  for (const event of events) {
    event.distanceAlongRoute = Math.max(0, Math.min(total, event.distanceAlongRoute));
  }
  const points = [];
  const anchors = new Array(events.length);
  let at = 0;
  for (let index = 0; index < original.length - 1; index += 1) {
    points.push([...original[index]]);
    const lo = cum[index];
    const hi = cum[index + 1];
    while (at < events.length && events[at].distanceAlongRoute <= hi + 1e-6) {
      const span = hi - lo;
      const t = span <= 1e-8 ? 0 : Math.max(0, Math.min(1, (events[at].distanceAlongRoute - lo) / span));
      const anchor = [
        original[index][0] + (original[index + 1][0] - original[index][0]) * t,
        original[index][1] + (original[index + 1][1] - original[index][1]) * t,
      ];
      if (t <= 1e-8) anchors[at] = points.length - 1;
      else if (t >= 1 - 1e-8) anchors[at] = points.length;
      else {
        const last = points.at(-1);
        if (last && haversine({ lng: last[0], lat: last[1] }, { lng: anchor[0], lat: anchor[1] }) < 0.05) {
          anchors[at] = points.length - 1;
        } else {
          points.push(anchor);
          anchors[at] = points.length - 1;
        }
      }
      at += 1;
    }
  }
  points.push([...original.at(-1)]);
  if (at !== events.length) throw new Error("Events outside route");

  let maxOffset = 0;
  let snapped = 0;
  let unknown = 0;
  const checkpoints = events.map((event, index) => {
    const anchor = points[anchors[index]];
    const offset = haversine(event, { lng: anchor[0], lat: anchor[1] });
    maxOffset = Math.max(maxOffset, offset);
    const recorded = voice[event.kind];
    const spoken = recorded
      ? { type: recorded[1], title: recorded[2], voice: recorded[0] }
      : { ...describe(event.kind), voice: "" };
    if (!recorded && spoken.type === "warning" && !event.kind.includes("turn-around")) unknown += 1;
    const onRoute = offset <= 50 && Number.isFinite(event.lng) && Number.isFinite(event.lat);
    if (!onRoute) snapped += 1;
    return {
      orderIndex: index,
      lng: onRoute ? event.lng : anchor[0],
      lat: onRoute ? event.lat : anchor[1],
      routeCoordinateIndex: anchors[index],
      type: spoken.type,
      title: spoken.title.slice(0, 500),
      voice: spoken.voice,
      ttsVoice: "ka-GE-GiorgiNeural",
      speedLimit: null,
      triggerMeters: 30,
      evaluation: { instructionOnly: true },
    };
  });

  const name = String(raw.name ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!name) throw new Error("Missing name");
  const output = {
    name,
    city: parts.name,
    description: "შემოტანილი GPS მარშრუტი. ხმა უკრავს მხოლოდ იმ მინიშნებებს, რომლებსაც ჩანაწერი აქვს. გამოქვეყნებამდე შეამოწმე ავტომობილში და დაამატე სიჩქარის ზონები.",
    isPublished: false,
    fieldTestedAt: null,
    waypoints: points,
    waypointCoordinateIndices: points.map((_, index) => index),
    coordinates: points,
    speedZones: [],
    checkpoints,
  };
  return {
    output,
    parts,
    report: {
      source: `city-trace:${raw.id}`,
      name,
      city: parts.name,
      slug: parts.slug,
      sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : null,
      pointCount: points.length,
      instructionCount: checkpoints.length,
      voicedCount: checkpoints.filter((point) => point.voice).length,
      missingAudioCount: checkpoints.filter((point) => !point.voice).length,
      unknownKindCount: unknown,
      snappedCount: snapped,
      distanceKm: Math.round((total / 1000) * 100) / 100,
      maxOffsetMeters: Math.round(maxOffset * 10) / 10,
      omittedSystemCount: raw.events.length - events.length,
    },
  };
}

const all = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
if (!Array.isArray(all)) throw new Error("Expected an array");
const skippedGori = all.filter((route) => isGori(cityParts(route.city)));
if (skippedGori.length !== 4) throw new Error(`Expected to skip exactly 4 Gori routes, found ${skippedGori.length}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const counters = new Map();
const catalog = [];
const failures = [];
for (const raw of all) {
  const parts = cityParts(raw.city);
  if (isGori(parts)) continue;
  try {
    const { output, report } = convert(raw);
    if (output.city === "გორი" || JSON.stringify(output).includes("ownerPhone")) {
      throw new Error("Refusing to write a Gori route or owner data");
    }
    const sequence = (counters.get(report.slug) ?? 0) + 1;
    counters.set(report.slug, sequence);
    const file = `${report.slug}-${String(sequence).padStart(2, "0")}.json`;
    fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(output)}\n`);
    catalog.push({
      source: report.source,
      file,
      name: report.name,
      city: report.city,
      sortOrder: report.sortOrder,
      instructionCount: report.instructionCount,
      voicedCount: report.voicedCount,
      missingAudioCount: report.missingAudioCount,
      distanceKm: report.distanceKm,
    });
    console.log(`${file}  ${report.city}  ${report.instructionCount} cues  ${report.voicedCount} voiced  offset ${report.maxOffsetMeters}m`);
  } catch (error) {
    failures.push(`${raw.city} / ${raw.name}: ${error.message}`);
  }
}

catalog.sort((a, b) => a.city.localeCompare(b.city, "ka") || (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name, "ka"));
fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
if (failures.length) {
  console.error(failures.join("\n"));
  throw new Error(`${failures.length} routes failed`);
}
console.log(`Wrote ${catalog.length} routes, skipped ${skippedGori.length} Gori routes`);
