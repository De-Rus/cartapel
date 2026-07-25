import type { TableConfigData } from '../../lib/configModel'
import type { TableMeta } from '../../api/types'
import { useT } from '../../lib/i18n'
import { Labeled } from './parts'
import { ColumnPicker } from './pickers'
import { GroupSelect } from './GroupSelect'

export function DisplayEditor({
  meta,
  model,
  onChange,
}: {
  meta: TableMeta
  model: TableConfigData
  onChange: (m: TableConfigData) => void
}) {
  const t = useT()
  const set = (patch: Partial<TableConfigData>) => onChange({ ...model, ...patch })
  const setTitle = (title: string) => onChange({ ...model, display: { title: title || undefined } })
  const insertToken = (col: string) => setTitle(`${model.display?.title ?? ''}{${col}}`)

  return (
    <div className="space-y-4">
      <Labeled label={t('cfg_display_title')}>
        <div className="flex gap-1.5">
          <input
            className="input-sm w-full font-mono"
            value={model.display?.title ?? ''}
            placeholder="{symbol} · {exchange}"
            onChange={(e) => setTitle(e.target.value)}
          />
          <ColumnPicker
            className="shrink-0"
            columns={meta.columns}
            value={undefined}
            emptyLabel={t('cfg_display_insert_col')}
            ariaLabel={t('cfg_display_insert_col')}
            onChange={(v) => v && insertToken(v)}
          />
        </div>
        <span className="text-xxs text-muted">{t('cfg_display_title_hint')}</span>
      </Labeled>

      <div className="grid grid-cols-2 gap-4">
        <Labeled label={t('cfg_display_label')}>
          <input
            className="input-sm w-full"
            value={model.label ?? ''}
            onChange={(e) => set({ label: e.target.value || undefined })}
          />
        </Labeled>
        <Labeled label={t('cfg_display_label_plural')}>
          <input
            className="input-sm w-full"
            value={model.label_plural ?? ''}
            onChange={(e) => set({ label_plural: e.target.value || undefined })}
          />
        </Labeled>
      </div>

      <GroupSelect table={meta.name} />
    </div>
  )
}
