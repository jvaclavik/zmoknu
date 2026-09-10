import { useMemo, type CSSProperties } from "react";

// Placeholder při přenačtení (změna lokality). První start drží HTML #boot
// v index.html – tenhle skeleton se nesmí opírat o classy ostrých karet,
// jinak ho globální layout (mřížky, záporné marginy) rozpadne.

export default function Skeleton() {
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
      <div className="skeleton">
        <section className="card skel-hero">
          <div className="skel skel-hero-icon" />
          <div className="skel-hero-body">
            <div className="skel skel-hero-now" />
            <div className="skel-hero-line">
              <div className="skel skel-line" style={{ width: 168, height: 14 }} />
            </div>
            <div className="skel-hero-facts">
              <div className="skel-hero-scale">
                <div className="skel skel-line sm" style={{ width: 28 }} />
                <div className="skel skel-hero-track" />
                <div className="skel skel-line sm" style={{ width: 28 }} />
              </div>
              <div className="skel-hero-rest">
                <div className="skel skel-line sm" style={{ width: 108 }} />
                <div className="skel skel-line sm" style={{ width: 40 }} />
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="skel-split" style={{ marginBottom: 10 }}>
            <div className="skel skel-line" style={{ width: 96, height: 12 }} />
            <div className="skel skel-btn" />
          </div>
          <div className="skel-stats">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="skel skel-stat" key={i} />
            ))}
          </div>
          <div className="skel skel-typeinfo" />
          <div className="skel skel-block skel-mg-plot" />
        </section>

        <section className="card skel-has-more">
          <div className="skel-split" style={{ marginBottom: 14 }}>
            <div className="skel skel-line" style={{ width: "46%", height: 12 }} />
            <div className="skel skel-how" />
          </div>
          <div className="skel-acts">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="skel skel-pill" style={{ width: 82, height: 28 }} key={i} />
            ))}
          </div>
          <div className="skel-wear-grid">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="skel skel-wear-item" key={i} />
            ))}
          </div>
          <div className="skel skel-block skel-bestwin" />
        </section>

        <section className="card skel-has-more">
          <div className="skel-split" style={{ marginBottom: 10 }}>
            <div className="skel skel-line" style={{ width: 64, height: 12 }} />
            <div className="skel skel-btn" />
          </div>
          <div className="skel-yrhead">
            <span className="skel skel-line sm" style={{ width: 34 }} />
            <span />
            <span className="skel skel-line sm skel-end" style={{ width: 44 }} />
            <span className="skel skel-line sm skel-end" style={{ width: 40 }} />
            <span className="skel skel-line sm skel-end" style={{ width: 48 }} />
            <span />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="skel-yrrow" key={i}>
              <span className="skel skel-line sm" style={{ width: 88 }} />
              <span className="skel-yricon">
                <span
                  className="skel skel-circle skel-yricon-solo"
                  style={{ width: 24, height: 24 }}
                />
                {Array.from({ length: 4 }).map((__, j) => (
                  <span
                    className="skel skel-circle"
                    style={{ width: 24, height: 24 }}
                    key={j}
                  />
                ))}
              </span>
              <span className="skel skel-line sm skel-end" style={{ width: 40 }} />
              <span className="skel skel-line sm skel-end" style={{ width: 28 }} />
              <span className="skel skel-line sm skel-end" style={{ width: 36 }} />
              <span className="skel skel-circle" style={{ width: 14, height: 14 }} />
            </div>
          ))}
        </section>

        <section className="card skel-details">
          <div className="skel-details-head">
            <div className="skel skel-line sm" style={{ width: 96 }} />
            <div
              className="skel skel-circle"
              style={{ width: 18, height: 18, marginLeft: "auto" }}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
