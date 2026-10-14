import type { LineLayerSpecification, Map, SymbolLayerSpecification } from "maplibre-gl";
import { NAVIGATION_STRIPE_OFFSET_PX } from "./navigation-route-offset";
import { createRouteDirectionImage, ROUTE_DIRECTION_IMAGE_ID } from "./route-direction-image";

/**
 * The editor preview and the driving map must use the exact same route paint.
 * This is a screen-space highlight of the right-hand side of travel, NOT the
 * geographic position of a particular traffic lane. Never offset coordinates.
 */
const STRIPE_PAINT = [
  { suffix: "halo", color: "#ffffff", width: 11, opacity: 0.98 },
  { suffix: "casing", color: "#3b2776", width: 8, opacity: 1 },
  { suffix: "line", color: "#8856f3", width: 5, opacity: 1 },
  { suffix: "inner-stripe", color: "#ffdc6a", width: 2, opacity: 1 },
] as const;

export function navigationRouteLineLayers(source: string, idPrefix: string): LineLayerSpecification[] {
  return STRIPE_PAINT.map(({ suffix, color, width, opacity }) => ({
    id: `${idPrefix}-${suffix}`,
    type: "line" as const,
    source,
    layout: { "line-cap": "round" as const, "line-join": "round" as const },
    paint: {
      "line-color": color,
      "line-width": width,
      "line-offset": NAVIGATION_STRIPE_OFFSET_PX,
      "line-opacity": opacity,
    },
  }));
}

export function navigationRouteArrowLayer(source: string, idPrefix: string): SymbolLayerSpecification {
  return {
    id: `${idPrefix}-direction-arrows`,
    type: "symbol",
    source,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 170,
      "icon-image": ROUTE_DIRECTION_IMAGE_ID,
      "icon-size": 0.8,
      // The route symbol image has a defined width. Match the stripe's
      // screen-space offset without changing the original route geometry.
      "icon-offset": [0, NAVIGATION_STRIPE_OFFSET_PX / 0.8],
      "icon-keep-upright": false,
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "viewport",
    },
  };
}

export function addNavigationRouteLayers(map: Map, source: string, idPrefix: string): void {
  for (const layer of navigationRouteLineLayers(source, idPrefix)) map.addLayer(layer);
  if (!map.hasImage(ROUTE_DIRECTION_IMAGE_ID)) {
    map.addImage(ROUTE_DIRECTION_IMAGE_ID, createRouteDirectionImage(), { pixelRatio: 2 });
  }
  map.addLayer(navigationRouteArrowLayer(source, idPrefix));
}
