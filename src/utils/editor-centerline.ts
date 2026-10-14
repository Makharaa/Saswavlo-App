import type { LineLayerSpecification, Map } from "maplibre-gl";

// This is an editor-only overlay of the ORIGINAL geographic path. It must
// never be applied to GPS positions or persisted into route coordinates.
export const EDITOR_CENTERLINE_LAYER_IDS = [
  "studio-route-edit-centerline-halo",
  "studio-route-edit-centerline",
] as const;

export function editorCenterlineLayers(source: string, visible: boolean): LineLayerSpecification[] {
  const layout = {
    "line-cap": "round" as const,
    "line-join": "round" as const,
    visibility: visible ? "visible" as const : "none" as const,
  };
  return [
    {
      id: EDITOR_CENTERLINE_LAYER_IDS[0],
      type: "line",
      source,
      layout,
      paint: {
        "line-color": "#082f49",
        "line-width": 8,
        "line-opacity": 0.94,
      },
    },
    {
      id: EDITOR_CENTERLINE_LAYER_IDS[1],
      type: "line",
      source,
      layout,
      paint: {
        "line-color": "#35fff3",
        "line-width": 4.5,
        "line-dasharray": [2, 1.5],
        "line-opacity": 1,
      },
    },
  ];
}

/** Returns false while the map style is still loading. The on-load layer
 * creation always uses the latest React toggle state, so early clicks stick. */
export function setEditorCenterlineVisibility(
  map: Pick<Map, "getLayer" | "setLayoutProperty"> | null,
  visible: boolean,
): boolean {
  if (!map || EDITOR_CENTERLINE_LAYER_IDS.some((id) => !map.getLayer(id))) return false;
  for (const id of EDITOR_CENTERLINE_LAYER_IDS) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
  return true;
}
