import { isLightPalette } from "./themeState";

// Sdílená teplotní barevná škála (meteogram, klimatická heatmapa).
// Tmavá varianta je světlá/jasná (dobře čitelná na tmavém pozadí).
export const TEMP_COLORS: [number, [number, number, number]][] = [
  [34, [239, 68, 68]],
  [29, [249, 115, 22]],
  [24, [251, 146, 60]],
  [19, [250, 204, 21]],
  [14, [163, 230, 53]],
  [9, [74, 222, 128]],
  [4, [56, 189, 248]],
  [-1, [96, 165, 250]],
  [-6, [129, 140, 248]],
  [-12, [167, 139, 250]],
];

// Světlá varianta – tmavší a sytější odstíny (~úroveň 600), aby měly na světlém
// pozadí dostatečný kontrast (žlutá a limetka jinak na bílé „zmizí").
export const TEMP_COLORS_LIGHT: [number, [number, number, number]][] = [
  [34, [220, 38, 38]],
  [29, [234, 88, 12]],
  [24, [217, 119, 6]],
  [19, [180, 120, 0]],
  [14, [101, 150, 13]],
  [9, [22, 150, 74]],
  [4, [2, 132, 199]],
  [-1, [37, 99, 235]],
  [-6, [79, 70, 229]],
  [-12, [124, 58, 237]],
];

export function tempColor(t: number): string {
  const stops = isLightPalette() ? TEMP_COLORS_LIGHT : TEMP_COLORS;
  if (t >= stops[0][0]) return rgb(stops[0][1]);
  const last = stops[stops.length - 1];
  if (t <= last[0]) return rgb(last[1]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [hiT, hiC] = stops[i];
    const [loT, loC] = stops[i + 1];
    if (t <= hiT && t >= loT) {
      const f = (t - loT) / (hiT - loT);
      return rgb([
        Math.round(loC[0] + (hiC[0] - loC[0]) * f),
        Math.round(loC[1] + (hiC[1] - loC[1]) * f),
        Math.round(loC[2] + (hiC[2] - loC[2]) * f),
      ]);
    }
  }
  return rgb(last[1]);
}

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}
