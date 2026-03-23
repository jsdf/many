import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'
import path from 'path'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createServer as createNetServer } from 'net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Bind port 0, read the assigned port, close the listener. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, () => {
      const port = (srv.address() as import('net').AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/**
 * Vite plugin that builds and starts the many backend on a free port,
 * then proxies API/WebSocket requests to it.
 */
function manyBackend(): Plugin {
  let backendProcess: ChildProcess | null = null

  return {
    name: 'many-backend',
    apply: 'serve',
    async config() {
      // Build the backend before starting
      console.log('[many-backend] Building CLI...')
      execSync('npx tsc -p tsconfig.cli.json', { cwd: __dirname, stdio: 'inherit' })

      const port = await getFreePort()

      backendProcess = spawn(
        'node',
        ['dist-cli/cli/index.js', 'web', '--port', String(port), '--token', 'dev'],
        {
          cwd: __dirname,
          env: {
            ...process.env,
            MANY_NO_OPEN: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )

      backendProcess.stdout!.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk)
      })
      backendProcess.stderr!.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk)
      })

      return {
        server: {
          proxy: {
            '/trpc': {
              target: `http://localhost:${port}`,
              changeOrigin: true,
            },
            '/api': {
              target: `http://localhost:${port}`,
              changeOrigin: true,
            },
            '/ws': {
              target: `ws://localhost:${port}`,
              ws: true,
            },
          },
        },
      }
    },
    buildEnd() {
      if (backendProcess) {
        backendProcess.kill()
        backendProcess = null
      }
    },
  }
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss(), manyBackend()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      {
        find: /^shiki$/,
        replacement: resolve('src/renderer/src/shiki-bundle.ts'),
      },
    ]
  },
  server: {
    open: '/?token=dev',
  },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve('src/renderer/index.html')
      }
    }
  }
})
