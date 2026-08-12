import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PhoneApp from './PhoneApp'
import '../styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
)
