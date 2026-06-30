// Tourist tint pro MapLibre styl – přebarví vrstvy MapTiler "outdoor" (v1)
// stylu tak, aby výsledek připomínal klasickou českou turistickou mapu
// (mapy.com): teplé papírové pozadí, sytá zeleň lesů, výrazný stínovaný reliéf,
// hnědé vrstevnice, silnice barevně podle důležitosti (bílá / žlutá / oranžová
// / zelená dálnice) s tmavým lemem, železnice a značené trasy KČT.
//
// Portováno z openclimbing.org (touristStyle.ts), bez závislosti na lodashi.

type Paint = Record<string, unknown>;
type Layout = Record<string, unknown>;
type AnyLayer = {
  id: string;
  type?: string;
  paint?: Paint;
  layout?: Layout;
  filter?: unknown;
  minzoom?: number;
  source?: string;
  "source-layer"?: string;
  [key: string]: unknown;
};
type AnyStyle = { layers: AnyLayer[]; [key: string]: unknown };

const COUNTRY_LABEL_PAINT: Paint = {
  "text-color": "rgba(43, 40, 40, 1)",
  "text-halo-color": "rgba(248, 248, 242, 0.95)",
  "text-halo-width": 1.8,
  "text-halo-blur": 1,
};
const COUNTRY_LABEL_LAYOUT: Layout = {
  "text-font": ["Noto Sans Bold"],
  "text-transform": "uppercase",
  "text-letter-spacing": 0.14,
};

const CITY_LABEL_PAINT: Paint = {
  "text-halo-width": 2.4,
  "text-halo-color": "rgba(255, 255, 255, 0.92)",
};
const CITY_LABEL_LAYOUT: Layout = {
  "text-font": ["Roboto Bold", "Noto Sans Bold"],
  "text-transform": "uppercase",
  "text-letter-spacing": 0.05,
};

const PAINT_OVERRIDES: Record<string, Paint> = {
  background: { "background-color": "#EFEEE0" },

  // Lesy / zeleň
  landcover_wood: { "fill-color": "#C1DC9E", "fill-opacity": 1 },
  globallandcover_tree: { "fill-color": "#C1DC9E" },
  globallandcover_forest: { "fill-color": "#C1DC9E" },

  // Zástavba / průmysl
  landuse_residential: {
    "fill-color": "#D8C49E",
    "fill-opacity": {
      stops: [
        [7, 0.95],
        [12, 0.85],
        [16, 0.7],
      ],
    },
  },
  landuse_industrial: { "fill-color": "#D9D7CF", "fill-opacity": 0.85 },

  // Budovy – tmavší než zástavba kvůli kontrastu
  building: { "fill-color": "#C6A977" },
  "building-top": { "fill-color": "#C6A977", "fill-outline-color": "#9C8052" },
  "building-3d": { "fill-extrusion-color": "#BA9D6C" },

  // Výrazný stínovaný reliéf – poznávací znak turistické mapy
  hillshade: {
    "hillshade-accent-color": "rgba(150, 128, 100, 0.6)",
    "hillshade-exaggeration": {
      stops: [
        [5, 0.3],
        [9, 0.5],
        [12, 0.7],
        [13, 0.85],
        [16, 0.9],
      ],
    },
    "hillshade-shadow-color": "rgba(92, 74, 54, 0.92)",
    "hillshade-highlight-color": "rgba(255, 250, 234, 0.5)",
  },

  // Vrstevnice – výraznější a hnědší
  contour_index: {
    "line-color": "rgba(166, 118, 48, 1)",
    "line-width": {
      stops: [
        [10, 1],
        [14, 1.6],
      ],
    },
    "line-opacity": {
      stops: [
        [10, 0.7],
        [14, 0.65],
      ],
    },
  },
  contour: {
    "line-color": "rgba(166, 118, 48, 1)",
    "line-opacity": {
      stops: [
        [10, 0.5],
        [14, 0.5],
      ],
    },
  },
  contour_label: { "text-color": "rgba(138, 109, 59, 1)" },

  // Voda
  water: { "fill-color": "#94BBDA" },
  water_intermittent: { "fill-color": "#94BBDA" },
  waterway_river: { "line-color": "#94BBDA" },
  waterway_other: { "line-color": "#94BBDA" },

  // Pěšiny – hnědošedé, tenké, čárkované
  road_path: {
    "line-color": "#9B9070",
    "line-width": {
      base: 1.2,
      stops: [
        [14, 0.4],
        [16, 1],
        [20, 1.6],
      ],
    },
    "line-dasharray": [2, 1.6],
  },

  // Cyklotrasy – magenta, tečkované
  bicycle_local: { "line-color": "#E84CC0", "line-dasharray": [0.5, 2.5] },
  bicycle_longdistance: { "line-color": "#E84CC0", "line-dasharray": [0.5, 2.5] },

  // Značené turistické trasy KČT
  trail_red: { "line-color": "#C5060A" },
  trail_red_extra: { "line-color": "#C5060A" },
  trail_yellow: { "line-color": "#DAC020" },
  trail_yellow_extra: { "line-color": "#DAC020" },
  trail_green: { "line-color": "#1F8508" },
  trail_green_extra: { "line-color": "#1F8508" },
  trail_blue: { "line-color": "#0B22BB" },

  // Železnice – bílý základ (šedý lem + šedé čárky jako samostatné vrstvy níže)
  road_rail: {
    "line-color": "#FFFFFF",
    "line-width": {
      base: 1.4,
      stops: [
        [8, 0.8],
        [14, 1.6],
        [18, 3],
        [20, 3.8],
      ],
    },
  },

  // Silnice barevně podle důležitosti (lemy + oranžová primární jako vrstvy níže)
  road_minor: { "line-color": "#FFFFFF" },
  road_major: {
    "line-color": "#F5EA6C",
    "line-width": {
      base: 1.2,
      stops: [
        [8, 0.8],
        [11, 1.6],
        [14, 4],
        [18, 14],
        [22, 16],
      ],
    },
  },
  road_motorway: {
    "line-color": "#97D26C",
    "line-width": {
      base: 1.2,
      stops: [
        [5, 1],
        [8, 2],
        [11, 3],
        [14, 5],
        [18, 16],
        [22, 18],
      ],
    },
  },

  // Státní hranice – fialová čárkovaná čára (měkký pruh přidán níže)
  boundary_country: {
    "line-color": "#7C4A93",
    "line-width": {
      base: 1,
      stops: [
        [0, 0.6],
        [5, 1.4],
        [8, 2.2],
        [12, 4],
      ],
    },
    "line-opacity": {
      base: 1,
      stops: [
        [0, 0.35],
        [5, 0.6],
        [8, 0.85],
        [12, 1],
      ],
    },
    "line-dasharray": [4, 2],
  },

  // Popisky měst – silnější obrys (halo). Pokrýváme obě varianty ID
  // (pomlčka v openclimbing outdoorStyle, podtržítko v MapTiler outdoor v1).
  "place-city": CITY_LABEL_PAINT,
  "place-capital": CITY_LABEL_PAINT,
  place_city: CITY_LABEL_PAINT,
  place_capital: CITY_LABEL_PAINT,

  country_other: COUNTRY_LABEL_PAINT,
  country_rank_3: COUNTRY_LABEL_PAINT,
  "country_rank_1-2": COUNTRY_LABEL_PAINT,
};

// Zúžíme žlutou "major" třídu (a její lem) na secondary/tertiary, aby nad ní
// mohla sedět oranžová primary/trunk třída.
const MAJOR_YELLOW_FILTER = [
  "all",
  ["in", "class", "secondary", "tertiary"],
  ["!=", "brunnel", "tunnel"],
];
const PRIMARY_ORANGE_FILTER = [
  "all",
  ["in", "class", "primary", "trunk"],
  ["!=", "brunnel", "tunnel"],
];

const FILTER_OVERRIDES: Record<string, unknown> = {
  road_major: MAJOR_YELLOW_FILTER,
};

const LAYOUT_OVERRIDES: Record<string, Layout> = {
  // Skryjeme dálkové trasy z odděleného `outdoor` zdroje (probleskují při
  // oddálení dřív než maptiler podklad).
  trail_longdistance: { visibility: "none" },
  trail_longdistance_casing: { visibility: "none" },
  bicycle_longdistance: { visibility: "none" },
  bicycle_longdistance_casing: { visibility: "none" },

  // Horské vrcholy – malé, tučné, kurzíva, patkové
  mountain_peak: {
    "text-font": [
      "Noto Serif Bold Italic",
      "Noto Serif Italic",
      "Roboto Condensed Italic",
    ],
    "text-size": {
      stops: [
        [9, 8],
        [12, 9],
        [15, 11],
      ],
    },
  },

  "place-town": { "text-font": ["Roboto Medium", "Noto Sans Regular"] },
  place_town: { "text-font": ["Roboto Medium", "Noto Sans Regular"] },
  "place-city": CITY_LABEL_LAYOUT,
  "place-capital": CITY_LABEL_LAYOUT,
  place_city: CITY_LABEL_LAYOUT,
  place_capital: CITY_LABEL_LAYOUT,

  country_other: COUNTRY_LABEL_LAYOUT,
  country_rank_3: COUNTRY_LABEL_LAYOUT,
  "country_rank_1-2": COUNTRY_LABEL_LAYOUT,
};

function roadCasing(
  id: string,
  lineColor: string,
  widthStops: [number, number][],
  filter: unknown,
  source: string,
  sourceLayer: string,
  minzoom?: number,
): AnyLayer {
  return {
    id,
    type: "line",
    paint: {
      "line-color": lineColor,
      "line-width": { base: 1.2, stops: widthStops },
    },
    filter,
    layout: { "line-cap": "round", "line-join": "round", visibility: "visible" },
    source,
    "source-layer": sourceLayer,
    ...(minzoom !== undefined ? { minzoom } : {}),
  };
}

// Zmenší/zvětší hodnotu line-width (číslo nebo { stops } funkci).
function scaleLineWidth(value: unknown, factor: number): unknown {
  if (typeof value === "number") return value * factor;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { stops?: unknown }).stops)
  ) {
    const fn = value as { stops: [number, unknown][] };
    return {
      ...fn,
      stops: fn.stops.map(([zoom, w]) => [
        zoom,
        typeof w === "number" ? w * factor : w,
      ]),
    };
  }
  return value;
}

// Značené trasy KČT: jedna širší barevná čára bez bílých lemů.
function flattenTrail(layer: AnyLayer): void {
  if (!layer.id.startsWith("trail_") || !layer.paint) return;
  if (layer.id.includes("_casing")) {
    layer.layout = { ...(layer.layout ?? {}), visibility: "none" };
    return;
  }
  if ("line-width" in layer.paint) {
    layer.paint["line-width"] = scaleLineWidth(layer.paint["line-width"], 1.8);
  }
  layer.minzoom = 12;
}

// Najde název zdroje, který používá vrstva silnic (MapTiler vs jiné).
function detectRoadSource(style: AnyStyle): {
  source: string;
  sourceLayer: string;
} {
  const road = style.layers.find(
    (l) => l.id === "road_major" || l.id === "road_minor",
  );
  return {
    source: (road?.source as string) ?? "maptiler_planet",
    sourceLayer: (road?.["source-layer"] as string) ?? "transportation",
  };
}

export function applyTouristTint(style: AnyStyle): AnyStyle {
  const tinted: AnyStyle =
    typeof structuredClone === "function"
      ? structuredClone(style)
      : JSON.parse(JSON.stringify(style));
  const { source: src, sourceLayer: roadLayer } = detectRoadSource(tinted);

  const railFilter = [
    "all",
    ["!in", "brunnel", "tunnel"],
    ["==", "class", "rail"],
  ];
  const railWidth = {
    base: 1.4,
    stops: [
      [8, 0.8],
      [14, 1.6],
      [18, 3],
      [20, 3.8],
    ],
  };

  // Šedý lem železnice (souvislý obrys podél bílého základu).
  const railCasing: AnyLayer = {
    id: "road_rail_casing",
    type: "line",
    paint: {
      "line-color": "#6E6F71",
      "line-width": {
        base: 1.4,
        stops: [
          [8, 1.4],
          [14, 2.8],
          [18, 4.6],
          [20, 5.6],
        ],
      },
    },
    filter: railFilter,
    layout: { visibility: "visible", "line-join": "round" },
    source: src,
    "source-layer": roadLayer,
  };

  // Šedé čárky přes bílý základ → střídavé šedo-bílé pražce.
  const railDash: AnyLayer = {
    id: "road_rail_dash",
    type: "line",
    paint: {
      "line-color": "#6E6F71",
      "line-width": railWidth,
      "line-dasharray": [3, 3],
    },
    filter: railFilter,
    layout: { visibility: "visible", "line-join": "round", "line-cap": "butt" },
    source: src,
    "source-layer": roadLayer,
  };

  // Měkký fialový pruh pod státní hranicí (KČT styl).
  const countryBorderBand: AnyLayer = {
    id: "boundary_country_band",
    type: "line",
    paint: {
      "line-color": "rgba(150, 92, 176, 0.28)",
      "line-width": {
        base: 1,
        stops: [
          [5, 2],
          [8, 5],
          [10, 9],
          [12, 13],
          [16, 18],
        ],
      },
      "line-opacity": {
        stops: [
          [5, 0.4],
          [8, 1],
        ],
      },
    },
    minzoom: 5,
    filter: [
      "all",
      ["==", "admin_level", 2],
      ["==", "maritime", 0],
      ["==", "disputed", 0],
    ],
    layout: { "line-cap": "round", "line-join": "round", visibility: "visible" },
    source: src,
    "source-layer": "boundary",
  };

  // Lemy vkládané těsně PŘED odpovídající silniční vrstvu.
  const CASING_BEFORE: Record<string, AnyLayer> = {
    road_rail: railCasing,
    boundary_country: countryBorderBand,
    road_minor: roadCasing(
      "road_minor_casing",
      "#A89C7D",
      [
        [13, 2],
        [18, 14.5],
        [22, 16.5],
      ],
      ["all", ["!in", "brunnel", "tunnel"], ["in", "class", "minor", "service", "pier"]],
      src,
      roadLayer,
      13,
    ),
    road_major: roadCasing(
      "road_major_casing",
      "#C1B233",
      [
        [8, 1.8],
        [11, 2.8],
        [14, 6],
        [18, 16.5],
        [22, 18.5],
      ],
      MAJOR_YELLOW_FILTER,
      src,
      roadLayer,
    ),
    road_motorway: roadCasing(
      "road_motorway_casing",
      "#6FA156",
      [
        [5, 2],
        [8, 3.2],
        [11, 4.4],
        [14, 7],
        [18, 18],
        [22, 20],
      ],
      ["all", ["!in", "brunnel", "tunnel"], ["in", "class", "motorway"]],
      src,
      roadLayer,
      5,
    ),
  };

  // Oranžová primary/trunk třída + železniční čárky vkládané ZA major vrstvu.
  const EXTRA_AFTER: Record<string, AnyLayer[]> = {
    road_rail: [railDash],
    road_major: [
      roadCasing(
        "road_primary_casing",
        "#E2A23C",
        [
          [6, 2.2],
          [9, 3.2],
          [11, 4.6],
          [14, 7.5],
          [18, 19.5],
          [22, 21.5],
        ],
        PRIMARY_ORANGE_FILTER,
        src,
        roadLayer,
        6,
      ),
      roadCasing(
        "road_primary",
        "#FBC873",
        [
          [6, 1.2],
          [9, 2],
          [11, 3.2],
          [14, 5.8],
          [18, 17.5],
          [22, 19.5],
        ],
        PRIMARY_ORANGE_FILTER,
        src,
        roadLayer,
        6,
      ),
    ],
  };

  const layers: AnyLayer[] = [];
  for (const layer of tinted.layers) {
    const casing = CASING_BEFORE[layer.id];
    if (casing) layers.push(casing);

    flattenTrail(layer);

    const paintOverride = PAINT_OVERRIDES[layer.id];
    if (paintOverride) layer.paint = { ...(layer.paint ?? {}), ...paintOverride };

    const layoutOverride = LAYOUT_OVERRIDES[layer.id];
    if (layoutOverride) layer.layout = { ...(layer.layout ?? {}), ...layoutOverride };

    if (layer.id in FILTER_OVERRIDES) layer.filter = FILTER_OVERRIDES[layer.id];

    layers.push(layer);

    const extra = EXTRA_AFTER[layer.id];
    if (extra) extra.forEach((e) => layers.push(e));
  }

  tinted.layers = layers;
  return tinted;
}
