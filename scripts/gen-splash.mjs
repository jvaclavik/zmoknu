// Vygeneruje iOS splash obrázky (apple-touch-startup-image) do public/splash.
// Tmavé pozadí + vycentrované logo. Spusť: node scripts/gen-splash.mjs
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const iconPath = resolve(root, "public/pwa-512x512.png");
const outDir = resolve(root, "public/splash");

const BG = "#05080f";

// [CSS šířka, CSS výška, device-pixel-ratio] – běžná zařízení iPhone/iPad (portrét).
const DEVICES = [
  [320, 568, 2],
  [375, 667, 2],
  [375, 812, 3],
  [390, 844, 3],
  [393, 852, 3],
  [414, 736, 3],
  [414, 896, 2],
  [414, 896, 3],
  [428, 926, 3],
  [430, 932, 3],
  [768, 1024, 2],
  [810, 1080, 2],
  [820, 1180, 2],
  [834, 1112, 2],
  [834, 1194, 2],
  [1024, 1366, 2],
];

await mkdir(outDir, { recursive: true });

const links = [];

for (const [cw, ch, ratio] of DEVICES) {
  const w = cw * ratio;
  const h = ch * ratio;
  const iconSize = Math.round(Math.min(w, h) * 0.34);
  const icon = await sharp(iconPath)
    .resize(iconSize, iconSize, { fit: "contain" })
    .toBuffer();

  const file = `apple-splash-${w}x${h}.png`;
  await sharp({
    create: { width: w, height: h, channels: 4, background: BG },
  })
    .composite([{ input: icon, gravity: "center" }])
    .png()
    .toFile(resolve(outDir, file));

  links.push(
    `    <link rel="apple-touch-startup-image" href="/splash/${file}" ` +
      `media="(device-width: ${cw}px) and (device-height: ${ch}px) and ` +
      `(-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)" />`,
  );
}

console.log(`Hotovo: ${DEVICES.length} splash obrázků do public/splash`);
console.log("\n--- Vlož do <head> index.html: ---\n");
console.log(links.join("\n"));
