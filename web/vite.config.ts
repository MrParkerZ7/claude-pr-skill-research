import react from '@vitejs/plugin-react'
import { loadEnv, type ProxyOptions } from 'vite'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The API the dev and preview servers forward to. `app-run` sets API_ORIGIN when it moves the API.
  const target = loadEnv(mode, process.cwd(), '').API_ORIGIN || 'http://localhost:8080'

  const api: ProxyOptions = {
    target,
    configure: (server) => {
      // An upstream stream that ends or aborts ends the browser's response. Vite only pipes the upstream
      // response, and once headers are sent its error handler writes nothing, so without this a dead API
      // would leave the page showing "Live".
      server.on('proxyRes', (proxyRes, _req, res) => {
        proxyRes.on('close', () => {
          if (!res.writableEnded) res.destroy()
        })
      })
      // A closed browser stream closes the upstream request. The proxy library already does this; it is
      // kept as belt-and-braces.
      server.on('proxyReq', (proxyReq, _req, res) => {
        res.on('close', () => {
          if (!res.writableEnded) proxyReq.destroy()
        })
      })
    },
  }
  const proxy: Record<string, ProxyOptions> = { '/api': api, '/actuator': { target } }

  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      coverage: {
        provider: 'v8',
        reporter: [['text', { skipFull: false }]],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/main.tsx', 'src/**/*.test.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts'],
        thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  }
})
