import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `vite --mode mock`: dùng store giả lập (prototype), không cần backend.
// __APP_ENV__: nhãn môi trường hiển thị trên giao diện (dev | mock | uat | prod).
export default defineConfig(({ mode, command }) => ({
  plugins: [react()],
  define: {
    __APP_ENV__: JSON.stringify(mode === 'mock' ? 'mock' : command === 'serve' ? 'dev' : process.env.APP_ENV ?? 'prod'),
  },
  resolve: {
    alias: mode === 'mock' ? [{ find: /^(.*)\/store\/store$/, replacement: '$1/store/mock' }] : [],
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
}))
