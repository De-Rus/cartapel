import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../api/client'
import type { GroupLayoutBody } from '../../api/types'
import { useT } from '../../lib/i18n'
import { useToast } from '../Toast'
import { Labeled } from './parts'

const UNGROUPED = '__ungrouped__'

export function GroupSelect({ table }: { table: string }) {
  const t = useT()
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['groups'], queryFn: api.groups })

  const move = useMutation({
    mutationFn: (body: GroupLayoutBody) => api.putGroupLayout(body),
    onSuccess: () => {
      toast(t('cfg_group_moved'))
      void qc.invalidateQueries({ queryKey: ['groups'] })
      void qc.invalidateQueries({ queryKey: ['meta'] })
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error')),
  })

  if (!data || !data.writable || data.groups.length === 0) return null

  const current = data.groups.find((g) => g.tables.includes(table))?.slug ?? UNGROUPED

  const onMove = (dest: string) => {
    if (dest === current) return
    move.mutate({
      groups: data.groups.map((g) => ({
        slug: g.slug,
        tables: [
          ...g.tables.filter((x) => x !== table),
          ...(g.slug === dest ? [table] : []),
        ],
      })),
      ungrouped: [
        ...data.ungrouped.filter((x) => x !== table),
        ...(dest === UNGROUPED ? [table] : []),
      ],
    })
  }

  return (
    <Labeled label={t('cfg_group')}>
      <select
        className="input-sm w-full"
        value={current}
        disabled={move.isPending}
        onChange={(e) => onMove(e.target.value)}
      >
        <option value={UNGROUPED}>{t('cfg_group_none')}</option>
        {data.groups.map((g) => (
          <option key={g.slug} value={g.slug}>
            {g.label}
          </option>
        ))}
      </select>
      <span className="text-xxs text-muted">{t('cfg_group_hint')}</span>
    </Labeled>
  )
}
