import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      {
        find: /^shiki$/,
        replacement: resolve('src/renderer/src/shiki-bundle.ts'),
      },
    ]
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
