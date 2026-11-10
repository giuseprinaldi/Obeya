import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on the Python backend. Set OBEYA_API when it is not on port 8787.
export default defineConfig(({ mode }) => {
  const api = loadEnv(mode, ".", "OBEYA_").OBEYA_API ?? "http://localhost:8787";
  const proxy = { "/api": { target: api, changeOrigin: true } };
  return {
    base: "/",
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    build: { outDir: "dist", emptyOutDir: true },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
