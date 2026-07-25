import { useEffect } from 'react'
import { useT } from '../lib/i18n'

export function Sheet({
  title,
  onClose,
  children,
  width = 480,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: number
}) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="sheet-in flex h-full w-full flex-col bg-surface1 shadow-modal"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal
        aria-label={title}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            className="rounded-ctl px-2 py-1 text-[13px] text-muted hover:text-ink"
            onClick={onClose}
            aria-label={t('cfg_close')}
          >
            Esc
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">{children}</div>
      </div>
    </div>
  )
}
