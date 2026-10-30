import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * StepKB 前端构建配置（赛题 27）
 *
 * - root = web/，产物输出到 ../dist（由 server/index.mjs 静态托管）
 * - dev 端口 18271，/api 代理到后端 18270
 * - COOP/COEP：WASM 多线程（SharedArrayBuffer）必需；dev 由本配置加，生产由 server 加
 * - ORT WASM 运行文件自托管：dev 走中间件直出 node_modules 文件，build 时拷贝到 dist/ort/
 *   （v4 的 transformers.js 默认从 CDN 取 ort-wasm-simd-threaded.asyncify.{mjs,wasm}，
 *    自托管可离线/可复现，也避开 COEP 下的跨域问题）
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // web/
const projectRoot = path.resolve(here, '..'); // src/

const ORT_DIST = path.join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
] as const;

const COOP_COEP_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** 自托管 onnxruntime-web 的 wasm 运行文件（不改 package.json，不新增依赖）。 */
function ortAssetsPlugin(): Plugin {
  let outDir = path.resolve(projectRoot, 'dist');
  return {
    name: 'stepkb-ort-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = (req.url || '').split('?')[0];
        if (!rawUrl.startsWith('/ort/')) return next();
        const name = path.basename(rawUrl.slice('/ort/'.length));
        if (!(ORT_FILES as readonly string[]).includes(name)) {
          res.statusCode = 404;
          res.end('ort asset not allowed: ' + name);
          return;
        }
        const file = path.join(ORT_DIST, name);
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          res.end('ort asset missing: ' + name);
          return;
        }
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        res.setHeader('Content-Length', String(fs.statSync(file).size));
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const dest = path.join(outDir, 'ort');
      fs.mkdirSync(dest, { recursive: true });
      for (const name of ORT_FILES) {
        const src = path.join(ORT_DIST, name);
        if (!fs.existsSync(src)) {
          throw new Error('[stepkb-ort-assets] 缺少 ' + src + '，请先 npm install（onnxruntime-web 已随 transformers 安装）');
        }
        fs.copyFileSync(src, path.join(dest, name));
      }
      const wasmSize = fs.statSync(path.join(dest, ORT_FILES[1])).size;
      console.log('[stepkb-ort-assets] 已拷贝 ORT WASM 到 ' + dest + ' (wasm=' + wasmSize + ' B)');
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 18271,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18270',
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 18271,
    headers: COOP_COEP_HEADERS,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // 预构建 transformer/ORT 的大包，避免 dev 下每次冷加载过慢
    include: ['@huggingface/transformers', 'onnxruntime-web/webgpu', 'onnxruntime-common'],
  },
  plugins: [ortAssetsPlugin()],
});
