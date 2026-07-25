import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { TableMeta } from '../../api/types'
import type { DetailConfigData, DetailSectionData, TableConfigData } from '../../lib/configModel'
import { allColumnNames } from '../../lib/configModel'
import { useT } from '../../lib/i18n'
import { IconPlus, IconX } from '../Icons'
import { Labeled, Section, Toggle } from './parts'
import { ColumnMultiSelect, EnumSelect } from './pickers'

const DND = 'application/x-cartapel-field'

function FieldChip({ name, onDragStart }: { name: string; onDragStart: () => void }) {
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND, name)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      className="inline-flex cursor-grab select-none items-center gap-1 rounded-full border px-2.5 py-1 text-xxs font-mono text-sec hover:text-ink"
    >
      <span className="text-muted" aria-hidden>
        ⠿
      </span>
      {name}
    </span>
  )
}

export function DetailEditor({
  meta,
  model,
  onChange,
}: {
  meta: TableMeta
  model: TableConfigData
  onChange: (m: TableConfigData) => void
}) {
  const t = useT()
  const cols = useMemo(() => allColumnNames(meta), [meta])
  const detail: DetailConfigData = model.detail ?? {}
  const sections: DetailSectionData[] = detail.sections ?? []
  const [over, setOver] = useState<number | 'pool' | null>(null)

  const setDetail = (patch: Partial<DetailConfigData>) => {
    const next = { ...detail, ...patch }
    const empty =
      !next.mode &&
      next.columns == null &&
      !next.tabs &&
      !(next.stats && next.stats.length) &&
      !(next.sidebar?.fields && next.sidebar.fields.length) &&
      !(next.sections && next.sections.length)
    onChange({ ...model, detail: empty ? undefined : next })
  }

  const setSections = (next: DetailSectionData[]) => setDetail({ sections: next })

  const assigned = new Set(sections.flatMap((s) => s.fields ?? []))
  const unassigned = cols.filter((c) => !assigned.has(c))

  const moveField = (name: string, toSection: number | 'pool') => {
    let next = sections.map((s) => ({ ...s, fields: (s.fields ?? []).filter((f) => f !== name) }))
    if (typeof toSection === 'number' && next[toSection]) {
      next = next.map((s, i) => (i === toSection ? { ...s, fields: [...(s.fields ?? []), name] } : s))
    }
    setSections(next)
  }

  const addSection = () => setSections([...sections, { title: '', fields: [] }])
  const removeSection = (idx: number) => setSections(sections.filter((_, i) => i !== idx))
  const renameSection = (idx: number, title: string) =>
    setSections(sections.map((s, i) => (i === idx ? { ...s, title } : s)))

  const dropHandlers = (target: number | 'pool') => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DND)) {
        e.preventDefault()
        setOver(target)
      }
    },
    onDragLeave: () => setOver((o) => (o === target ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const name = e.dataTransfer.getData(DND)
      if (name) moveField(name, target)
      setOver(null)
    },
  })

  return (
    <div className="space-y-4">
      <Section title={t('cfg_detail_layout')} hint={t('cfg_detail_layout_hint')}>
        <div className="flex flex-wrap items-end gap-4">
          <Labeled label={t('cfg_detail_mode')}>
            <EnumSelect
              value={detail.mode ?? undefined}
              onChange={(v) => setDetail({ mode: v })}
              emptyLabel={t('cfg_detail_mode_default')}
              ariaLabel={t('cfg_detail_mode')}
              options={[
                { value: 'page', label: t('cfg_detail_mode_page') },
                { value: 'drawer', label: t('cfg_detail_mode_drawer') },
                { value: 'modal', label: t('cfg_detail_mode_modal') },
              ]}
            />
          </Labeled>
          <Labeled label={t('cfg_detail_columns')}>
            <EnumSelect
              value={detail.columns != null ? String(detail.columns) : undefined}
              onChange={(v) => setDetail({ columns: v ? Number(v) : undefined })}
              emptyLabel={t('cfg_detail_columns_default')}
              ariaLabel={t('cfg_detail_columns')}
              options={[
                { value: '1', label: '1' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
              ]}
            />
          </Labeled>
          <Toggle
            checked={!!detail.tabs}
            onChange={(v) => setDetail({ tabs: v || undefined })}
            label={t('cfg_detail_tabs')}
          />
        </div>
      </Section>

      <Section title={t('cfg_detail_stats')} hint={t('cfg_detail_stats_hint')}>
        <ColumnMultiSelect
          columns={meta.columns}
          value={detail.stats ?? []}
          onChange={(v) => setDetail({ stats: v.length ? v : undefined })}
          ariaLabel={t('cfg_detail_stats')}
        />
      </Section>

      <Section
        title={t('cfg_detail_sidebar')}
        hint={t('cfg_detail_sidebar_hint')}
        right={
          <button type="button" className="btn" onClick={addSection}>
            <IconPlus size={13} /> {t('cfg_detail_add_section')}
          </button>
        }
      >
        <ColumnMultiSelect
          columns={meta.columns}
          value={detail.sidebar?.fields ?? []}
          onChange={(v) => setDetail({ sidebar: v.length ? { fields: v } : undefined })}
          placeholder={t('cfg_detail_sidebar_auto')}
          ariaLabel={t('cfg_detail_sidebar')}
        />
      </Section>

      <Section title={t('cfg_detail_sections')} hint={t('cfg_detail_hint')}>
        {sections.length === 0 && <div className="text-xxs text-muted">{t('cfg_detail_empty')}</div>}
        <div className="space-y-2">
          {sections.map((s, idx) => (
            <div
              key={idx}
              {...dropHandlers(idx)}
              className={clsx(
                'card space-y-2 p-2.5 transition-colors',
                over === idx && 'ring-2 ring-accent',
              )}
            >
              <div className="flex items-center gap-2">
                <input
                  className="input-sm flex-1"
                  value={s.title}
                  placeholder={t('cfg_detail_section_title')}
                  onChange={(e) => renameSection(idx, e.target.value)}
                />
                <button
                  type="button"
                  className="p-1 text-muted hover:text-critical"
                  onClick={() => removeSection(idx)}
                  aria-label={t('cfg_remove')}
                >
                  <IconX size={14} />
                </button>
              </div>
              <div className="flex min-h-[32px] flex-wrap gap-1.5 rounded-ctl bg-surface2 p-1.5">
                {(s.fields ?? []).length === 0 && (
                  <span className="px-1 text-xxs text-muted">{t('cfg_detail_unassigned')}…</span>
                )}
                {(s.fields ?? []).map((f) => (
                  <FieldChip key={f} name={f} onDragStart={() => {}} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('cfg_detail_unassigned')}>
        <div
          {...dropHandlers('pool')}
          className={clsx(
            'flex min-h-[44px] flex-wrap gap-1.5 rounded-card border border-dashed p-2 transition-colors',
            over === 'pool' && 'ring-2 ring-accent',
          )}
        >
          {unassigned.map((c) => (
            <FieldChip key={c} name={c} onDragStart={() => {}} />
          ))}
        </div>
      </Section>
    </div>
  )
}
