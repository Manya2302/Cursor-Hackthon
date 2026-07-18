import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Forward API calls to LedgerBot Express backend
      '/webhook': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
})
