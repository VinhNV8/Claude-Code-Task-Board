// Build extension: bundle extension + server (+ script MCP/hook) bằng esbuild, chép giao diện web đã build.
// Kết quả trong dist/: extension.js, server/{index,permission,notification}.mjs, web/.
// Tham số: --skip-web     không build lại web (dùng web/dist có sẵn).
//          --no-telegram  thay telegram.ts / telegramApprove.ts bằng bản rỗng trong src/stubs (không có mã gọi Telegram).
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
const dist = join(root, 'dist')
const skipWeb = process.argv.includes('--skip-web')
const noTelegram = process.argv.includes('--no-telegram')

/** Thay import './telegram.ts', './telegramApprove.ts' của server bằng bản rỗng (--no-telegram). */
const stubTelegram = stubModules('stub-telegram', /^\.\/(telegram|telegramApprove)\.ts$/)
/** Luôn dùng: server trong extension không quét thư mục extensions của editor khác (extension truyền CLAUDE_BIN). */
const stubEditorScan = stubModules('stub-editor-scan', /^\.\/claudeEditorScan\.ts$/)

/** Plugin esbuild: import './x.ts' từ server/src khớp `filter` được thay bằng src/stubs/x.ts. */
function stubModules(name, filter) {
  return {
    name,
    setup(b) {
      const serverSrc = join(repo, 'server', 'src')
      b.onResolve({ filter }, (args) => {
        if (resolve(args.resolveDir) !== serverSrc) return
        return { path: join(root, 'src', 'stubs', args.path.slice(2)) }
      })
    },
  }
}

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
  plugins: noTelegram ? [stubEditorScan, stubTelegram] : [stubEditorScan],
  logLevel: 'warning',
})

const webDist = join(repo, 'web', 'dist')
if (!skipWeb || !existsSync(join(webDist, 'index.html'))) execSync('npm run build -w web', { cwd: repo, stdio: 'inherit' })
cpSync(webDist, join(dist, 'web'), { recursive: true })

console.log(`Đã build vào ${dist}${noTelegram ? ' (không có Telegram)' : ''}`)
