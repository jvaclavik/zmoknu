// Skeleton (placeholder) obrazovka místo prázdna při prvním načítání – tvarem
// i výškou co nejvíc kopíruje reálný layout (souhrn, meteogram, oblečení,
// hodinovka, sbalené detaily), aby se po donačtení dispozice neposunuly.
export default function Skeleton() {
  return (
    <main className="content" aria-hidden="true">
      <div className="col-main skeleton">
        {/* Souhrn dne (SmartSummary) */}
        <section className="card">
          <div className="skel-daysum">
            <div className="skel skel-circle sm" />
            <div className="skel-daysum-main">
              <div className="skel skel-line lg" style={{ width: 92 }} />
              <div className="skel skel-line sm" style={{ width: 128 }} />
            </div>
            <div className="skel-daysum-precip">
              <div className="skel skel-line sm" style={{ width: 58 }} />
              <div className="skel skel-line sm" style={{ width: 44 }} />
            </div>
          </div>
          <div className="skel-foot">
            <div
              className="skel skel-pill"
              style={{ width: 54, height: 22 }}
            />
            <div className="skel skel-line" style={{ flex: 1 }} />
            <div className="skel skel-line" style={{ width: 116 }} />
          </div>
        </section>

        {/* Meteogram */}
        <section className="card">
          <div className="skel-split">
            <div className="skel-daysum-main">
              <div className="skel skel-line" style={{ width: 104 }} />
              <div className="skel skel-line sm" style={{ width: 74 }} />
            </div>
            <div className="skel skel-circle xs" />
          </div>
          <div className="skel-stats">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="skel skel-stat" key={i} />
            ))}
          </div>
          <div className="skel skel-block" style={{ height: 250 }} />
        </section>

        {/* Co si vzít na sebe */}
        <section className="card">
          <div className="skel skel-line" style={{ width: "42%" }} />
          <div className="skel-pills">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="skel skel-pill" style={{ width: 74 }} key={i} />
            ))}
          </div>
          <div className="skel-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="skel skel-tile" key={i} />
            ))}
          </div>
          <div className="skel skel-line sm" style={{ width: "60%" }} />
        </section>

        {/* Hodinová předpověď */}
        <section className="card">
          <div className="skel skel-line sm" style={{ width: "30%" }} />
          <div className="skel-hours">
            {Array.from({ length: 10 }).map((_, i) => (
              <div className="skel skel-hour" key={i} />
            ))}
          </div>
        </section>

        {/* Další detaily (ve výchozím stavu sbalené) */}
        <section className="card">
          <div className="skel-split">
            <div className="skel skel-line" style={{ width: "28%" }} />
            <div className="skel skel-circle xs" />
          </div>
        </section>
      </div>
    </main>
  );
}
