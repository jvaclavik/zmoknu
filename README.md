# Zmoknu? ☔

Přehledná webová aplikace pro počasí a radar srážek, inspirovaná [Aladinem](https://aladinonline.oblacno.cz).
Postavená v Reactu + Vite, připravená k nasazení na **Vercel**.

## Co umí

- **Aktuální počasí** – teplota, pocitová teplota, vítr a nárazy, vlhkost, tlak, srážky.
- **Hodinová předpověď** – až 48 hodin s ikonami, pravděpodobností srážek a větrem.
- **Denní předpověď až na 16 dní** – tedy výrazně dále než Aladin.
- **Radar srážek s posuvníkem času** – minulost i krátkodobá predikce (nowcast),
  přehrávání i ruční posun po snímcích (data RainViewer).
- **Hledání měst** a **geolokace** ("moje poloha").
- **Responzivní design** pro mobil i desktop, motiv pozadí podle aktuálního počasí.

## Zdroje dat (zdarma, bez API klíče)

- [Open-Meteo](https://open-meteo.com) – předpověď a geokódování.
- [RainViewer](https://www.rainviewer.com/api.html) – radarové snímky.
- Mapové dlaždice: OpenStreetMap + CARTO.

## Spuštění lokálně

```bash
npm install
npm run dev
```

Aplikace běží na `http://localhost:5173`.

## Build

```bash
npm run build      # výstup do dist/
npm run preview    # náhled produkčního buildu
```

## Nasazení na Vercel

1. Nahraj repozitář na GitHub.
2. Na [vercel.com](https://vercel.com) zvol **Add New → Project** a vyber repozitář.
3. Vercel automaticky rozpozná Vite. Stačí potvrdit:
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Deploy. Hotovo – appka je online.

Případně přes CLI:

```bash
npm i -g vercel
vercel
```
