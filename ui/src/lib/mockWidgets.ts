import { pageElementName, widgetElementName } from './widgets'

const registered = new Set<string>()

function defineSparkline() {
  if (customElements.get(widgetElementName('sparkline'))) return
  class SxSparkline extends HTMLElement {
    private _row: Record<string, unknown> = {}
    private _params: Record<string, unknown> = {}
    set row(v: Record<string, unknown>) {
      this._row = v
      this.render()
    }
    set params(v: Record<string, unknown>) {
      this._params = v || {}
      this.render()
    }
    set api(_v: unknown) {}
    connectedCallback() {
      this.render()
    }
    render() {
      const p = this._params as { field?: string; width?: number; height?: number; color?: string }
      const raw = this._row?.[p.field ?? '']
      let pts: number[] = []
      try {
        pts = (Array.isArray(raw) ? raw : JSON.parse((raw as string) || '[]')) as number[]
      } catch {
        pts = []
      }
      pts = pts.map(Number).filter((x) => Number.isFinite(x))
      if (pts.length < 2) {
        this.textContent = '—'
        return
      }
      const w = p.width || 96
      const h = p.height || 24
      const pad = 2
      const min = Math.min(...pts)
      const max = Math.max(...pts)
      const span = max - min || 1
      const step = (w - pad * 2) / (pts.length - 1)
      const d = pts
        .map(
          (v, i) =>
            `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${(
              h -
              pad -
              ((v - min) / span) * (h - pad * 2)
            ).toFixed(1)}`,
        )
        .join(' ')
      const up = pts[pts.length - 1] >= pts[0]
      const color = p.color || (up ? 'var(--good, #0ca30c)' : 'var(--critical, #d03b3b)')
      this.innerHTML =
        `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">` +
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`
    }
  }
  customElements.define(widgetElementName('sparkline'), SxSparkline)
}

function definePage(elementName: string) {
  if (customElements.get(elementName)) return
  class SxMockPage extends HTMLElement {
    set api(_v: unknown) {}
    set params(_v: unknown) {}
    connectedCallback() {
      this.innerHTML =
        `<div style="padding:2rem;color:var(--sec)">` +
        `<h2 style="font-size:18px;color:var(--ink);font-weight:600;margin-bottom:.5rem">Custom page (mock)</h2>` +
        `<p>This full-screen module is served from <code>/admin/static/</code> in production. ` +
        `It mounts <code>&lt;${elementName}&gt;</code> with the <code>api</code> prop.</p></div>`
    }
  }
  customElements.define(elementName, SxMockPage)
}

function defineWidget(elementName: string, name: string) {
  if (customElements.get(elementName)) return
  class SxMockWidget extends HTMLElement {
    set row(_v: unknown) {}
    set params(_v: unknown) {}
    set api(_v: unknown) {}
    connectedCallback() {
      this.innerHTML =
        `<span style="color:var(--sec);font-size:12px" title="mock widget ${name}">${name}</span>`
    }
  }
  customElements.define(elementName, SxMockWidget)
}

const WIDGET_MODULE = /(?:^|\/)config\/widgets\/([^/]+)\.js$/

function stem(moduleFile: string): string {
  return (moduleFile.split('/').pop() ?? moduleFile).replace(/\.js$/, '')
}

export interface MockElement {
  kind: 'widget' | 'page'
  name: string
  tag: string
}

export function mockElement(moduleFile: string): MockElement {
  const widget = WIDGET_MODULE.exec(moduleFile)
  if (widget) {
    const name = widget[1]
    return { kind: 'widget', name, tag: widgetElementName(name) }
  }
  const slug = stem(moduleFile)
  return { kind: 'page', name: slug, tag: pageElementName(slug) }
}

export function registerMockModule(moduleFile: string): void {
  if (registered.has(moduleFile)) return
  registered.add(moduleFile)
  const el = mockElement(moduleFile)
  if (el.kind === 'widget') {
    if (el.name === 'sparkline') defineSparkline()
    else defineWidget(el.tag, el.name)
  } else {
    definePage(el.tag)
  }
}
