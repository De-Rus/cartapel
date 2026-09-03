import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { TableMeta } from '../../api/types'
import type { FieldConfigData, Json, TableConfigData } from '../../lib/configModel'
import {
  BADGE_COLORS,
  WIDGETS,
  badgeColors,
  isCustomWidget,
  numParam,
  strParam,
  widgetHasStructuredEditor,
  withParam,
} from '../../lib/configModel'
import { useT, type TFn } from '../../lib/i18n'
import { IconChevronDown, IconChevronRight } from '../Icons'
import { KeyValueEditor, Labeled, Toggle } from './parts'
import { ColumnPicker, CODE_LANGS, CURRENCIES, EnumSelect } from './pickers'
import { FieldPreview, sampleValuesFor } from './FieldPreview'
import type { ColumnMeta, Row } from '../../api/types'

function ParamsEditor({
  widget,
  field,
  columns,
  onField,
  t,
}: {
  widget: string
  field: FieldConfigData
  columns: ColumnMeta[]
  onField: (f: FieldConfigData) => void
  t: TFn
}) {
  const params = field.params
  const setParam = (key: string, value: Json) => onField({ ...field, params: withParam(params, key, value) })

  if (widget === 'badge') {
    return (
      <Labeled label={t('cfg_param_colors')}>
        <KeyValueEditor
          entries={badgeColors(params)}
          colorValues={BADGE_COLORS}
          keyPlaceholder={t('cfg_param_add_value')}
          valuePlaceholder=""
          onChange={(colors) =>
            onField({
              ...field,
              params: withParam(params, 'colors', Object.keys(colors).length ? colors : undefined),
            })
          }
        />
      </Labeled>
    )
  }
  if (widget === 'relative_time') {
    return (
      <Labeled label={t('cfg_param_warn_after')}>
        <input
          type="number"
          className="input-sm w-32"
          value={numParam(params, 'warn_after') ?? ''}
          onChange={(e) => setParam('warn_after', e.target.value ? Number(e.target.value) : undefined)}
        />
      </Labeled>
    )
  }
  if (widget === 'money') {
    return (
      <Labeled label={t('cfg_param_currency')}>
        <EnumSelect
          className="w-32"
          value={strParam(params, 'currency')}
          options={CURRENCIES}
          emptyLabel={t('cfg_field_default')}
          ariaLabel={t('cfg_param_currency')}
          onChange={(v) => setParam('currency', v)}
        />
      </Labeled>
    )
  }
  if (widget === 'code') {
    return (
      <Labeled label={t('cfg_param_lang')}>
        <EnumSelect
          className="w-40"
          value={strParam(params, 'lang')}
          options={CODE_LANGS}
          emptyLabel={t('cfg_field_default')}
          ariaLabel={t('cfg_param_lang')}
          onChange={(v) => setParam('lang', v)}
        />
      </Labeled>
    )
  }
  if (widget === 'image' || widget === 'file') {
    // One block backs both: `widget = "image"` is what makes it a photo
    // (decode/resize/re-encode to PNG) — that behaviour lives in `params`,
    // like any other widget's options, not in the upload block itself.
    const file = field.file ?? { dir: '' }
    const setFile = (patch: Partial<typeof file>) => {
      const next = { ...file, ...patch }
      onField({ ...field, file: next.dir || next.name_col ? next : undefined })
    }
    const params = field.params
    const setParam = (key: string, value: Json) => onField({ ...field, params: withParam(params, key, value) })
    return (
      <div className="grid grid-cols-2 gap-2">
        <Labeled label={t('cfg_image_dir')}>
          <input className="input-sm w-full" value={file.dir} onChange={(e) => setFile({ dir: e.target.value })} />
        </Labeled>
        <Labeled label={t('cfg_image_name_col')}>
          <ColumnPicker
            className="w-full"
            columns={columns}
            value={file.name_col || undefined}
            emptyLabel={t('cfg_field_default')}
            ariaLabel={t('cfg_image_name_col')}
            onChange={(v) => setFile({ name_col: v ?? undefined })}
          />
        </Labeled>
        {widget === 'image' && (
          <>
            <Labeled label={t('cfg_image_max_px')}>
              <input
                type="number"
                className="input-sm w-full"
                value={numParam(params, 'max_px') ?? ''}
                onChange={(e) => setParam('max_px', e.target.value ? Number(e.target.value) : undefined)}
              />
            </Labeled>
            <div className="flex items-end">
              <Toggle
                checked={params?.normalize !== false}
                onChange={(v) => setParam('normalize', v)}
                label={t('cfg_image_normalize')}
              />
            </div>
          </>
        )}
      </div>
    )
  }
  return null
}

function AdvancedParams({
  field,
  onField,
  t,
}: {
  field: FieldConfigData
  onField: (f: FieldConfigData) => void
  t: TFn
}) {
  const [text, setText] = useState(() => (field.params ? JSON.stringify(field.params, null, 2) : ''))
  const [err, setErr] = useState<string | null>(null)
  return (
    <Labeled label={t('cfg_param_advanced')}>
      <textarea
        className="input-sm w-full font-mono"
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const raw = e.target.value.trim()
          if (!raw) {
            setErr(null)
            onField({ ...field, params: undefined })
            return
          }
          try {
            const parsed = JSON.parse(raw)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object')
            setErr(null)
            onField({ ...field, params: parsed as Record<string, Json> })
          } catch {
            setErr(t('cfg_param_json_invalid'))
          }
        }}
      />
      {err && <span className="text-xxs text-critical">{err}</span>}
    </Labeled>
  )
}

function FieldRow({
  column,
  columns,
  sampleRows,
  field,
  onField,
  t,
}: {
  column: ColumnMeta
  columns: ColumnMeta[]
  sampleRows: Row[]
  field: FieldConfigData
  onField: (f: FieldConfigData | undefined) => void
  t: TFn
}) {
  const [open, setOpen] = useState(false)
  const name = column.name
  const defaultWidget = column.widget || 'text'
  const widget = field.widget ?? defaultWidget
  const customName = isCustomWidget(widget) ? widget : null
  const configured = Object.keys(field).length > 0
  const sampleValues = useMemo(
    () => sampleValuesFor(column, sampleRows, widget),
    [column, sampleRows, widget],
  )

  const setWidget = (w: string) => {
    if (w === defaultWidget) onField({ ...field, widget: undefined })
    else onField({ ...field, widget: w })
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span className="truncate font-mono text-[13px] text-ink">{name}</span>
          {configured && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
        <span className="shrink-0 text-xxs text-muted">{widget}</span>
      </div>
      {open && (
        <div className="space-y-3 border-t bg-surface2 px-3 py-3">
          <div className="grid grid-cols-2 gap-2">
            <Labeled label={t('cfg_field_widget')}>
              <select
                className="input-sm w-full"
                value={customName ? '__custom__' : widget}
                onChange={(e) => {
                  if (e.target.value === '__custom__') setWidget('custom:')
                  else setWidget(e.target.value)
                }}
              >
                {WIDGETS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                    {w === defaultWidget ? ` (${t('cfg_field_default')})` : ''}
                  </option>
                ))}
                <option value="__custom__">custom:*</option>
              </select>
            </Labeled>
            <Labeled label={t('cfg_field_label')}>
              <input
                className="input-sm w-full"
                value={field.label ?? ''}
                onChange={(e) => onField({ ...field, label: e.target.value || undefined })}
              />
            </Labeled>
          </div>

          {customName !== null && (
            <Labeled label="custom:">
              <input
                className="input-sm w-full font-mono"
                value={customName.slice('custom:'.length)}
                placeholder="sparkline"
                onChange={(e) => setWidget(`custom:${e.target.value}`)}
              />
            </Labeled>
          )}

          <div className="flex flex-wrap gap-2">
            <Toggle
              checked={!!field.readonly}
              onChange={(v) => onField({ ...field, readonly: v || undefined })}
              label={t('cfg_field_readonly')}
            />
            <Toggle
              checked={!!field.masked}
              onChange={(v) => onField({ ...field, masked: v || undefined })}
              label={t('cfg_field_masked')}
            />
          </div>

          {widgetHasStructuredEditor(widget) || widget === 'image' || widget === 'file' ? (
            <ParamsEditor widget={widget} field={field} columns={columns} onField={(f) => onField(f)} t={t} />
          ) : (
            <AdvancedParams field={field} onField={(f) => onField(f)} t={t} />
          )}

          <FieldPreview column={column} widget={widget} params={field.params} sampleValues={sampleValues} />

          {configured && (
            <button
              type="button"
              className={clsx('text-xxs text-muted hover:text-critical')}
              onClick={() => onField(undefined)}
            >
              {t('cfg_remove')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function FieldsEditor({
  meta,
  model,
  sampleRows = [],
  onChange,
}: {
  meta: TableMeta
  model: TableConfigData
  sampleRows?: Row[]
  onChange: (m: TableConfigData) => void
}) {
  const t = useT()
  const fields = model.fields ?? {}

  const setField = (name: string, field: FieldConfigData | undefined) => {
    const next = { ...fields }
    if (!field || Object.keys(field).length === 0) delete next[name]
    else next[name] = field
    onChange({ ...model, fields: Object.keys(next).length ? next : undefined })
  }

  return (
    <div className="space-y-2">
      <div className="text-xxs text-muted">{t('cfg_fields_hint')}</div>
      {meta.columns.map((c) => (
        <FieldRow
          key={c.name}
          column={c}
          columns={meta.columns}
          sampleRows={sampleRows}
          field={fields[c.name] ?? {}}
          onField={(f) => setField(c.name, f)}
          t={t}
        />
      ))}
    </div>
  )
}
