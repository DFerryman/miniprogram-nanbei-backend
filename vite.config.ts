import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发：另开终端运行 `npx wrangler dev`（默认 8787 端口）提供 /api。
// .dev.vars 的 APP_ORIGIN 设为实际前端地址（例如 http://localhost:5173）。
// Worker 需使用 --local-upstream localhost:5173 --upstream-protocol http，避免自定义域名重写请求地址。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // 保留浏览器的 Host 与 Origin，让 Worker 按 APP_ORIGIN 校验同源写请求。
        changeOrigin: false,
      },
    },
  },
});
