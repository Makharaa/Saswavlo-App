import "server-only";

import simulatori1 from "../../data/imports/simulatori-gori-route-1.json";
import simulatori2 from "../../data/imports/simulatori-gori-route-2.json";
import simulatori3 from "../../data/imports/simulatori-gori-route-3.json";
import simulatori4 from "../../data/imports/simulatori-gori-route-4.json";
import { importRouteDraft } from "@/lib/repository";
import { validateRoute } from "@/utils/route-engine";
import type { ExamRoute, RouteDraft } from "@/types/domain";

import type { BundledRouteSource } from "@/lib/route-import-catalog";

const drafts: Record<BundledRouteSource, unknown> = {
  "simulatori-gori-route-1": simulatori1,
  "simulatori-gori-route-2": simulatori2,
  "simulatori-gori-route-3": simulatori3,
  "simulatori-gori-route-4": simulatori4,
};

export async function importBundledRoute(
  source: BundledRouteSource,
  editedBy: number
): Promise<{ route: ExamRoute; reused: boolean }> {
  if (!Object.hasOwn(drafts, source)) throw new Error("Unknown route import source");

  // JSON imports infer coordinate pairs as number[] rather than tuples.
  // The bundled-data tests verify each pair and its route anchor.
  const draft = structuredClone(drafts[source]) as unknown as RouteDraft;
  // The source supplies no speed limits or field verification. Keep those
  // omissions visible for review in Route Studio before publication.
  if (draft.isPublished || draft.fieldTestedAt || draft.speedZones.length) {
    throw new Error("Bundled route must be an unverified draft without speed zones");
  }
  const errors = validateRoute({ ...draft, version: 1 }).filter(
    (issue) => issue.level === "error" && issue.code !== "no-speed-zones"
  );
  if (errors.length) throw new Error(`Invalid bundled route: ${errors.map((issue) => issue.code).join(", ")}`);

  const result = await importRouteDraft(source, draft, editedBy);
  if (!result.route) throw new Error("Imported route could not be loaded");
  return { route: result.route, reused: result.reused };
}
