import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4180,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4100",
      "/public": "http://127.0.0.1:4100",
      "/health": "http://127.0.0.1:4100",
    },
  },
});
