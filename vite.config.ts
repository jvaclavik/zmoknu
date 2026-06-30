import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// ČHMÚ opendata neposílá CORS hlavičky → obrázky radaru nejdou použít jako
// WebGL textura. Proxujeme je přes vlastní origin (na Vercelu to řeší rewrite
// ve vercel.json, lokálně tento dev proxy).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Zmoknu? – počasí a radar",
        short_name: "Zmoknu?",
        description:
          "Přehledné počasí, předpověď až na 16 dní a radar srážek.",
        lang: "cs",
        theme_color: "#05080f",
        background_color: "#05080f",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Předpověď a radar necacheujeme natvrdo (jsou živé) – jen runtime cache
        // s krátkou platností, ať appka funguje i offline s posledními daty.
        runtimeCaching: [
          {
            urlPattern: /https:\/\/[^/]*open-meteo\.com\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "open-meteo",
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/chmi-radar": {
        target: "https://opendata.chmi.cz",
        changeOrigin: true,
        rewrite: (p) =>
          p.replace(
            /^\/chmi-radar/,
            "/meteorology/weather/radar/composite/maxz/png",
          ),
      },
    },
  },
});
