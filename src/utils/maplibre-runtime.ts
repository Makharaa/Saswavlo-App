import { getVersion, setWorkerUrl } from "maplibre-gl";

/** Keep the module worker out of Next.js chunk URL inference. */
export function configureMapLibreWorker() {
  setWorkerUrl(`/api/map/worker?v=${encodeURIComponent(getVersion())}`);
}
