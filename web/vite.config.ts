import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Under utvikling sendes /api til Verity-tjenesten på 127.0.0.1:8780. Tjenesten
// godtar bare sin egen Host og Origin, så mellomleddet later som det er den.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8780',
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
  test: { environment: 'jsdom' },
});
