import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { RoleInfo, RolesResponse, RoleSource } from '../api/types'
import {
  definitionToMatrix,
  flattenDefinition,
  matrixToDefinition,
  validateRoleName,
  type MatrixModel,
} from '../lib/access'
import { interpretPut } from '../lib/configModel'
import { interpolate } from '../lib/format'
import { useT } from '../lib/i18n'
import { useMeta } from '../lib/meta'
import { Modal } from '../components/Modal'
import { Sheet } from '../components/Sheet'
import { PermissionMatrix } from '../components/PermissionMatrix'
import { useToast } from '../components/Toast'
import { IconPlus, IconShield, IconTrash } from '../components/Icons'

const SOURCE_CLS: Record<RoleSource, string> = {
  builtin: 'text-serious',
  config: 'text-good',
}
const SOURCE_KEY: Record<RoleSource, string> = {
  builtin: 'source_builtin',
  config: 'source_config',
}

function SourceTag({ source }: { source: RoleSource }) {
  const t = useT()
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-px text-xxs font-medium',
        SOURCE_CLS[source],
      )}
    >
      {t(SOURCE_KEY[source])}
    </span>
  )
}

function RoleEditor({
  role,
  vocab,
  onClose,
  onSaved,
}: {
  role: RoleInfo
  vocab: RolesResponse
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const t = useT()
  const meta = useMeta()
  const isNew = role.name === ''
  const editable = role.editable
  const [name, setName] = useState(role.name)
  const [model, setModel] = useState<MatrixModel>(() => definitionToMatrix(role.definition, vocab.tables))
  const [showEffective, setShowEffective] = useState(false)
  const effectiveModel = useMemo(() => {
    if (!showEffective) return null
    const byName = new Map(vocab.roles.map((r) => [r.name, r.definition]))
    byName.set(role.name || '(new)', matrixToDefinition(model))
    return definitionToMatrix(flattenDefinition(role.name || '(new)', byName), vocab.tables)
  }, [showEffective, model, role.name, vocab])
  const [nameError, setNameError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const columnsFor = useMemo(() => {
    const byTable = new Map(meta.tables.map((tb) => [tb.name, tb.columns.map((c) => c.name)]))
    return (table: string) => byTable.get(table) ?? []
  }, [meta.tables])

  const mut = useMutation({
    mutationFn: async () => {
      const definition = matrixToDefinition(model)
      if (isNew) {
        const err = validateRoleName(name)
        if (err) {
          setNameError(t(err))
          throw new Error('__validation__')
        }
        return api.createRole({ name: name.trim(), definition })
      }
      return api.updateRole(role.name, definition)
    },
    onSuccess: (res) => {
      if (interpretPut(res).kind === 'applied') {
        onSaved(isNew ? t('role_created') : t('role_updated'))
      } else {
        setServerError(t('cfg_readonly_title'))
      }
    },
    onError: (e) => {
      if (e instanceof Error && e.message === '__validation__') return
      setServerError(e instanceof ApiError ? e.message : String(e))
    },
  })

  const title = isNew ? t('new_role') : editable ? t('edit_role') : role.name

  return (
    <Sheet title={title} onClose={onClose} width={620}>
      <div className="space-y-4">
        {isNew ? (
          <label className="block">
            <span className="mb-1 block text-[13px] text-sec">{t('role_name')}</span>
            <input
              className="input w-full font-mono"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && <p className="mt-1 text-xxs text-critical">{nameError}</p>}
          </label>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[15px] font-semibold text-ink">{role.name}</span>
            <SourceTag source={role.source} />
          </div>
        )}

        {!editable && !isNew && (
          <div className="rounded-card border border-dashed px-3 py-2 text-[13px] text-muted">
            {role.source === 'builtin' ? t('source_builtin_note') : t('source_config_note')}
          </div>
        )}

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={model.customize ?? false}
            disabled={!(editable || isNew)}
            onChange={(e) => setModel({ ...model, customize: e.target.checked || undefined })}
          />
          <span className="text-[13px] text-sec">{t('role_customize')}</span>
          <span className="text-xxs text-muted">{t('role_customize_hint')}</span>
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] text-sec">{t('role_extends')}</span>
          <select
            className="input-sm w-full"
            value={model.extends ?? ''}
            disabled={!(editable || isNew)}
            onChange={(e) => setModel({ ...model, extends: e.target.value || undefined })}
          >
            <option value="">{t('role_extends_none')}</option>
            {vocab.roles
              .filter((r) => r.source === 'config' && r.name !== role.name)
              .map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
          </select>
          <span className="text-xxs text-muted">{t('role_extends_hint')}</span>
          {model.extends && (
            <button
              type="button"
              className={clsx(
                'mt-1.5 rounded-full border px-2 py-0.5 text-xxs',
                showEffective ? 'border-accent text-ink' : 'text-muted hover:text-ink',
              )}
              onClick={() => setShowEffective(!showEffective)}
            >
              {showEffective ? t('role_effective_on') : t('role_effective_off')}
            </button>
          )}
        </label>

        <PermissionMatrix
          model={effectiveModel ?? model}
          actions={vocab.actions}
          columnsFor={columnsFor}
          onChange={effectiveModel ? undefined : editable || isNew ? setModel : undefined}
        />

        {serverError && <p className="text-[13px] text-critical">{serverError}</p>}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          {t('cancel')}
        </button>
        {(editable || isNew) && (
          <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? t('saving') : t('save')}
          </button>
        )}
      </div>
    </Sheet>
  )
}

function DeleteRoleModal({
  role,
  onClose,
  onDeleted,
}: {
  role: RoleInfo
  onClose: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation({
    mutationFn: () => api.deleteRole(role.name),
    onSuccess: (res) => {
      if (interpretPut(res).kind === 'applied') onDeleted()
      else setError(t('cfg_readonly_title'))
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  })
  return (
    <Modal title={t('delete')} onClose={onClose}>
      <p className="text-sm text-sec">{interpolate(t('delete_role_confirm'), { name: role.name })}</p>
      {role.user_count > 0 && (
        <p className="mt-2 text-[13px] text-serious">
          {role.user_count === 1 ? t('role_in_use_one') : interpolate(t('role_in_use'), { count: role.user_count })}
        </p>
      )}
      {error && <p className="mt-3 text-[13px] text-critical">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          {t('cancel')}
        </button>
        <button className="btn btn-danger" onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? t('deleting') : t('delete')}
        </button>
      </div>
    </Modal>
  )
}

const EMPTY_ROLE: RoleInfo = {
  name: '',
  source: 'config',
  editable: true,
  definition: null,
  user_count: 0,
}

export default function AccessRoles() {
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()

  const { data, isLoading, error } = useQuery({ queryKey: ['access-roles'], queryFn: api.roles })

  const [editor, setEditor] = useState<RoleInfo | null>(null)
  const [deleting, setDeleting] = useState<RoleInfo | null>(null)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['access-roles'] })
    void qc.invalidateQueries({ queryKey: ['meta'] })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start gap-3">
        <IconShield size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{t('access_roles')}</h1>
          <p className="text-[13px] text-muted">{t('access_roles_subtitle')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditor(EMPTY_ROLE)}>
          <IconPlus size={14} /> {t('new_role')}
        </button>
      </div>

      {isLoading && <div className="card px-4 py-10 text-center text-muted">{t('loading')}</div>}
      {error && (
        <div className="card px-4 py-10 text-center text-critical">
          {error instanceof Error ? error.message : t('error')}
        </div>
      )}
      {data?.roles.length === 0 && (
        <div className="card px-4 py-10 text-center text-muted">{t('roles_empty')}</div>
      )}

      <div className="space-y-2">
        {data?.roles.map((r) => (
          <button
            key={r.name}
            type="button"
            onClick={() => setEditor(r)}
            className="card flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover"
          >
            <span className="font-mono text-[14px] font-medium text-ink">{r.name}</span>
            <SourceTag source={r.source} />
            <div className="flex-1" />
            <span className="text-xxs tabular-nums text-muted">
              {r.user_count} {t('col_users').toLowerCase()}
            </span>
            {r.editable && (
              <span
                role="button"
                tabIndex={0}
                className="rounded-ctl px-1.5 py-1 text-muted hover:bg-surface3 hover:text-critical"
                aria-label={t('delete')}
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleting(r)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    setDeleting(r)
                  }
                }}
              >
                <IconTrash size={14} />
              </span>
            )}
          </button>
        ))}
      </div>

      {editor && data && (
        <RoleEditor
          role={editor}
          vocab={data}
          onClose={() => setEditor(null)}
          onSaved={(msg) => {
            setEditor(null)
            toast(msg)
            refresh()
          }}
        />
      )}
      {deleting && (
        <DeleteRoleModal
          role={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            toast(t('role_deleted'))
            refresh()
          }}
        />
      )}
    </div>
  )
}
