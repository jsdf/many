#!/usr/bin/env node

import { build, context } from 'esbuild'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Read package.json to get dependencies for externalization
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const external = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {}), 'electron']

const isDev = process.argv.includes('--dev')
const isWatch = process.argv.includes('--watch')

const commonConfig = {
  bundle: true,
  platform: 'node',
  external,
  target: 'node18',
  sourcemap: isDev,
  minify: !isDev,
}

// Main process build
const mainConfig = {
  ...commonConfig,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist-electron/main/index.cjs',
  format: 'cjs',
}

// Preload script build
const preloadConfig = {
  ...commonConfig,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist-electron/preload/index.cjs',
  format: 'cjs',
}

// Renderer process build
const rendererConfig = {
  bundle: true,
  platform: 'browser',
  entryPoints: ['src/renderer/src/main.tsx'],
  outfile: 'dist/main.js',
  format: 'iife',
  target: 'es2020',
  sourcemap: isDev,
  minify: !isDev,
  loader: {
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.svg': 'file',
    '.gif': 'file',
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.eot': 'file',
    '.css': 'css',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  jsx: 'automatic',
  jsxImportSource: 'react',
  alias: {
    '@renderer': path.resolve(__dirname, 'src/renderer/src'),
  },
}

// HTML generation for renderer
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'

function generateHTML() {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Many Worktree Manager</title>
    <link rel="stylesheet" href="main.css">
    <style>
        body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
                'Ubuntu', 'Cantarell', 'Open Sans', 'Helvetica Neue', sans-serif;
        }
        #root {
            height: 100vh;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script src="main.js"></script>
</body>
</html>`

  if (!existsSync('dist')) {
    mkdirSync('dist', { recursive: true })
  }
  writeFileSync('dist/index.html', htmlContent)
  
  // Copy CSS files from renderer
  const rendererCssPath = 'src/renderer/src/styles.css'
  if (existsSync(rendererCssPath)) {
    copyFileSync(rendererCssPath, 'dist/styles.css')
  }
  
  // Copy assets from public directory if it exists
  if (existsSync('public')) {
    const publicFiles = ['many-shodan.png', 'logo.png']
    publicFiles.forEach(file => {
      const srcPath = path.join('public', file)
      const destPath = path.join('dist', file)
      if (existsSync(srcPath)) {
        copyFileSync(srcPath, destPath)
      }
    })
  }
}

async function buildAll() {
  try {
    if (isWatch) {
      console.log('Setting up watch mode...')
      
      // Create contexts for watch mode
      const mainContext = await context(mainConfig)
      const preloadContext = await context(preloadConfig)
      const rendererContext = await context(rendererConfig)
      
      // Start watching
      await mainContext.watch()
      console.log('Main process watching for changes...')
      
      await preloadContext.watch()
      console.log('Preload script watching for changes...')
      
      await rendererContext.watch()
      console.log('Renderer process watching for changes...')
      
      // Generate HTML initially
      generateHTML()
      console.log('HTML generated successfully')
      console.log('Watch mode active. Press Ctrl+C to stop.')
      
      // Keep process alive
      process.on('SIGINT', async () => {
        console.log('\nStopping watch mode...')
        await mainContext.dispose()
        await preloadContext.dispose()
        await rendererContext.dispose()
        process.exit(0)
      })
      
    } else {
      console.log('Building main process...')
      await build(mainConfig)
      console.log('Main process built successfully')

      console.log('Building preload script...')
      await build(preloadConfig)
      console.log('Preload script built successfully')

      console.log('Generating HTML...')
      generateHTML()
      console.log('HTML generated successfully')

      console.log('Building renderer process...')
      await build(rendererConfig)
      console.log('Renderer process built successfully')
      
      console.log('Build completed successfully!')
    }
  } catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
}

buildAll()