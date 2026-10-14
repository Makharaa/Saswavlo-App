import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), payment=()" },
      ],
    }];
  },
  outputFileTracingIncludes: {
    "/api/map/worker": ["./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"],
    "/api/tts": ["./data/private/audio/recorded/**/*"],
    "/api/routes/import": ["./data/imports/cities/**/*"],
  },
};

export default nextConfig;
