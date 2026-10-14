import type { DrivingSessionSummary } from "../types/domain";

export function sessionIssueCount(session: DrivingSessionSummary) {
  return session.speedingEvents + session.offRouteEvents + (session.evaluation?.wrongDirectionEvents ?? 0) + (session.evaluation?.missedCheckpoints ?? 0);
}
/** Comparisons are restricted to the same driver, route version and mode. */
export function drivingProgress(items: DrivingSessionSummary[]) {
  const groups = new Map<string, DrivingSessionSummary[]>();
  for (const item of items) {
    if (item.mode !== "real" || item.evaluation?.status !== "replayed" || item.checkpointsTotal <= 0) continue;
    const key = [item.userId, item.routeOriginId ?? item.routeId ?? item.routeName, item.routeVersion, item.assistMode, item.evaluation.version].join(":");
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, sessions]) => {
    sessions.sort((a, b) => a.finishedAt - b.finishedAt);
    const latest = sessions.at(-1)!;
    const previous = sessions.length > 1 ? sessions.at(-2)! : null;
    const completion = latest.checkpointsCompleted / latest.checkpointsTotal * 100;
    const previousCompletion = previous ? previous.checkpointsCompleted / previous.checkpointsTotal * 100 : null;
    return { key, latest, attempts: sessions.length, completion, completionChange: previousCompletion == null ? null : completion - previousCompletion,
      issuesPerKm: latest.distanceMeters >= 100 ? sessionIssueCount(latest) / (latest.distanceMeters / 1000) : null,
      previousIssuesPerKm: previous && previous.distanceMeters >= 100 ? sessionIssueCount(previous) / (previous.distanceMeters / 1000) : null };
  }).sort((a, b) => b.latest.finishedAt - a.latest.finishedAt);
}
