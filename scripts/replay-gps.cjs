#!/usr/bin/env node
const fs = require("node:fs");
const { compileDrivingRoute, replayDrivingTrace } = require("../.test-build/utils/driving-evaluator.js");
const file = process.argv[2];
if (!file) { console.error("Usage: npm run replay:gps -- path/to/DriveExam-session.json"); process.exit(1); }
try {
  const input = JSON.parse(fs.readFileSync(file, "utf8"));
  const route = input.route ?? input.session?.routeSnapshot;
  const trace = input.trace ?? input.session?.trace;
  const mode = input.mode ?? input.session?.mode ?? "real";
  if (!route?.coordinates?.length || !Array.isArray(trace)) throw new Error("The export must include a route snapshot and GPS trace.");
  const result = replayDrivingTrace(compileDrivingRoute(route), trace, mode, input.session?.traceComplete !== false);
  console.log(JSON.stringify({ evaluation: result.evaluation, checkpointsCompleted: result.state.completed.length,
    checkpointsTotal: route.checkpoints.length, distanceMeters: Math.round(result.state.distanceMeters),
    speedingEvents: result.events.filter((event) => event.type === "speeding").length,
    offRouteEvents: result.events.filter((event) => event.type === "off_route").length }, null, 2));
} catch (error) { console.error(error.message); process.exit(1); }
