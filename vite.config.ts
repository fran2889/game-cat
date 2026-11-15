import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.GAME_CAT_PORT ?? "4780";

export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure(proxy) {
          // The browser talks to Vite on 5173 and Vite forwards to the loopback server.
          // Drop the browser Origin so the API sees a same-origin request, exactly as it
          // would from the production shell. Requests without Origin are allowed by §4.8.
          proxy.on("proxyReq", (request) => {
            request.removeHeader("origin");
          });
        },
      },
    },
  },
});
