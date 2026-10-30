import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // The browser talks only to Vite; Vite forwards /api to the Node server.
    proxy: {
      "/api": "http://127.0.0.1:4000",
    },
  },
});
