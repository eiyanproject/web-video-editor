import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Dev server for the PHONE app, on its own port.
 *
 * The phone UI is a separate front end rather than a responsive mode, so it
 * gets its own address: you point the phone at :5274 and the desktop stays on
 * :5273, untouched. Production does the same thing with a second nginx server
 * block - see ui/entrypoint.sh.
 */

/** Serve phone.html at `/`, so the phone URL is a bare host:port with no path
 *  to type or bookmark wrongly. */
const phoneAtRoot = (): Plugin => ({
  name: 'phone-at-root',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/phone.html'
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), phoneAtRoot()],
  // Its own dep cache. Two dev servers sharing node_modules/.vite fight over
  // the optimised deps and each restart invalidates the other's.
  cacheDir: 'node_modules/.vite-phone',
  server: {
    host: '0.0.0.0',
    port: 5274,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://api:8080',
        changeOrigin: true,
      },
    },
  },
})
