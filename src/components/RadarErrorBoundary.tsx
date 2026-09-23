import { Component, type ReactNode } from "react";
import { tr } from "../lib/i18n";

export default class RadarErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <section className="card radar-card radar-fullscreen">
          <div className="radar-map">
            <div className="radar-loading">{tr("Radar není k dispozici")}</div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
