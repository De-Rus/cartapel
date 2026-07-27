import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initChromePrefs } from './lib/theme'
import * as sx from './lib/sx'
import './styles.css'

initChromePrefs()

// The custom-page SDK is global so config-bundle page modules use it without
// importing.
;(window as unknown as { sx: typeof sx }).sx = sx

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
