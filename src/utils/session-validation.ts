import { z } from "zod";
import { MAX_TRACE_POINTS } from "./driving-evaluator";

const eventSchema = z.object({
  type: z.enum([
    "speeding",
    "off_route",
    "wrong_direction",
    "checkpoint_missed",
    "checkpoint_uncertain",
    "checkpoint",
    "session_started",
    "session_finished",
    "position",
  ]),
  timestamp: z.number().int().positive(),
  lng: z.number().finite().min(-180).max(180).nullable().optional(),
  lat: z.number().finite().min(-90).max(90).nullable().optional(),
  value: z.number().finite().min(-1000).max(1000).nullable().optional(),
  limitValue: z.number().finite().min(0).max(300).nullable().optional(),
  checkpointIndex: z.number().int().min(0).max(500).nullable().optional(),
  note: z.string().max(1000).optional(),
});

const gpsSampleSchema = z.object({
  lng: z.number().finite().min(-180).max(180), lat: z.number().finite().min(-90).max(90),
  timestamp: z.number().int().positive(), accuracy: z.number().finite().min(0).max(100_000).nullable(),
  speedMps: z.number().finite().min(0).max(220 / 3.6).nullable(), heading: z.number().finite().min(0).lt(360).nullable(),
  speedSource: z.enum(["device", "derived", "unknown"]).optional(), headingSource: z.enum(["device", "derived", "unknown"]).optional(),
  speedConfidence: z.enum(["high", "low", "unknown"]).optional(), headingConfidence: z.enum(["high", "low", "unknown"]).optional(),
});
const rawSampleSchema = gpsSampleSchema.extend({ timestamp: z.number().finite().min(0), accuracy: z.number().finite().min(0).max(50_000_000).nullable(), speedMps: z.number().finite().min(0).max(10_000).nullable() });
const traceSchema = z.object({
  observedAt: z.number().int().positive(), raw: rawSampleSchema.nullable(), sample: gpsSampleSchema.nullable(),
  accepted: z.boolean(), visible: z.boolean(), reason: z.string().max(100).nullable().optional(), evaluationTime: z.number().int().positive().optional(),
});

export const sessionSchema = z
  .object({
    clientSessionId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/),
    routeId: z.number().int().positive().nullable(),
    routeVersion: z.number().int().positive().nullable().optional(),
    mode: z.enum(["real", "simulation"]),
    assistMode: z.enum(["practice", "exam"]),
    startedAt: z.number().int().positive(),
    finishedAt: z.number().int().positive(),
    durationSeconds: z.number().int().min(0).max(43_200),
    distanceMeters: z.number().finite().min(0).max(500_000),
    maxSpeedKmh: z.number().finite().min(0).max(250),
    speedingEvents: z.number().int().min(0).max(10_000),
    offRouteEvents: z.number().int().min(0).max(10_000),
    checkpointsCompleted: z.number().int().min(0).max(500),
    checkpointsTotal: z.number().int().min(0).max(500),
    events: z.array(eventSchema).max(10_000),
    trace: z.array(traceSchema).max(MAX_TRACE_POINTS).optional(),
    traceComplete: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.trace !== undefined && value.routeVersion == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routeVersion"], message: "GPS ჩანაწერისთვის მარშრუტის კონკრეტული ვერსია აუცილებელია." });
    if (value.routeId == null && value.routeVersion != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routeVersion"],
        message: "მარშრუტის ვერსია მარშრუტის ID-ის გარეშე ვერ შეინახება.",
      });
    }
    if (value.finishedAt < value.startedAt || value.finishedAt - value.startedAt > 43_200_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "სესიის დასრულების დრო დასაწყისზე ადრე ვერ იქნება.",
      });
    }

    if (value.checkpointsCompleted > value.checkpointsTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkpointsCompleted"],
        message: "შესრულებული checkpoint-ების რაოდენობა არასწორია.",
      });
    }

    let previousObserved = 0;
    let previousVirtual = 0;
    for (const point of value.trace ?? []) {
      if (point.observedAt < value.startedAt - 60_000 || point.observedAt > value.finishedAt + 60_000 || point.observedAt < previousObserved ||
          (value.mode === "real" && point.evaluationTime != null) ||
          (point.evaluationTime != null && (point.evaluationTime < value.startedAt - 1000 || point.evaluationTime > value.startedAt + 43_200_000 || point.evaluationTime < previousVirtual))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trace"], message: "GPS ჩანაწერის დრო ან რიგი არასწორია." }); break;
      }
      previousObserved = point.observedAt;
      if (point.evaluationTime != null) previousVirtual = point.evaluationTime;
    }
    const lowerBound = value.startedAt - 60_000;
    const upperBound = value.finishedAt + 60_000;
    if (
      value.events.some(
        (event) => event.timestamp < lowerBound || event.timestamp > upperBound
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["events"],
        message: "სესიის მოვლენებში არასწორი დრო დაფიქსირდა.",
      });
    }
  });

