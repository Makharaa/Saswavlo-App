/**
 * MapLibre line-offset is a *screen-space* right-of-travel highlight. The
 * underlying GPS coordinate must stay unmodified for positioning/evaluation.
 * Apply an equivalent screen-space offset to the visual car marker only.
 */
export const NAVIGATION_STRIPE_OFFSET_PX = 7;

export type ProjectedPoint = { x: number; y: number };

export function markerScreenOffsetForStripe(
  route: ReadonlyArray<readonly [number, number]>,
  segmentIndex: number,
  project: (coordinate: readonly [number, number]) => ProjectedPoint,
  pixels = NAVIGATION_STRIPE_OFFSET_PX,
): [number, number] {
  if (route.length < 2 || !Number.isFinite(segmentIndex)) return [0, 0];
  const index = Math.max(0, Math.min(route.length - 2, Math.floor(segmentIndex)));
  // Degenerate duplicate points can occur in imported GPS traces.
  for (let skip = 0; skip < Math.min(route.length - 1, 8); skip += 1) {
    const i = Math.min(route.length - 2, index + skip);
    const from = project(route[i]);
    const to = project(route[i + 1]);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.01) {
      // A right-facing normal in screen coordinates. Recomputing on map move
      // keeps it correct as the camera rotates / changes zoom and pitch.
      const right = (-dy / length) * pixels;
      const down = (dx / length) * pixels;
      return [right === 0 ? 0 : right, down === 0 ? 0 : down];
    }
  }
  return [0, 0];
}
