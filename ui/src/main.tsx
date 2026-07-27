import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initChromePrefs } from './lib/theme'
import './styles.css'

initChromePrefs()


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
