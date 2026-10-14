import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __driveExamPool: Pool | undefined;
}

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not configured.");
}

export const pool =
  global.__driveExamPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

if (process.env.NODE_ENV !== "production") {
  global.__driveExamPool = pool;
}
