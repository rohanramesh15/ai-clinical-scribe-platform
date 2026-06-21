import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local dev: proxy /api to the FastAPI backend so the SPA runs same-origin,
// mirroring the nginx setup in production (nginx serves dist/ and proxies /api).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
