import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { Row } from '../api/types'
import { useT } from '../lib/i18n'
import { useTable } from '../lib/meta'
import { FieldInput } from '../components/FieldInput'
import { useToast } from '../components/Toast'
import { isEditable } from '../lib/perms'

export default function RowCreate() {
  const { table: tableName } = useParams()
  const table = useTable(tableName)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const t = useT()
  const [draft, setDraft] = useState<Row>({})

  const createMut = useMutation({
    mutationFn: (set: Row) => api.create(table!.name, set),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['list', tableName] })
      toast(t('created'))
      navigate(`/${tableName}/${encodeURIComponent(String(res.row[table!.pk]))}`)
    },
  })

  if (!table) return <div className="p-8 text-center text-muted">{t('unknown_table')}</div>
  if (!table.perms.create) return <Navigate to={`/${table.name}`} replace />

  const fields = table.columns.filter((c) => isEditable(table, c))
  const err = createMut.error
  const errMsg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : null
  // Postgres double-quotes identifiers in constraint messages — match the quoted
  // form so `id` never lights up inside `customer_id`.
  const fieldErr = (name: string) => !!errMsg && errMsg.includes(`"${name}"`)
  const anyFieldErr = fields.some((c) => fieldErr(c.name))

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center gap-2">
        <Link to={`/${table.name}`} className="text-[13px] text-muted hover:text-ink">
          {table.label_plural}
        </Link>
        <span className="text-muted">/</span>
        <h2 className="text-lg font-semibold text-ink">{t('new_record', { label: table.label })}</h2>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          createMut.mutate(draft)
        }}
      >
        <div className="card grid grid-cols-1 gap-x-10 gap-y-4 p-5 md:grid-cols-2">
          {fields.map((col) => {
            const wide = ['json', 'code', 'textarea'].includes(col.widget)
            const hasErr = fieldErr(col.name)
            return (
              <div key={col.name} className={clsx(wide && 'md:col-span-2')}>
                <div className="mb-1 text-xxs font-semibold uppercase tracking-wide text-muted">
                  {col.label ?? col.name}
                  {!col.nullable && <span className="ml-0.5 text-serious">*</span>}
                </div>
                <FieldInput
                  col={col}
                  tableName={table.name}
                  value={draft[col.name]}
                  row={draft}
                  onChange={(v, fkLabel) =>
                    setDraft((d) => ({
                      ...d,
                      [col.name]: v,
                      ...(fkLabel !== undefined ? { [`${col.name}__label`]: fkLabel } : {}),
                    }))
                  }
                />
                {hasErr && <p className="mt-1 text-xxs text-critical">{errMsg}</p>}
              </div>
            )
          })}
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          {errMsg && !anyFieldErr && <span className="text-[13px] text-critical">{errMsg}</span>}
          <Link to={`/${table.name}`} className="btn">
            {t('cancel')}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={createMut.isPending}>
            {createMut.isPending ? t('creating') : t('create')}
          </button>
        </div>
      </form>
    </div>
  )
}
