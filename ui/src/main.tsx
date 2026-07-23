import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { BASE } from './lib/base'
import { initChromePrefs } from './lib/theme'
import * as sx from './lib/sx'
import './styles.css'

initChromePrefs()

// The custom-page SDK is global so config-bundle page modules use it without
// importing. A shared `config/widgets/components.js` (if present) registers custom
// components (sx.define) before any page mounts.
;(window as unknown as { sx: typeof sx }).sx = sx
{
  const s = document.createElement('script')
  s.type = 'module'
  s.src = `${BASE}/static/config/widgets/components.js`
  s.onerror = () => {}
  document.head.appendChild(s)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
