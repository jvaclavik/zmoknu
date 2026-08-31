// Sdílená logika oblékání: stupnice „co si vzít na sebe" podle pocitové teploty
// (a intenzity srážek / UV). Bydlí v lib, protože ji používá jak karta
// „Co si vzít na sebe", tak meteogram oblečení – ať se nemohou rozejít.

export type ClothKind =
  | "tshirt"
  | "longsleeve"
  | "shirt"
  | "shorts"
  | "pants"
  | "sweater"
  | "warmsweater"
  | "jacket"
  | "coat"
  | "downvest"
  | "downjacket"
  | "beanie"
  | "gloves"
  | "scarf"
  | "umbrella"
  | "raincoat"
  | "cap"
  | "sunglasses"
  | "sunscreen"
  | "boots"
  | "sandals"
  | "sneakers"
  | "winterboots"
  | "none";

// Co člověk zrovna dělá. Pohyb tělo zahřívá (běh nejvíc), klid ochlazuje –
// promítá se to do pocitové teploty, se kterou se oblečení skládá.
export type Activity = "sit" | "walk" | "run";

export const ACTIVITY_OFFSET: Record<Activity, number> = {
  sit: -3,
  walk: 0,
  run: 6,
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  sit: "Sedím",
  walk: "Chodím",
  run: "Běhám",
};

// Osy oblečení: seřazené od nejteplejší volby (vlevo) po nejteplejší oblečení
// (vpravo). `center` = pocitová teplota, při které je daná volba „ideál".
export interface ScaleStop {
  kind: ClothKind;
  label: string;
  center: number;
}

// Osy podle pocitové teploty (vlevo teplo → vpravo zima).
// Centra jsou zvolená tak, aby se aktivní zarážka přepínala na stejných prazích
// jako buildOutfit (přepnutí nastává v půli mezi sousedními centry).
export const TOP_STOPS: ScaleStop[] = [
  { kind: "tshirt", label: "Triko", center: 22 },
  { kind: "shirt", label: "Košile", center: 16 },
  { kind: "sweater", label: "Mikina", center: 14 },
  { kind: "warmsweater", label: "Teplý svetr", center: 4 },
];

export const JACKET_STOPS: ScaleStop[] = [
  { kind: "none", label: "Bez bundy", center: 15 },
  { kind: "jacket", label: "Větrovka", center: 9 },
  { kind: "coat", label: "Přechodná bunda", center: 3 },
  { kind: "downjacket", label: "Zimní bunda", center: -5 },
];

export const BOTTOM_STOPS: ScaleStop[] = [
  { kind: "shorts", label: "Kraťasy", center: 26 },
  { kind: "pants", label: "Lehké kalhoty", center: 18 },
  { kind: "pants", label: "Teplé kalhoty", center: 0 },
];

export const BOOTS_STOPS: ScaleStop[] = [
  { kind: "sandals", label: "Sandály", center: 24 },
  { kind: "sneakers", label: "Tenisky", center: 15 },
  { kind: "boots", label: "Uzavřené boty", center: 6 },
  { kind: "winterboots", label: "Zimní boty", center: -2 },
];

// Při běhu sandály nedávají smysl – nejteplejší volba jsou tenisky, v mrazu
// zimní (běžecké) boty.
export const BOOTS_STOPS_RUN: ScaleStop[] = [
  { kind: "sneakers", label: "Tenisky", center: 15 },
  { kind: "boots", label: "Uzavřené boty", center: 4 },
  { kind: "winterboots", label: "Zimní boty", center: -4 },
];

// Kumulativní – v mrazu postupně přibývá čepice → šála → rukavice.
export const HEAD_STOPS: ScaleStop[] = [
  { kind: "none", label: "Nic", center: 13 },
  { kind: "beanie", label: "Čepice", center: 6 },
  { kind: "scarf", label: "Šála", center: 1 },
  { kind: "gloves", label: "Rukavice", center: -1 },
];

// Osy podle intenzity/pravděpodobnosti (vlevo netřeba → vpravo víc potřeba).
export const RAIN_STOPS: ScaleStop[] = [
  { kind: "none", label: "Netřeba", center: 12 },
  { kind: "umbrella", label: "Deštník", center: 55 },
  { kind: "raincoat", label: "Nepromokavá bunda", center: 85 },
];

// Kumulativní – s rostoucím UV přibývá brýle → kšiltovka → krém.
// Prahy (půl mezi centry): brýle od UV ~2, + kšiltovka od ~4, + krém od ~7.
export const SUN_STOPS: ScaleStop[] = [
  { kind: "none", label: "Netřeba", center: 1.5 },
  { kind: "sunglasses", label: "Brýle", center: 3 },
  { kind: "cap", label: "Kšiltovka", center: 5 },
  { kind: "sunscreen", label: "Krém", center: 9 },
];

// Pozice na ose (0–1). Zarážky jsou zarovnané na středy sloupců mřížky, tj.
// (i+0.5)/n. Funguje pro klesající (teplota) i rostoucí (déšť/UV) škály.
export function scalePos(value: number, centers: number[]): number {
  const n = centers.length;
  const pos = (i: number) => (i + 0.5) / n;
  if (!Number.isFinite(value)) return pos(0);
  for (let i = 0; i < n - 1; i++) {
    const a = centers[i];
    const b = centers[i + 1];
    if (value >= Math.min(a, b) && value <= Math.max(a, b)) {
      const t = (value - a) / (b - a);
      return pos(i) + t * (pos(i + 1) - pos(i));
    }
  }
  const descending = centers[0] >= centers[n - 1];
  const beyondFirst = descending ? value >= centers[0] : value <= centers[0];
  return beyondFirst ? pos(0) : pos(n - 1);
}

// Index aktivní zarážky = zaokrouhlená pozice značky na mřížku zarážek.
export function activeIndex(value: number, stops: ScaleStop[]): number {
  const centers = stops.map((s) => s.center);
  const n = centers.length;
  const f = scalePos(value, centers);
  return Math.min(n - 1, Math.max(0, Math.round(f * n - 0.5)));
}

// ---------------------------------------------------------------------------
// Úrovně oblečení pro meteogram
// ---------------------------------------------------------------------------

// „Kolik oblečení" pro danou pocitovou teplotu. Úroveň skládáme ze dvou os,
// které se používají i v kartě: horní vrstva + bunda. Obě jsou monotónní
// (s klesající teplotou roste index), takže jejich součet je taky monotónní a
// každá kombinace vyjde na jinou úroveň – dohromady 0 (nejlehčí) až 6 (nejtepleji).
export const OUTFIT_LEVEL_MAX =
  TOP_STOPS.length - 1 + (JACKET_STOPS.length - 1);

export interface OutfitPick {
  /** Pocitová teplota upravená o aktivitu (°C). */
  eff: number;
  /** 0 = nejlehčí oblečení … OUTFIT_LEVEL_MAX = nejteplejší. */
  level: number;
  top: ScaleStop;
  jacket: ScaleStop;
  bottom: ScaleStop;
  shoes: ScaleStop;
  head: ScaleStop;
  /** Krátký popis („Mikina + větrovka"). */
  label: string;
}

// Popis vrstvy. `t` je překladač (tr) – bez něj vrátí českou předlohu.
export function outfitLabel(
  top: ScaleStop,
  jacket: ScaleStop,
  t: (s: string) => string = (s) => s,
): string {
  return jacket.kind === "none"
    ? t(top.label)
    : `${t(top.label)} + ${t(jacket.label).toLowerCase()}`;
}

// Oblečení pro jednu hodinu. `feels` = pocitová teplota, `activity` posune
// efektivní teplotu (pohyb zahřívá).
export function outfitAt(feels: number, activity: Activity = "walk"): OutfitPick {
  const eff = (Number.isFinite(feels) ? feels : 0) + ACTIVITY_OFFSET[activity];
  const top = TOP_STOPS[activeIndex(eff, TOP_STOPS)];
  const jacket = JACKET_STOPS[activeIndex(eff, JACKET_STOPS)];
  const bottom = BOTTOM_STOPS[activeIndex(eff, BOTTOM_STOPS)];
  const bootStops = activity === "run" ? BOOTS_STOPS_RUN : BOOTS_STOPS;
  const shoes = bootStops[activeIndex(eff, bootStops)];
  const head = HEAD_STOPS[activeIndex(eff, HEAD_STOPS)];
  return {
    eff,
    level: activeIndex(eff, TOP_STOPS) + activeIndex(eff, JACKET_STOPS),
    top,
    jacket,
    bottom,
    shoes,
    head,
    label: outfitLabel(top, jacket),
  };
}

// Hranice mezi úrovněmi v pocitové teplotě (°C), od nejteplejší po nejchladnější.
// Počítáme je z týchž zarážek, ze kterých se skládá oblečení, takže vodorovné
// linky v grafu sedí přesně tam, kde se doporučení mění.
export interface OutfitBound {
  /** Efektivní pocitová teplota (°C), od které dolů platí `level`. */
  from: number;
  level: number;
  top: ScaleStop;
  jacket: ScaleStop;
}

export function outfitLevelBounds(): OutfitBound[] {
  const out: OutfitBound[] = [];
  let prev = -1;
  // Projdeme rozsah po 0,25 °C – zarážky se přepínají v půli mezi centry, takže
  // stačí jemný krok, hranici pak zaokrouhlíme na 0,5 °C.
  for (let t = 45; t >= -35; t -= 0.25) {
    // Aktivitu tu neaplikujeme: hranice platí v efektivní teplotě, posun podle
    // aktivity se přičítá k datům (viz outfitAt), ne k hranicím.
    const pick = outfitAt(t, "walk");
    if (pick.level !== prev) {
      out.push({
        from: Math.round(t * 2) / 2,
        level: pick.level,
        top: pick.top,
        jacket: pick.jacket,
      });
      prev = pick.level;
    }
  }
  return out;
}

// Barva úrovně – od „teplo" po „mráz", ať graf i ikonky drží jeden gradient.
const OUTFIT_LEVEL_COLORS = [
  "#ff8a4c",
  "#ffc14d",
  "#9ed36a",
  "#5bd99a",
  "#5bb6ff",
  "#7d8cff",
  "#b06bff",
];

export function outfitLevelColor(level: number): string {
  const n = OUTFIT_LEVEL_COLORS.length;
  const scaled = Math.round(
    (Math.max(0, Math.min(OUTFIT_LEVEL_MAX, level)) / OUTFIT_LEVEL_MAX) * (n - 1),
  );
  return OUTFIT_LEVEL_COLORS[scaled];
}

// Doplňky nad rámec vrstev – deštník / sluneční ochrana / čepice.
export function outfitExtras(opts: {
  rainProb: number;
  precip: number;
  uv: number;
  eff: number;
}): ClothKind[] {
  const out: ClothKind[] = [];
  const rainScore = Math.max(
    opts.rainProb,
    Math.min(100, opts.precip * 40),
  );
  const rainIdx = activeIndex(rainScore, RAIN_STOPS);
  if (RAIN_STOPS[rainIdx].kind !== "none") out.push(RAIN_STOPS[rainIdx].kind);
  const sunIdx = activeIndex(opts.uv, SUN_STOPS);
  for (let i = 1; i <= sunIdx; i++) out.push(SUN_STOPS[i].kind);
  const headIdx = activeIndex(opts.eff, HEAD_STOPS);
  for (let i = 1; i <= headIdx; i++) out.push(HEAD_STOPS[i].kind);
  return out;
}
