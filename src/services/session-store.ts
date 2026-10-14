import type { DrivingSessionResult, RouteDraft } from "../types/domain";

export interface PendingSession {
  key: string;
  userId: number;
  queuedAt: number;
  result: DrivingSessionResult;
  routeSnapshot?: RouteDraft | null;
  status: "pending" | "auth_required" | "blocked";
  lastError?: string;
}
export interface SessionStore {
  list(): Promise<PendingSession[]>;
  put(item: PendingSession): Promise<void>;
  remove(key: string): Promise<void>;
}

let connection: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("ამ ბრაუზერში მოწყობილობაზე შენახვა მიუწვდომელია.")); return; }
    const request = indexedDB.open("driveexam-local-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("pending", { keyPath: "key" });
      request.result.createObjectStore("active", { keyPath: "key" });
    };
    request.onerror = () => reject(new Error("მოწყობილობაზე შენახვა ვერ გაიხსნა."));
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error("შენახვა სხვა გახსნილი ჩანართითაა დაკავებული. განაახლე ჩანართები.")); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  }).catch((error) => { connection = null; throw error; });
  return connection;
}
async function transaction<T>(store: "pending" | "active", mode: IDBTransactionMode, operation: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(new Error("მოწყობილობაზე შენახვა ვერ მოხერხდა. შესაძლოა თავისუფალი ადგილი არასაკმარისია."));
  });
}
export const browserSessionStore: SessionStore = {
  list: () => transaction("pending", "readonly", (store) => store.getAll()) as Promise<PendingSession[]>,
  put: async (item) => { await transaction("pending", "readwrite", (store) => store.put(item)); },
  remove: async (key) => { await transaction("pending", "readwrite", (store) => store.delete(key)); },
};

let activeWrites: Promise<unknown> = Promise.resolve();
export function saveActiveSnapshot(key: string, value: unknown): Promise<void> {
  const write = activeWrites.catch(() => undefined).then(async () => { await transaction("active", "readwrite", (store) => store.put({ key, value })); });
  activeWrites = write;
  return write;
}
export async function readActiveSnapshot<T>(key: string): Promise<T | null> {
  await activeWrites.catch(() => undefined);
  const record = await transaction<{ key: string; value: T } | undefined>("active", "readonly", (store) => store.get(key));
  return record?.value ?? null;
}
export function removeActiveSnapshot(key: string): Promise<void> {
  const write = activeWrites.catch(() => undefined).then(async () => { await transaction("active", "readwrite", (store) => store.delete(key)); });
  activeWrites = write;
  return write;
}
