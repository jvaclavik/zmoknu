// Vygeneruje ikony aplikace (PWA, apple-touch, favicon) z public/logo.png.
// Logo (bílý deštník + kapka, průhledné pozadí) vycentruje na tmavé firemní
// pozadí. Spusť: node scripts/gen-icons.mjs
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const logoPath = resolve(root, "public/logo.png");
const pub = resolve(root, "public");

const BG = "#05080f";

// [výstupní soubor, velikost px, podíl loga na plátně]
// Menší ikony mají logo relativně větší, ať je i na malé ploše čitelné.
const ICONS = [
  ["pwa-512x512.png", 512, 0.64],
  ["pwa-192x192.png", 192, 0.66],
  ["apple-touch-icon.png", 180, 0.66],
  ["favicon.png", 64, 0.72],
];

for (const [file, size, ratio] of ICONS) {
  const box = Math.round(size * ratio);
  const logo = await sharp(logoPath)
    .resize(box, box, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(resolve(pub, file));

  console.log(`✓ ${file} (${size}×${size})`);
}

console.log("Hotovo. Pro splash spusť: node scripts/gen-splash.mjs");
