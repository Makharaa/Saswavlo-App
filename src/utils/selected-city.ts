export const SELECTED_CITY_STORAGE_KEY = "driveexam-selected-city";
export const CITY_CHANGED_EVENT = "driveexam-city-change";

const CITY_CENTERS: Record<string, [number, number]> = {
  "გორი": [44.11, 41.98],
  "ქუთაისი": [42.67, 42.25],
  "ბათუმი": [41.64, 41.64],
  "ფოთი": [41.67, 42.15],
  "რუსთავი": [45.0, 41.55],
  "თელავი": [45.47, 41.92],
  "ზუგდიდი": [41.87, 42.51],
  "ახალციხე": [42.98, 41.64],
  "ოზურგეთი": [41.99, 41.92],
  "საჩხერე": [43.4, 42.34],
};

export function selectedCityStorageKey(userId: number | null) {
  return userId != null && Number.isInteger(userId) && userId > 0
    ? `${SELECTED_CITY_STORAGE_KEY}:${userId}`
    : SELECTED_CITY_STORAGE_KEY;
}

export function resolveSelectedCity(available: readonly string[], stored: string | null) {
  const remembered = stored?.trim();
  if (remembered) return remembered;
  const cities = available.map((city) => city.trim()).filter(Boolean);
  if (cities.includes("გორი")) return "გორი";
  return cities[0] ?? "გორი";
}

export function cityCenter(city: string): [number, number] {
  return CITY_CENTERS[city] ?? CITY_CENTERS["გორი"];
}

export function readCurrentUserId() {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(window.localStorage.getItem("driveexam-current-user-id"));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function readSelectedCity(userId: number | null) {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(selectedCityStorageKey(userId))?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeSelectedCity(userId: number | null, city: string) {
  if (typeof window === "undefined") return;
  const clean = city.trim();
  if (!clean) return;
  try {
    window.localStorage.setItem(selectedCityStorageKey(userId), clean);
    window.dispatchEvent(new Event(CITY_CHANGED_EVENT));
  } catch {
    // The current view still changes when storage is unavailable.
  }
}
