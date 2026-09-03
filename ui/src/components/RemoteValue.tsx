import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useT } from '../lib/i18n'

/** Fetches a `remote { }` field's value from `/t/:table/remote/:col/:pk` —
 *  never present in the row payload — and hands it to `children` once it
 *  lands, so the caller renders it with whatever widget the field declares
 *  (badge, money, date, plain text…) instead of this component hardcoding
 *  one presentation.
 *
 *  `auto` (default: everywhere except a `remote { lazy = true }` field in a
 *  list) fetches on mount; otherwise it waits for a click, since a list can
 *  put dozens of rows on screen at once and `lazy` opts out of firing one
 *  outbound request per visible row for free. */
export function RemoteGate({
  table,
  col,
  pk,
  auto = false,
  children,
}: {
  table: string
  col: string
  pk: string
  auto?: boolean
  children: (value: unknown) => React.ReactNode
}) {
  const t = useT()
  const [armed, setArmed] = useState(auto)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['remote', table, col, pk],
    queryFn: () => api.remote(table, col, pk),
    enabled: armed,
    staleTime: 30_000,
  })

  if (!armed) {
    return (
      <button
        type="button"
        className="text-muted hover:text-accent hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          setArmed(true)
        }}
      >
        {t('remote_load')}
      </button>
    )
  }
  if (isLoading) return <span className="text-muted">{t('remote_loading')}</span>
  if (isError) return <span className="text-critical">{t('remote_error')}</span>
  return <>{children(data?.value)}</>
}
