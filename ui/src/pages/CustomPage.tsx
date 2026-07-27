import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMeta } from '../lib/meta'
import { useT } from '../lib/i18n'
import { loadWidgetModule, pageElementName, widgetApi } from '../lib/widgets'

export default function CustomPage() {
  const { '*': id = '' } = useParams()
  const meta = useMeta()
  const t = useT()
  const page = meta.pages?.find((p) => p.id === id)
  const hostRef = useRef<HTMLDivElement>(null)
  const elRef = useRef<HTMLElement | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setFailed(null)
    setReady(false)
    elRef.current = null
    if (!page || !page.module) {
      setFailed(page ? 'module missing' : 'unknown page')
      return
    }
    let cancelled = false
    const tag = pageElementName(page.slug)
    loadWidgetModule(page.module, page.slug)
      .then(() => {
        if (cancelled) return
        if (!customElements.get(tag)) {
          setFailed(`the module defined no <${tag}> — does it call sx.definePage('${page.slug}', …)?`)
          return
        }
        setReady(true)
      })
      .catch((e: unknown) => !cancelled && setFailed(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [page])

  useEffect(() => {
    if (!ready || failed || !page) return
    const host = hostRef.current
    if (!host) return
    const tag = pageElementName(page.slug)
    if (!elRef.current) {
      elRef.current = document.createElement(tag)
      host.replaceChildren(elRef.current)
    }
    const el = elRef.current as HTMLElement & { api?: unknown; params?: unknown }
    el.api = widgetApi
    el.params = {}
  }, [ready, failed, page])

  if (failed !== null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="card max-w-xl space-y-2 px-6 py-4">
          <div className="text-sm text-critical">{t('page_load_failed')}</div>
          <pre className="overflow-auto rounded-ctl bg-page p-2 font-mono text-xxs text-sec">
            {page?.module ? `${page.module}: ${failed}` : failed}
          </pre>
          <div className="text-xxs text-muted">{t('page_load_failed_hint')}</div>
        </div>
      </div>
    )
  }

  return <div ref={hostRef} className="h-full w-full" />
}
