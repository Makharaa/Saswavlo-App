export const ROUTE_DIRECTION_IMAGE_ID = "driveexam-route-direction";

/** A right-facing RGBA arrow with its own blue outline; no remote glyphs. */
export function createRouteDirectionImage() {
  const width = 40;
  const height = 32;
  const data = new Uint8Array(width * height * 4);
  const inside = (x: number, y: number, tail: number, tip: number, notch: number, halfHeight: number) => {
    const fraction = Math.abs(y - height / 2) / halfHeight;
    return fraction <= 1 && x >= notch + (tail - notch) * fraction && x <= tip + (tail - tip) * fraction;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let outer = 0;
      let inner = 0;
      // Four samples per axis keep the small arrow's diagonal edges smooth.
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          if (inside(px, py, 4, 36, 12, 14)) outer++;
          if (inside(px, py, 8, 31, 15, 9)) inner++;
        }
      }
      if (!outer) continue;
      const offset = (y * width + x) * 4;
      const white = inner / outer;
      data[offset] = Math.round(32 + 223 * white);
      data[offset + 1] = Math.round(54 + 201 * white);
      data[offset + 2] = Math.round(184 + 71 * white);
      data[offset + 3] = Math.round(255 * outer / 16);
    }
  }
  return { width, height, data };
}
