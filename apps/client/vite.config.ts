import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 대화 모드의 VAD 런타임(public/vad/, scripts/copy-vad-assets.mjs)을 dev 서버에서도 원본 그대로
 * 내려준다. onnxruntime-web 이 `ort-wasm-simd-threaded.mjs` 를 동적 import 하는데, Vite dev 서버는
 * public/ 의 .mjs 를 모듈로 요청받으면 "should not be imported from source code" 로 500 을 낸다
 * (운영 빌드는 정적 파일이라 상관없다). 그 경로만 Vite 의 변환 파이프라인 앞에서 가로챈다.
 */
function serveVadAssetsRaw(): Plugin {
  const dir = join(__dirname, 'public', 'vad');
  const types: Record<string, string> = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream',
  };
  return {
    name: 'awb-serve-vad-assets-raw',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/vad', (req, res, next) => {
        const name = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
        const file = join(dir, name);
        if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next();
        const ext = name.slice(name.lastIndexOf('.'));
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveVadAssetsRaw()],
  server: {
    port: 7700,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:7701',
        changeOrigin: true,
      },
      '/mcp': {
        target: 'http://localhost:7701',
        changeOrigin: true,
      },
    },
  },
});
