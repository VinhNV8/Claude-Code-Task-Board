// Build extension: bundle extension + server (+ script MCP/hook) bằng esbuild, chép giao diện web đã build.
// Kết quả trong dist/: extension.js, server/{index,permission,notification}.mjs, web/.
// Tham số: --skip-web  không build lại web (dùng web/dist có sẵn).
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
const dist = join(root, 'dist')
const skipWeb = process.argv.includes('--skip-web')

rmSync(dist, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  outfile: join(dist, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'node:sqlite'],
  logLevel: 'warning',
})

await build({
  entryPoints: {
    index: join(repo, 'server', 'src', 'index.ts'),
    permission: join(repo, 'server', 'src', 'mcp', 'permission.ts'),
    notification: join(repo, 'server', 'src', 'hooks', 'notification.ts'),
  },
  outdir: join(dist, 'server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node:sqlite có sẵn trong Node 22.13+/Electron; bufferutil, utf-8-validate là phụ thuộc tuỳ chọn của ws
  external: ['node:sqlite', 'bufferutil', 'utf-8-validate'],
  // Một số gói CommonJS gọi require(): tạo require cho bản ESM
  banner: { js: "import { createRequire as __tbCreateRequire } from 'node:module'; const require = __tbCreateRequire(import.meta.url);" },
  logLevel: 'warning',
})

const webDist = join(repo, 'web', 'dist')
if (!skipWeb || !existsSync(join(webDist, 'index.html'))) execSync('npm run build -w web', { cwd: repo, stdio: 'inherit' })
cpSync(webDist, join(dist, 'web'), { recursive: true })

console.log(`Đã build vào ${dist}`)
