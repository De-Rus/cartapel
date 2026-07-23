import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { makeT } from '../lib/i18n'
import { pickBrandLogo } from '../lib/brand'
import { useIsDark } from '../lib/theme'
import { applyThemeConfig } from '../lib/themes'
import { BrandMark } from '../components/Shell'

export default function Login() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data: meta } = useQuery({
    queryKey: ['branding-public'],
    queryFn: api.branding,
    retry: false,
    staleTime: Infinity,
  })

  const t = useMemo(() => makeT(meta?.locale, meta?.strings), [meta?.locale, meta?.strings])
  const isDark = useIsDark(meta?.theme?.mode)
  const logo = pickBrandLogo(meta, isDark)

  useEffect(() => {
    applyThemeConfig(meta?.theme)
  }, [meta?.theme])

  // Public-demo convenience: pre-fill the one-click demo credentials.
  useEffect(() => {
    if (meta?.demo_login) {
      setEmail(meta.demo_login.user)
      setPassword(meta.demo_login.password)
    }
  }, [meta?.demo_login])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(email, password)
      qc.clear()
      navigate('/')
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 429
          ? t('login_rate_limited')
          : t('login_bad_credentials')
      setError(msg)
      setShake(true)
      setTimeout(() => setShake(false), 450)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className={clsx('card w-full max-w-sm p-8', shake && 'shake')}>
        <div className="mb-8 text-center">
          <div className="flex justify-center">
            <BrandMark logo={logo} name={meta?.brand} size="login" />
          </div>
        </div>
        {meta?.demo_login && (
          <div className="mb-4 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-center text-[13px] text-sec">
            Public demo — credentials pre-filled. Just press <b>Enter</b>.
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] text-sec" htmlFor="login-email">
              {t('login_email')}
            </label>
            <input
              id="login-email"
              type="text"
              required
              autoFocus
              autoComplete="username"
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[13px] text-sec" htmlFor="login-password">
              {t('login_password')}
            </label>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-[13px] text-critical">{error}</p>}
          <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
            {busy ? t('login_submitting') : t('login_submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
