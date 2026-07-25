import { useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api/client'
import type { AccessUser } from '../api/types'
import { validateUserPayload } from '../lib/access'
import { fmtDateTime, interpolate } from '../lib/format'
import { useT } from '../lib/i18n'
import { useMeta } from '../lib/meta'
import { Badge } from '../components/CellValue'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { IconPlus, IconTrash, IconUsers } from '../components/Icons'

const ROLE_COLORS: Record<string, string> = { admin: 'red' }
function roleColors(role: string): Record<string, string> {
  return { [role]: ROLE_COLORS[role] ?? 'gray' }
}

function fieldError(t: ReturnType<typeof useT>, key?: string): string | null {
  return key ? t(key) : null
}

function UserModal({
  editing,
  roles,
  onClose,
  onSaved,
}: {
  editing: AccessUser | null
  roles: string[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const t = useT()
  const isEdit = !!editing
  const [email, setEmail] = useState(editing?.email ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(editing?.role ?? roles[0] ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: async () => {
      const v = validateUserPayload({ email, password, role }, roles, { requirePassword: !isEdit })
      if (!v.ok) {
        setErrors(v.errors as Record<string, string>)
        throw new Error('__validation__')
      }
      setErrors({})
      if (isEdit) {
        const body: { role?: string; password?: string } = {}
        if (role !== editing!.role) body.role = role
        if (password) body.password = password
        return api.updateUser(editing!.id, body)
      }
      return api.createUser({ email: v.value.email, password, role })
    },
    onSuccess: () => onSaved(isEdit ? t('user_updated') : t('user_created')),
    onError: (e) => {
      if (e instanceof Error && e.message === '__validation__') return
      setServerError(e instanceof ApiError ? e.message : String(e))
    },
  })

  return (
    <Modal title={isEdit ? t('edit_user') : t('new_user')} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[13px] text-sec">{t('col_email')}</span>
          <input
            className="input w-full"
            type="email"
            value={email}
            disabled={isEdit}
            autoFocus={!isEdit}
            onChange={(e) => setEmail(e.target.value)}
          />
          {errors.email && <p className="mt-1 text-xxs text-critical">{fieldError(t, errors.email)}</p>}
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] text-sec">
            {isEdit ? t('user_password_reset') : t('user_password')}
          </span>
          <input
            className="input w-full"
            type="password"
            value={password}
            placeholder={isEdit ? t('user_password_reset_hint') : t('user_password_placeholder')}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {errors.password && <p className="mt-1 text-xxs text-critical">{fieldError(t, errors.password)}</p>}
        </label>

        <div>
          <span className="mb-1 block text-[13px] text-sec">{t('col_role')}</span>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((r) => {
              const parts = role.split(',').map((x) => x.trim()).filter(Boolean)
              const on = parts.includes(r)
              return (
                <button
                  key={r}
                  type="button"
                  className={clsx(
                    'rounded-full border px-2.5 py-1 text-xxs',
                    on ? 'border-accent bg-selected text-ink' : 'text-sec hover:text-ink',
                  )}
                  onClick={() => {
                    const next = on ? parts.filter((x) => x !== r) : [...parts, r]
                    setRole(next.join(','))
                  }}
                >
                  {r}
                </button>
              )
            })}
          </div>
          <span className="mt-1 block text-xxs text-muted">{t('user_roles_hint')}</span>
          {errors.role && <p className="mt-1 text-xxs text-critical">{fieldError(t, errors.role)}</p>}
        </div>

        {serverError && <p className="text-[13px] text-critical">{serverError}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          {t('cancel')}
        </button>
        <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? t('saving') : t('save')}
        </button>
      </div>
    </Modal>
  )
}

function DeleteUserModal({
  user,
  onClose,
  onDeleted,
}: {
  user: AccessUser
  onClose: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: onDeleted,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  })
  return (
    <Modal title={t('delete')} onClose={onClose}>
      <p className="text-sm text-sec">{interpolate(t('delete_user_confirm'), { email: user.email })}</p>
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

export default function AccessUsers() {
  const t = useT()
  const meta = useMeta()
  const qc = useQueryClient()
  const toast = useToast()
  const roles = meta.roles ?? []

  const { data, isLoading, error } = useQuery({ queryKey: ['access-users'], queryFn: api.users })

  const [modal, setModal] = useState<{ kind: 'edit'; user: AccessUser | null } | { kind: 'delete'; user: AccessUser } | null>(
    null,
  )

  const refresh = () => qc.invalidateQueries({ queryKey: ['access-users'] })

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start gap-3">
        <IconUsers size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{t('access_users')}</h1>
          <p className="text-[13px] text-muted">{t('access_users_subtitle')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'edit', user: null })}>
          <IconPlus size={14} /> {t('new_user')}
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xxs font-semibold uppercase tracking-wide text-muted">
              <th className="px-3 py-2">{t('col_email')}</th>
              <th className="px-3 py-2">{t('col_role')}</th>
              <th className="px-3 py-2">{t('col_created')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted">
                  {t('loading')}
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-critical">
                  {error instanceof Error ? error.message : t('error')}
                </td>
              </tr>
            )}
            {data?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted">
                  {t('users_empty')}
                </td>
              </tr>
            )}
            {data?.map((u) => (
              <tr key={u.id} className="border-t hover:bg-hover">
                <td className="px-3 py-2 font-medium text-ink">{u.email}</td>
                <td className="px-3 py-2">
                  <Badge value={u.role} colors={roleColors(u.role)} />
                </td>
                <td className="px-3 py-2 tabular-nums text-sec">{fmtDateTime(u.created_at)}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <button
                      className="rounded-ctl px-2 py-1 text-xxs text-sec hover:bg-hover hover:text-ink"
                      onClick={() => setModal({ kind: 'edit', user: u })}
                    >
                      {t('edit')}
                    </button>
                    <button
                      className="rounded-ctl px-2 py-1 text-muted hover:bg-hover hover:text-critical"
                      aria-label={t('delete')}
                      onClick={() => setModal({ kind: 'delete', user: u })}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal?.kind === 'edit' && (
        <UserModal
          editing={modal.user}
          roles={roles}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null)
            toast(msg)
            refresh()
          }}
        />
      )}
      {modal?.kind === 'delete' && (
        <DeleteUserModal
          user={modal.user}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null)
            toast(t('user_deleted'))
            refresh()
          }}
        />
      )}
    </div>
  )
}
