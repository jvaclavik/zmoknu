import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Lokální obsluha serverless funkcí z /api (na Vercelu je řeší runtime
// automaticky). V devu je spustíme přes ssrLoadModule, ať fungují i na localhost.
const DEV_API_ROUTES = ["/api/precip-accum", "/api/chmi-alerts"];
const devApi = (): PluginOption => ({
  name: "dev-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const route = DEV_API_ROUTES.find((r) => req.url?.startsWith(r));
      if (!route) return next();
      server
        .ssrLoadModule(`${route}.ts`)
        .then((mod) => (mod as { default: Function }).default(req, res))
        .catch((e) => {
          res.statusCode = 500;
          res.end(String(e));
        });
    });
  },
});

// ČHMÚ opendata neposílá CORS hlavičky → obrázky radaru nejdou použít jako
// WebGL textura. Proxujeme je přes vlastní origin (na Vercelu to řeší rewrite
// ve vercel.json, lokálně tento dev proxy).
export default defineConfig({
  plugins: [
    devApi(),
    react(),
    VitePWA({
      // "prompt": nová verze se nenainstaluje potají – uživatel dostane nabídku
      // k aktualizaci (viz ReloadPrompt). Registraci řeší useRegisterSW hook.
      registerType: "prompt",
      injectRegister: false,
      // Logo v hlavičce (/logo.svg) i ikony musí být v precache, ať se appka
      // offline zobrazí i s logem, ne jen s rozbitým obrázkem.
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.png",
        "logo.svg",
        "pwa-192x192.png",
        "pwa-512x512.png",
      ],
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
        // Precache i statické assety (SVG/PNG loga, ikony), ať jsou dostupné
        // offline – ne jen JS/CSS/HTML.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        // Splash obrázky jsou jen iOS launch screeny (přes <link> v index.html),
        // appka je za běhu nenačítá → není třeba je mít v precache.
        globIgnores: ["**/splash/**"],
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
      "/chmi-sat": {
        target: "https://opendata.chmi.cz",
        changeOrigin: true,
        rewrite: (p) =>
          p.replace(/^\/chmi-sat/, "/meteorology/weather/satellite/geo"),
      },
    },
  },
});
