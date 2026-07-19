// Aktivní motiv pro barevné util funkce (tempColor, tierColor). App ho nastaví
// synchronně během renderu (setThemePalette), takže potomci při renderu čtou
// aktuální hodnotu a barvy se přepnou okamžitě spolu s CSS.
let palette: "light" | "dark" = "dark";

export function setThemePalette(theme: "light" | "dark"): void {
  palette = theme;
}

export function isLightPalette(): boolean {
  return palette === "light";
}
