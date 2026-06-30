import type { StyleSpecification } from "maplibre-gl";
import { applyTouristTint } from "./touristStyle";
import { applyTouristDark } from "./touristDarkStyle";

// Turistický styl stavíme nad MapTiler "outdoor" (v1) – ten používá zdroj
// `maptiler_planet` a snake_case ID vrstev (landcover_wood, road_major, …),
// na které přesně cílí náš tint (à la mapy.com / openclimbing).
function maptilerOutdoor(key: string): string {
  return `https://api.maptiler.com/maps/outdoor/style.json?key=${key}`;
}

// Záložní tmavý rastrový podklad (CARTO) – použije se jen když chybí MapTiler
// klíč. Pozn.: na rastrovém podkladu radar (image/raster overlay) nemusí jít
// spolehlivě vykreslit, proto preferujeme vektorovou turistickou tmavou.
export const darkStyle: StyleSpecification = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

// Načte MapTiler "outdoor" styl a aplikuje turistický tint.
export async function loadTouristStyle(): Promise<StyleSpecification> {
  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  if (!key) throw new Error("Chybí VITE_MAPTILER_KEY pro turistickou mapu.");

  const res = await fetch(maptilerOutdoor(key));
  if (!res.ok) throw new Error("Nepodařilo se načíst styl mapy.");
  const base = (await res.json()) as unknown;
  return applyTouristTint(base as never) as unknown as StyleSpecification;
}

// Noční turistická mapa – stejný vektorový základ jako turistická (proto na ní
// radar funguje stejně dobře), jen ztmavená.
export async function loadTouristDarkStyle(): Promise<StyleSpecification> {
  const tourist = await loadTouristStyle();
  return applyTouristDark(
    tourist as never,
  ) as unknown as StyleSpecification;
}
