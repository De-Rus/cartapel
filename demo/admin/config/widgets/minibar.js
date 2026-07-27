// cartapel custom widget — a tiny horizontal magnitude bar for a count / 0..1 value.
// Contract: <sx-widget-minibar>; cartapel sets `row`, `params`, `api`.
// params:
//   field  — column on the row to read (falls back to the whole cell value)
//   max    — full-scale value; the fill is value/max, clamped to [0,1]. Default 100.
//   width  — px, default 84
//   color  — CSS color for the fill; default the accent. Pass a `warn` above `warn_at`.
//   warn_at, warn_color — turn the fill to warn_color once value >= warn_at.
//   suffix — appended to the printed number (e.g. "%").
class SxMiniBar extends HTMLElement {
  set row(v) { this._row = v; this.render(); }
  set params(v) { this._params = v || {}; this.render(); }
  set api(v) { this._api = v; }
  connectedCallback() { this.render(); }
  render() {
    const p = this._params || {}, row = this._row || {};
    const raw = p.field ? row[p.field] : (row.value !== undefined ? row.value : row);
    const val = Number(raw);
    if (!Number.isFinite(val)) { this.textContent = "—"; return; }
    const max = Number(p.max) || 100;
    const pct = Math.max(0, Math.min(1, val / max));
    const w = Number(p.width) || 84, h = 8;
    let color = p.color || "var(--accent, #4a7)";
    if (p.warn_at !== undefined && val >= Number(p.warn_at)) color = p.warn_color || "var(--badge-red, #d03b3b)";
    const num = Number.isInteger(val) ? String(val) : val.toFixed(2);
    this.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:.5em">` +
      `<span style="position:relative;width:${w}px;height:${h}px;border-radius:999px;` +
      `background:var(--surface-3, rgba(128,128,128,.18));overflow:hidden;flex:0 0 auto">` +
      `<span style="position:absolute;inset:0 auto 0 0;width:${(pct * 100).toFixed(1)}%;` +
      `background:${color};border-radius:999px"></span></span>` +
      `<span style="font-variant-numeric:tabular-nums;font-size:.85em;color:var(--sec, #999)">` +
      `${num}${p.suffix ? this.esc(p.suffix) : ""}</span></span>`;
  }
  esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
}
customElements.define("sx-widget-minibar", SxMiniBar);
