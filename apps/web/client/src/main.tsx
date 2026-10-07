import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider } from '@fluentui/react-components'
import { aoaiLightTheme } from '@tokenusagealert/ui'
import App from './App'
import './styles.css'
import './usage.css'
import './mail.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FluentProvider theme={aoaiLightTheme}>
      <App />
    </FluentProvider>
  </StrictMode>,
)
