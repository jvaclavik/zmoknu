import { useMemo, type CSSProperties } from "react";

// Skeleton (placeholder) obrazovka místo prázdna při prvním načítání – tvarem
// i rozměry co nejvíc kopíruje reálný layout (souhrn, meteogram, oblečení,
// výhled, sbalené detaily), aby se po donačtení dispozice neposunuly.
// Samotná kostra se neanimuje (žádný shimmer), pohyb dělá jen padající déšť.

export default function Skeleton() {
  // Kapky deště – částečně náhodné: rovnoměrné sloupce s náhodným posunem a
  // náhodným časováním/velikostí. Generujeme jednou při mountu (useMemo), ať to
  // během načítání neposkakuje, ale při každém otevření vypadá trochu jinak.
  const rain = useMemo(() => {
    const n = 26;
    return Array.from({ length: n }, (_, i) => {
      const base = (i / n) * 100;
      const left = Math.min(99, Math.max(0, base + (Math.random() - 0.5) * 9));
      return {
        left,
        delay: Math.random() * 2.4,
        dur: 0.8 + Math.random() * 1.3,
        h: 10 + Math.random() * 22,
        op: 0.3 + Math.random() * 0.45,
      };
    });
  }, []);

  return (
    <main className="content skeleton-main" aria-hidden="true">
      <div className="skel-rain">
        {rain.map((d, i) => (
          <span
            key={i}
            className="skel-raindrop"
            style={
              {
                left: `${d.left}%`,
                height: d.h,
                animationDelay: `${d.delay}s`,
                animationDuration: `${d.dur}s`,
                "--op": d.op,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="col-main skeleton">
        {/* Souhrn dne (SmartSummary): řádek s ikonou + spodní patka */}
        <section className="card">
          <div className="skel-daysum">
            <div className="skel skel-circle sm" />
            <div className="skel-daysum-main">
              <div className="skel skel-line lg" style={{ width: 78 }} />
              <div className="skel skel-line sm" style={{ width: 116 }} />
            </div>
            <div className="skel-daysum-precip">
              <div className="skel skel-line" style={{ width: 62, height: 16 }} />
              <div className="skel skel-line sm" style={{ width: 46 }} />
            </div>
          </div>
          <div className="skel-foot">
            <div className="skel skel-line" style={{ flex: 1 }} />
            <div className="skel skel-line" style={{ width: 92 }} />
            <div className="skel skel-pill" style={{ width: 52, height: 22 }} />
          </div>
        </section>

        {/* Meteogram: hlavička → staty (8 dlaždic) → graf. Pořadí musí odpovídat
            reálné komponentě (staty jsou NAD grafem), jinak layout po načtení skáče. */}
        <section className="card">
          <div className="skel-split">
            <div className="skel-daysum-main">
              <div className="skel skel-line" style={{ width: 96, height: 16 }} />
              <div className="skel skel-line sm" style={{ width: 120 }} />
            </div>
            <div className="skel skel-btn" />
          </div>
          <div className="skel-stats">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="skel skel-stat" key={i} />
            ))}
          </div>
          <div className="skel skel-block" style={{ height: 267 }} />
        </section>

        {/* Co si vzít na sebe: titulek → aktivita → dlaždice → shrnutí → nejlepší okno */}
        <section className="card">
          <div className="skel skel-line" style={{ width: "46%", height: 18 }} />
          <div className="skel-acts">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="skel skel-pill" style={{ width: 82, height: 34 }} key={i} />
            ))}
          </div>
          <div className="skel-wear-grid">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="skel skel-wear-item" key={i} />
            ))}
          </div>
          <div className="skel skel-line" style={{ width: "60%", height: 20 }} />
          <div className="skel skel-block skel-bestwin" />
        </section>

        {/* Výhled (HourlyForecast, výchozí krok 6 h): hlavička + přepínač →
            hlavička sloupců → ~12 dní po 4 řádcích (odpovídá reálné výšce). */}
        <section className="card">
          <div className="skel-split">
            <div className="skel skel-line" style={{ width: 64, height: 18 }} />
            <div className="skel skel-seg" />
          </div>
          <div className="skel-yrhead">
            <div className="skel skel-line sm" style={{ width: 34 }} />
            <span />
            <div className="skel skel-line sm" style={{ width: 44, marginLeft: "auto" }} />
            <div className="skel skel-line sm" style={{ width: 40, marginLeft: "auto" }} />
            <div className="skel skel-line sm" style={{ width: 60, marginLeft: "auto" }} />
          </div>
          <div className="skel-yrlist">
            {Array.from({ length: 12 }).map((_, g) => (
              <div key={g}>
                <div className="skel-dayhead">
                  <div className="skel skel-line sm" style={{ width: 118 }} />
                </div>
                {Array.from({ length: 4 }).map((_, i) => (
                  <div className="skel-yrrow" key={i}>
                    <div className="skel skel-line sm" style={{ width: 46 }} />
                    <div className="skel skel-circle" style={{ width: 26, height: 26 }} />
                    <div className="skel skel-line sm" style={{ width: 40, marginLeft: "auto" }} />
                    <div className="skel skel-line sm" style={{ width: 28, marginLeft: "auto" }} />
                    <div className="skel skel-line sm" style={{ width: 44, marginLeft: "auto" }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* Další detaily (ve výchozím stavu sbalené) – karta bez paddingu, hlavička 14/16 */}
        <section className="card skel-details">
          <div className="skel-details-head">
            <div className="skel skel-line sm" style={{ width: 96 }} />
            <div className="skel-details-peek">
              <div className="skel skel-line sm" style={{ width: 40 }} />
              <div className="skel skel-line sm" style={{ width: 54 }} />
              <div className="skel skel-circle" style={{ width: 18, height: 18 }} />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
