import { useState } from 'react'
import { downloadExport } from '../api/client'
import { useClickOutside } from '../lib/hooks'
import { useToast } from './Toast'
import { IconDownload } from './Icons'
import { useT } from '../lib/i18n'

export function ExportButton({ table, qs }: { table: string; qs: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const toast = useToast()

  const run = async (format: 'csv' | 'json') => {
    setOpen(false)
    try {
      await downloadExport(table, format, qs)
    } catch (e) {
      toast(e instanceof Error ? e.message : t('exp_failed'), 'error')
    }
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconDownload size={13} />
        {t('exp_button')}
      </button>
      {open && (
        <div className="pop-in absolute right-0 z-30 mt-1 w-32 overflow-hidden rounded-card bg-surface1 py-1 shadow-menu">
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[13px] text-sec hover:bg-hover hover:text-ink"
            onClick={() => run('csv')}
          >
            CSV
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[13px] text-sec hover:bg-hover hover:text-ink"
            onClick={() => run('json')}
          >
            JSON
          </button>
        </div>
      )}
    </div>
  )
}
