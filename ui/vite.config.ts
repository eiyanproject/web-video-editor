import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // Two entry points, one build. The phone app is a separate front end
      // served on its own port; nginx picks which index.html a port gets.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        phone: resolve(import.meta.dirname, 'phone.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    // 5173 and 8080 belong to catalog-ui-dev / catalog-api-dev on this machine.
    port: 5273,
    // Same-origin in dev, so <video src="/api/stream?..."> works and range
    // requests are proxied through untouched.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://api:8080',
        changeOrigin: true,
      },
    },
  },
})
