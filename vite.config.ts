import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发：另开终端运行 `npx wrangler dev`（默认 8787 端口）提供 /api，Vite 负责前端热更新。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // Worker 只接受同源写请求，经代理转发时去掉浏览器的 Origin
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
});
