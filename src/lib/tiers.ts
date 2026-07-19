import { isLightPalette } from "./themeState";

export type Tier = "hot" | "warm" | "mild" | "cool" | "cold" | "freezing";

// Teplotní tón podle denní maximální teploty.
export function tempTier(high: number): Tier {
  if (high >= 26) return "hot";
  if (high >= 22) return "warm";
  if (high >= 16) return "mild";
  if (high >= 9) return "cool";
  if (high >= 2) return "cold";
  return "freezing";
}

export const TIER_LABEL: Record<Tier, string> = {
  hot: "horko",
  warm: "teplo",
  mild: "akorát",
  cool: "chladno",
  cold: "zima",
  freezing: "mráz",
};

export const TIER_COLOR: Record<Tier, string> = {
  hot: "#ff7a4d",
  warm: "#ffce5b",
  mild: "#5bd99a",
  cool: "#5bb6ff",
  cold: "#7f9be0",
  freezing: "#a9d2ff",
};

// Světlá varianta – tmavší/sytější odstíny, aby byly čitelné jako text i na
// světlém pozadí (světle žlutá a světle modrá jinak na bílé „mizí").
export const TIER_COLOR_LIGHT: Record<Tier, string> = {
  hot: "#d64524",
  warm: "#c07d00",
  mild: "#16a06a",
  cool: "#1f7fd6",
  cold: "#4a5fc4",
  freezing: "#3f7bce",
};

export function tierColor(tier: Tier): string {
  return isLightPalette() ? TIER_COLOR_LIGHT[tier] : TIER_COLOR[tier];
}
