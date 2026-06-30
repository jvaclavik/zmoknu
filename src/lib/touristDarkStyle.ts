// Noční varianta turistické mapy – ztmaví podkladové plochy (země, les, voda,
// budovy) do nízkokontrastních tónů, popisky zesvětlí s tmavým lemem a zjemní
// reliéf. Barevné silnice a značení KČT zůstávají, aby byly čitelné.
//
// Portováno z openclimbing.org (touristDarkStyle.ts). Aplikuje se NAD už
// otintěný turistický styl (applyTouristTint).

type Paint = Record<string, unknown>;
type AnyLayer = {
  id: string;
  type?: string;
  paint?: Paint;
  [key: string]: unknown;
};
type AnyStyle = { layers: AnyLayer[]; [key: string]: unknown };

const DARK = {
  text: "rgba(214, 212, 203, 1)",
  halo: "rgba(10, 12, 9, 0.9)",
};

const PAINT_OVERRIDES: Record<string, Paint> = {
  background: { "background-color": "#1b1d17" },

  // Vegetace – aby lesy/zeleň čitelně vystoupily na tmavém podkladu
  landcover_wood: { "fill-color": "#324a2c", "fill-opacity": 1 },
  landcover_grass: { "fill-color": "#36482c", "fill-opacity": 0.6 },
  globallandcover_grass: { "fill-color": "#33482a" },
  globallandcover_scrub: { "fill-color": "#3a4a2d" },
  globallandcover_tree: { "fill-color": "#324a2c" },
  globallandcover_forest: { "fill-color": "#324a2c" },
  landcover_ice: { "fill-color": "#4a515b" },
  globallandcover_ice: { "fill-color": "#4a515b" },

  // Zástavba / průmysl / budovy
  landuse_residential: {
    "fill-color": "#3c3525",
    "fill-opacity": {
      stops: [
        [7, 0.95],
        [12, 0.9],
        [16, 0.75],
      ],
    },
  },
  landuse_industrial: { "fill-color": "#34322c", "fill-opacity": 0.9 },
  building: { "fill-color": "#473f2d" },
  "building-top": {
    "fill-color": "#473f2d",
    "fill-outline-color": "#5e553f",
  },
  "building-3d": { "fill-extrusion-color": "#3e3829" },

  // Voda – čitelná modrá
  water: { "fill-color": "#234b78" },
  water_intermittent: { "fill-color": "#234b78" },
  waterway_river: { "line-color": "#356394" },
  waterway_other: { "line-color": "#356394" },

  // Reliéf – výraznější, ať je terén cítit
  hillshade: {
    "hillshade-accent-color": "rgba(0, 0, 0, 0.4)",
    "hillshade-exaggeration": {
      stops: [
        [5, 0.4],
        [9, 0.6],
        [13, 0.8],
        [16, 0.85],
      ],
    },
    "hillshade-shadow-color": "rgba(0, 0, 0, 0.72)",
    "hillshade-highlight-color": "rgba(175, 185, 168, 0.28)",
  },

  // Vrstevnice – výraznější teplá hnědá
  contour_index: { "line-color": "rgba(150, 122, 78, 0.85)" },
  contour: { "line-color": "rgba(150, 122, 78, 0.6)" },
  contour_label: { "text-color": "rgba(186, 164, 120, 0.95)" },

  // Pěšiny – světlejší, ať vystoupí na tmavém podkladu
  road_path: { "line-color": "#b6aa8a" },

  // Značení KČT – rozsvícené pro noční čitelnost
  trail_red: { "line-color": "#e8453d" },
  trail_red_extra: { "line-color": "#e8453d" },
  trail_yellow: { "line-color": "#ecd23a" },
  trail_yellow_extra: { "line-color": "#ecd23a" },
  trail_green: { "line-color": "#46b531" },
  trail_green_extra: { "line-color": "#46b531" },
  trail_blue: { "line-color": "#4f6cea" },

  // Silnice ztlumené, ať mapě nedominují
  road_minor: { "line-color": "#8e8c82" },
  road_major: { "line-color": "#bcb25a" },
  road_primary: { "line-color": "#cf9a52" },
  road_motorway: { "line-color": "#6e9d58" },
  road_minor_casing: { "line-color": "#0e0f0b" },
  road_major_casing: { "line-color": "#0e0f0b" },
  road_primary_casing: { "line-color": "#0e0f0b" },
  road_motorway_casing: { "line-color": "#0e0f0b" },
};

// Popisky, jejichž barvu řešíme explicitně výše (necháváme je být).
const KEEP_LABEL_COLOR = new Set(["contour_label"]);

// Aplikuje noční přebarvení na (už otintěný) turistický styl.
export function applyTouristDark(style: AnyStyle): AnyStyle {
  const dark: AnyStyle =
    typeof structuredClone === "function"
      ? structuredClone(style)
      : JSON.parse(JSON.stringify(style));

  for (const layer of dark.layers) {
    // Obecně: všechny textové popisky světlé s tmavým lemem.
    if (layer.type === "symbol" && !KEEP_LABEL_COLOR.has(layer.id)) {
      const paint = (layer.paint ??= {});
      paint["text-color"] = DARK.text;
      paint["text-halo-color"] = DARK.halo;
    }

    const override = PAINT_OVERRIDES[layer.id];
    if (override) {
      layer.paint = { ...(layer.paint ?? {}), ...override };
    }
  }

  return dark;
}
