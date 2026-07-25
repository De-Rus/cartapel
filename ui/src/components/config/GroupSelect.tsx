import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../api/client'
import type { GroupsLayout } from '../../api/types'
import { useT } from '../../lib/i18n'
import { useToast } from '../Toast'
import { Labeled } from './parts'

const UNGROUPED = '__ungrouped__'

function layoutMoving(layout: GroupsLayout, table: string, dest: string) {
  return {
    groups: layout.groups.map((g) => ({
      slug: g.slug,
      tables: [
        ...g.tables.filter((x) => x !== table),
        ...(g.slug === dest ? [table] : []),
      ],
    })),
    ungrouped: [
      ...layout.ungrouped.filter((x) => x !== table),
      ...(dest === UNGROUPED ? [table] : []),
    ],
  }
}

export function GroupSelect({ table }: { table: string }) {
  const t = useT()
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['groups'], queryFn: api.groups })

  const move = useMutation({
    mutationFn: async (dest: string) => {
      // Recompute from a fresh layout so a stale snapshot can't revert moves
      // made elsewhere while this dialog sat open.
      const fresh = await qc.fetchQuery({ queryKey: ['groups'], queryFn: api.groups })
      return api.putGroupLayout(layoutMoving(fresh, table, dest))
    },
    onSuccess: () => {
      toast(t('cfg_group_moved'))
      void qc.invalidateQueries({ queryKey: ['groups'] })
      void qc.invalidateQueries({ queryKey: ['meta'] })
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : t('error'))
      void qc.invalidateQueries({ queryKey: ['groups'] })
    },
  })

  if (!data || !data.writable || data.groups.length === 0) return null
  if (data.unconfigured.includes(table)) return null

  const current = data.groups.find((g) => g.tables.includes(table))?.slug ?? UNGROUPED

  return (
    <Labeled label={t('cfg_group')}>
      <select
        className="input-sm w-full"
        value={current}
        disabled={move.isPending}
        onChange={(e) => {
          if (e.target.value !== current) move.mutate(e.target.value)
        }}
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
