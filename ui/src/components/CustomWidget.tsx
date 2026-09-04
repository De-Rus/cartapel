import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { Row } from '../api/types'
import {
  loadWidgetModule,
  widgetApi,
  widgetElementName,
} from '../lib/widgets'

export function CustomWidget({
  name,
  row,
  params,
  fallback,
  mode,
  value,
  onChange,
}: {
  name: string
  row: Row
  params: Record<string, unknown>
  fallback: React.ReactNode
  mode: 'list' | 'detail'
  /** The field's own current value — set on every render, editable or not. */
  value?: unknown
  /** Present only when the widget is rendered in an editable context (a
   *  field being edited, never a plain list/detail cell). A widget calls
   *  this to report a new value; its absence is how a widget tells edit
   *  and display apart — `if (this.onChange) { … }` — since the same
   *  element renders in both. */
  onChange?: (value: unknown) => void
}) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const elRef = useRef<HTMLElement | null>(null)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const tag = widgetElementName(name)
    loadWidgetModule(`config/widgets/${name}.js`)
      .then(() => customElements.whenDefined(tag))
      .then(() => {
        if (cancelled) return
        if (!customElements.get(tag)) {
          setFailed(true)
          return
        }
        setReady(true)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [name])

  useEffect(() => {
    if (!ready || failed) return
    const host = hostRef.current
    if (!host) return
    const tag = widgetElementName(name)
    if (!elRef.current) {
      elRef.current = document.createElement(tag)
      host.appendChild(elRef.current)
    }
    const el = elRef.current as HTMLElement & {
      row?: unknown
      params?: unknown
      api?: unknown
      value?: unknown
      onChange?: (value: unknown) => void
    }
    el.api = widgetApi
    el.params = params
    el.row = row
    el.value = value
    el.onChange = onChange
  }, [ready, failed, name, row, params, value, onChange])

  if (failed) return <>{fallback}</>

  return (
    <span
      ref={hostRef}
      className={clsx('inline-flex items-center', mode === 'list' && 'max-h-8 overflow-hidden')}
    />
  )
}
