import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy requests to the backend Express server running on port 3000
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/feeds': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
