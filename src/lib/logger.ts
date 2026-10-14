import { APP_RELEASE } from "./app-info";

/** Error identity is useful in logs; request bodies and connection strings are not. */
export function logOperationError(operation: string, error: unknown) {
  const code = error != null && typeof error === "object" && "code" in error ? String(error.code) : "";
  console.error("[DriveExam]", { release: APP_RELEASE, operation,
    error: error instanceof Error ? error.name : "UnknownError", ...( /^[A-Z0-9]{5}$/.test(code) ? { code } : {}) });
}
