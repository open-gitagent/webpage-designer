import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8882", changeOrigin: true },
      "/preview": { target: "http://localhost:8882", changeOrigin: true },
      "/ws": { target: "ws://localhost:8882", ws: true },
      "/voice": { target: "ws://localhost:8882", ws: true },
    },
  },
});
