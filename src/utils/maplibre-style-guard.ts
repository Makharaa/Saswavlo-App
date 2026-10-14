import type { Map } from "maplibre-gl";
import { prepareNavigationMapStyle } from "./navigation-map-clarity";

/**
 * OpenFreeMap styles occasionally reference optional sprite images that are
 * missing from the published sprite sheet. In MapLibre 6, styleimagemissing is
 * a notification after the current image request has failed. The resolver
 * supplies optional placeholders before that request finishes; existing sprite
 * images are left intact.
 */
export function installMissingStyleImageFallback(map: Map) {
  let active = true;
  map.setMissingStyleImageResolver((id) => {
    if (!active || !id || map.hasImage(id)) return;

    try {
      map.addImage(id, {
        width: 1,
        height: 1,
        data: new Uint8Array([0, 0, 0, 0]),
      });
    } catch {
      // The map or its style may have been removed during a pending request.
    }
  });

  return () => {
    active = false;
    map.setMissingStyleImageResolver(null);
  };
}

/** Call on a map constructed without a style, before its first style loads. */
export function installNavigationMapStyle(map: Map, styleUrl: string) {
  const dispose = installMissingStyleImageFallback(map);
  map.setStyle(styleUrl, {
    transformStyle: (_previous, next) => prepareNavigationMapStyle(next),
  });
  return dispose;
}
