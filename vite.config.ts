import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()], root: fileURLToPath(new URL('./src/webview', import.meta.url)), base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/webview', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./src/webview/index.html', import.meta.url)), output: { entryFileNames: 'assets/index.js', assetFileNames: 'assets/[name][extname]' } },
  },
})
