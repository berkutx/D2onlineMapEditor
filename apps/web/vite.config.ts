import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @d2/server (Fastify + socket.io) listens on :3000. In dev the Vite server
// proxies the API, the static asset atlases, and the socket.io transport to it
// so the browser app can use same-origin relative URLs everywhere.
//
// Use 127.0.0.1, NOT "localhost": the backend binds IPv4 (0.0.0.0) only, while
// "localhost" resolves to IPv6 ::1 first on Windows — the proxy would hit
// ::1:3000 (nothing listening) and return 500 (ECONNREFUSED) intermittently.
const SERVER_ORIGIN = "http://127.0.0.1:3000";

// In production the app is served under a base path (behind the Cloudflare Tunnel at
// https://d2mapeditor.online/map). Set VITE_BASE=/map/ at build time; dev stays at '/'.
// import.meta.env.BASE_URL then carries it, and api.ts / socket.ts derive every URL from it.
const BASE = process.env.VITE_BASE || "/";

export default defineConfig({
  base: BASE,
  plugins: [vue()],
  build: {
    // SPA JS/CSS go under /app/ so they never collide with the atlas mount at /assets/.
    assetsDir: "app",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/assets": { target: SERVER_ORIGIN, changeOrigin: true },
      "/socket.io": { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
