// cartapel custom widget — a tiny inline sparkline.
// Contract: define a <sx-widget-{name}> custom element. cartapel mounts it and
// sets three properties: `row` (the record), `params` (from the field config),
// and `api` (a fetch helper bound to the panel's base path + auth cookie).
// The element re-renders on property change. Keep it dependency-free.
class SxSparkline extends HTMLElement {
  static get observedAttributes() { return []; }
  set row(v) { this._row = v; this.render(); }
  set params(v) { this._params = v || {}; this.render(); }
  set api(v) { this._api = v; }
  connectedCallback() { this.render(); }
  render() {
    const p = this._params || {};
    const raw = (this._row || {})[p.field];
    let pts = [];
    try { pts = Array.isArray(raw) ? raw : JSON.parse(raw || "[]"); } catch { pts = []; }
    pts = pts.map(Number).filter((x) => Number.isFinite(x));
    if (pts.length < 2) { this.textContent = "—"; return; }
    const w = p.width || 96, h = p.height || 24, pad = 2;
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    const step = (w - pad * 2) / (pts.length - 1);
    const d = pts
      .map((v, i) => `${i ? "L" : "M"}${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
      .join(" ");
    const up = pts[pts.length - 1] >= pts[0];
    const color = p.color || (up ? "var(--good, #0ca30c)" : "var(--critical, #d03b3b)");
    this.innerHTML =
      `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">` +
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
}
customElements.define("sx-widget-sparkline", SxSparkline);
