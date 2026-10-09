import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// MapLibre 6 starts its worker by importing maplibre-gl-worker.mjs (which imports ./maplibre-gl-shared.mjs) at runtime.
// The bundler can't see that, so ship both files as-is; src/maps/core.ts points setWorkerUrl at them.
function maplibreWorker(): Plugin {
  const dist = dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json'))
  return {
    name: 'maplibre-worker',
    apply: 'build',
    generateBundle() {
      for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'])
        this.emitFile({ type: 'asset', fileName: `assets/maplibre/${f}`, source: readFileSync(join(dist, 'dist', f)) })
    },
  }
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
  server: { host: true, port: 5173, proxy: { '/api': { target: 'http://localhost:8200', changeOrigin: true, xfwd: true } } },
  // two pages: the owner's app (index.html) and Shell:B Guest (guest.html, served by server/guest_app.py on the guest port)
  build: { chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', guest: 'guest.html' } } },
})
