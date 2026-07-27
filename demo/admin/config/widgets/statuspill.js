// cartapel custom widget — a colored status pill from a value + mapping.
// Contract: <sx-widget-statuspill>; cartapel sets `row`, `params`, `api`.
// params:
//   field    — column on the row to read (falls back to the whole cell value)
//   map      — { "<value>": "<tone>" | { label, tone } }  (tone: green|red|blue|gray|orange|violet|yellow)
//   fallback — tone (or {label,tone}) used when no key matches; default gray
//   labels   — optional { "<value>": "<label>" } to override the printed text
// Booleans/numbers are matched by their String() form ("true"/"false"/"3").
const TONES = {
  green: "--badge-green", red: "--badge-red", blue: "--badge-blue",
  gray: "--badge-gray", orange: "--badge-orange", violet: "--badge-violet",
  yellow: "--badge-orange",
};
class SxStatusPill extends HTMLElement {
  set row(v) { this._row = v; this.render(); }
  set params(v) { this._params = v || {}; this.render(); }
  set api(v) { this._api = v; }
  connectedCallback() { this.render(); }
  render() {
    const p = this._params || {}, row = this._row || {};
    let val = p.field ? row[p.field] : (row.value !== undefined ? row.value : row);
    const key = val === null || val === undefined ? "" : String(val);
    const map = p.map || {};
    let entry = map[key];
    if (entry === undefined) entry = p.fallback !== undefined ? p.fallback : "gray";
    const tone = typeof entry === "string" ? entry : (entry && entry.tone) || "gray";
    const label =
      (p.labels && p.labels[key]) ||
      (typeof entry === "object" && entry && entry.label) ||
      (key === "" ? "—" : key);
    const cvar = TONES[tone] || "--badge-gray";
    this.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:.35em;` +
      `padding:.12em .55em;border-radius:999px;font-size:.82em;font-weight:600;` +
      `line-height:1.4;white-space:nowrap;` +
      `color:var(${cvar}, #888);` +
      `background:color-mix(in oklab, var(${cvar}, #888) 15%, transparent);` +
      `border:1px solid color-mix(in oklab, var(${cvar}, #888) 35%, transparent)">` +
      `<span style="width:.5em;height:.5em;border-radius:999px;background:var(${cvar}, #888)"></span>` +
      `${this.esc(label)}</span>`;
  }
  esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
}
customElements.define("sx-widget-statuspill", SxStatusPill);
