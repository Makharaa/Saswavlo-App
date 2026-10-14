import "server-only";

import { readFileSync } from "fs";
import path from "path";
import { cityRouteEntry } from "@/lib/city-route-catalog";
import { importRouteDraft } from "@/lib/repository";
import { validateRoute } from "@/utils/route-engine";
import type { ExamRoute, RouteDraft } from "@/types/domain";

export async function importCityRoute(
  source: string,
  editedBy: number
): Promise<{ route: ExamRoute; reused: boolean }> {
  const entry = cityRouteEntry(source);
  if (!entry || entry.city === "გორი" || source.startsWith("simulatori-gori")) {
    throw new Error("Unknown city route");
  }

  const fileName = path.basename(entry.file);
  if (fileName !== entry.file || !fileName.endsWith(".json") || fileName.includes("gori")) {
    throw new Error("Unknown city route file");
  }

  const directory = path.resolve(process.cwd(), "data", "imports", "cities");
  const fullPath = path.resolve(directory, fileName);
  if (!fullPath.startsWith(`${directory}${path.sep}`)) {
    throw new Error("Unknown city route file");
  }

  const draft = JSON.parse(readFileSync(fullPath, "utf8")) as RouteDraft;
  if (
    draft.city === "გორი" ||
    draft.isPublished ||
    draft.fieldTestedAt ||
    draft.speedZones.length
  ) {
    throw new Error("City route must be an unpublished draft and must not replace Gori");
  }

  const errors = validateRoute({ ...draft, version: 1 }).filter(
    (issue) => issue.level === "error" && issue.code !== "no-speed-zones"
  );
  if (errors.length) {
    throw new Error(`Invalid city route: ${errors.map((issue) => issue.code).join(", ")}`);
  }

  const result = await importRouteDraft(entry.source, draft, editedBy);
  if (!result.route) throw new Error("Imported route could not be loaded");
  return { route: result.route, reused: result.reused };
}
