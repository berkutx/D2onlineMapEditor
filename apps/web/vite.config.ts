import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @d2/server (Fastify + socket.io) listens on :3000. In dev the Vite server
// proxies the API, the static asset atlases, and the socket.io transport to it
// so the browser app can use same-origin relative URLs everywhere.
const SERVER_ORIGIN = "http://localhost:3000";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/assets": { target: SERVER_ORIGIN, changeOrigin: true },
      "/socket.io": { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
