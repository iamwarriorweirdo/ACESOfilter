
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    // KHÔNG định nghĩa process.env.API_KEY ở đây vì sẽ làm lộ key ở client-side.
    // Toàn bộ logic AI đã được chuyển xuống Serverless Functions (api/*.ts).
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        }
      }
    }
  };
});
