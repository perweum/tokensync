import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Figma inlines the script into <head> via document.write(), so the <body>
// may not be parsed yet when this runs. Wait for the DOM to be ready.
document.addEventListener('DOMContentLoaded', () => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
