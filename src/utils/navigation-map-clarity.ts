import type { FilterSpecification, StyleSpecification } from "maplibre-gl";

const ROAD_SHIELD_LAYERS = new Set([
  "highway-shield-non-us",
  "highway-shield-us-interstate",
  "road_shield_us",
]);

function readsReferenceLength(expression: unknown): boolean {
  if (!Array.isArray(expression) || expression[0] === "literal") return false;
  if (expression[0] === "get" && expression[1] === "ref_length") return true;
  return expression.some(readsReferenceLength);
}

/**
 * Keeps the OpenFreeMap basemap, but removes visual noise that is not useful
 * while following / editing a fixed driving-exam route.
 *
 * We intentionally keep road + place labels, while hiding 3D buildings and
 * most POI/transit icon layers. This makes the route geometry the strongest
 * element on the map without changing providers.
 */
export function prepareNavigationMapStyle(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((layer) => {
    const id = layer.id.toLowerCase();

    if (layer.type === "fill-extrusion") {
      return { ...layer, layout: { ...layer.layout, visibility: "none" as const } };
    }

    if (
      layer.type === "symbol" &&
      /(poi|amenity|shop|tourism|transit|bus|airport|aeroway|railway.*station|station.*railway)/i.test(id)
    ) {
      return { ...layer, layout: { ...layer.layout, visibility: "none" as const } };
    }

    if (layer.type === "fill" && /building/i.test(id)) {
      return { ...layer, paint: { ...layer.paint, "fill-opacity": 0.22 } };
    }

    if (layer.type === "line" && /(boundary|admin)/i.test(id)) {
      return { ...layer, paint: { ...layer.paint, "line-opacity": 0.22 } };
    }

    if (layer.type === "symbol" && ROAD_SHIELD_LAYERS.has(id) && readsReferenceLength(layer.filter)) {
      // Some transportation_name features have no numeric ref_length. A case
      // guard avoids evaluating the original numeric comparison for them;
      // defaulting null to zero would instead create invalid road_0 shields.
      const filter = [
        "case",
        ["==", ["typeof", ["get", "ref_length"]], "number"],
        layer.filter,
        false,
      ] as FilterSpecification;
      return { ...layer, filter };
    }

    return layer;
  });

  // Transform before workers receive the style, rather than after map load.
  return { ...style, layers };
}
