import { TFn, useT } from '../lib/i18n'
import { Modal } from './Modal'

const shortcuts = (t: TFn): Array<[string, string]> => [
  ['⌘K  /  Ctrl-K', t('kbd_palette')],
  ['/', t('kbd_search_records')],
  [`g ${t('kbd_then')} d`, t('kbd_go_dashboard')],
  [`g ${t('kbd_then')} a`, t('kbd_go_audit')],
  [`g ${t('kbd_then')} t`, t('kbd_go_table')],
  ['j / k', t('kbd_move_cursor')],
  ['↵', t('kbd_open_row')],
  ['x', t('kbd_select_row')],
  ['⌘S', t('kbd_save_record')],
  ['?', t('kbd_cheatsheet')],
  ['Esc', t('kbd_close_layer')],
]

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const t = useT()
  return (
    <Modal title={t('menu_shortcuts')} onClose={onClose}>
      <div className="grid grid-cols-1 gap-y-1.5">
        {shortcuts(t).map(([keys, desc]) => (
          <div key={keys} className="flex items-center justify-between gap-4 text-[13px]">
            <span className="text-sec">{desc}</span>
            <span className="kbd whitespace-nowrap px-1.5">{keys}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
