#!/usr/bin/env node
// Quản lý môi trường UAT: một bản build production chạy từ git worktree riêng, port và dữ liệu riêng,
// tách biệt hoàn toàn với môi trường DEV (`npm run dev` trong thư mục hiện tại).
//
//   npm run uat:deploy [-- <ref>] [-- --force] [-- --copy-db]   build + (re)start UAT từ ref (mặc định: main)
//   npm run uat:copy-db [-- --force]              chép toàn bộ dữ liệu DEV (DB, log run, worktree task) sang UAT
//   npm run uat:start | uat:stop | uat:status | uat:logs
//
// Biến môi trường: UAT_DIR (mặc định ../<tên-repo>-uat), UAT_PORT (mặc định 4000).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(import.meta.dirname, '..')
const UAT_DIR = resolve(process.env.UAT_DIR ?? join(ROOT, '..', `${basename(ROOT)}-uat`))
const PORT = Number(process.env.UAT_PORT ?? 4000)
const HOST = '127.0.0.1'
const DATA = join(UAT_DIR, 'data')
const PID_FILE = join(DATA, 'uat.pid')
const LOG_FILE = join(DATA, 'uat.log')
const INFO_FILE = join(DATA, 'deploy.json')
const WIN = process.platform === 'win32'
const URL = `http://${HOST}:${PORT}`
const DEV_DATA = resolve(process.env.TASKBOARD_DATA ?? join(ROOT, 'data'))
const DEV_DB = resolve(process.env.TASKBOARD_DB ?? join(DEV_DATA, 'taskboard.db'))
const UAT_DB = join(DATA, 'taskboard.db')

const log = (...a) => console.log('[uat]', ...a)
const die = (msg) => {
  console.error(`[uat] ✖ ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  // Windows cần shell để chạy npm.cmd; args ở đây là hằng số nội bộ nên ghép chuỗi an toàn.
  const r = WIN
    ? spawnSync(`${cmd} ${args.join(' ')}`, { stdio: 'inherit', shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) die(`Lệnh thất bại: ${cmd} ${args.join(' ')}`)
}
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ tiến trình

function readPid() {
  const pid = Number(existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').trim() : NaN)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** PID còn sống và đúng là tiến trình node (tránh kill nhầm khi PID bị hệ điều hành tái sử dụng). */
function isOurProcess(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!WIN) return true
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  return /node(\.exe)?/i.test(r.stdout ?? '')
}

async function fetchJson(path) {
  try {
    const res = await fetch(URL + path, { signal: AbortSignal.timeout(2000) })
    return res.ok ? await res.json() : undefined
  } catch {
    return undefined
  }
}

async function stop() {
  const pid = readPid()
  if (!pid || !isOurProcess(pid)) {
    rmSync(PID_FILE, { force: true })
    log('UAT không chạy.')
    return
  }
  log(`Dừng UAT (pid ${pid})...`)
  // Kill cả cây tiến trình: server + các phiên Claude CLI nó đang chạy.
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  for (let i = 0; i < 50 && isOurProcess(pid); i++) await new Promise((r) => setTimeout(r, 200))
  rmSync(PID_FILE, { force: true })
  log('Đã dừng.')
}

async function start() {
  if (!existsSync(join(UAT_DIR, 'server', 'src', 'index.ts'))) die(`Chưa có bản UAT tại ${UAT_DIR}. Chạy: npm run uat:deploy`)
  const pid = readPid()
  if (pid && isOurProcess(pid)) return log(`UAT đã chạy (pid ${pid}) → ${URL}`)
  if (await fetchJson('/api/health')) die(`Port ${PORT} đang bị tiến trình khác chiếm. Đặt UAT_PORT khác.`)

  mkdirSync(DATA, { recursive: true })
  const out = openSync(LOG_FILE, 'a')
  const env = { ...process.env, NODE_ENV: 'production', HOST, PORT: String(PORT), TASKBOARD_DATA: DATA }
  delete env.TASKBOARD_DB // DB luôn nằm trong data/ của UAT, không dùng chung với DEV
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(UAT_DIR, 'server'),
    env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await fetchJson('/api/health')) return log(`✔ UAT đang chạy (pid ${child.pid}) → ${URL}`)
    if (!isOurProcess(child.pid)) break
  }
  die(`UAT không khởi động được. Xem log: ${LOG_FILE}`)
}


// ------------------------------------------------------------------ chép dữ liệu DEV → UAT

const BUSY = ['running', 'needs_input']

/**
 * Chép toàn bộ dữ liệu DEV sang UAT (UAT phải đang dừng):
 *  - DB: snapshot nhất quán bằng `VACUUM INTO` (an toàn cả khi DEV đang chạy, WAL đã được gộp vào).
 *  - data/runs/*.jsonl: output gốc của từng lần chạy.
 *  - Worktree của task nằm trong data/ của DEV: `git worktree move` sang data/ của UAT và cập nhật
 *    worktree_path (một nhánh claude/task-<id> chỉ được checkout ở một worktree, nên phải chuyển hẳn).
 * DB UAT cũ được backup sang data/backup/.
 */
/** Kiểm tra trước khi dừng UAT: DEV không còn task đang chạy (status trong DB). */
function guardDevTasks(force) {
  if (!existsSync(DEV_DB)) die(`Không tìm thấy DB DEV: ${DEV_DB}`)
  const src = new DatabaseSync(DEV_DB, { readOnly: true })
  const busy = src.prepare(`SELECT id, status FROM tasks WHERE status IN (${BUSY.map(() => '?').join(',')})`).all(...BUSY)
  src.close()
  if (!busy.length) return
  const ids = busy.map((t) => `#${t.id}`).join(', ')
  if (!force) die(`DEV còn ${busy.length} task trạng thái running/needs_input (${ids}). Đợi xong hoặc thêm --force.`)
  log(`--force: ${ids} sẽ được UAT đánh dấu bị gián đoạn khi khởi động (có thể Retry).`)
}

function copyDevData() {
  const src = new DatabaseSync(DEV_DB)

  mkdirSync(DATA, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  // Backup DB UAT hiện có
  if (existsSync(UAT_DB)) {
    const bak = join(DATA, 'backup', stamp)
    mkdirSync(bak, { recursive: true })
    for (const f of ['taskboard.db', 'taskboard.db-wal', 'taskboard.db-shm'])
      if (existsSync(join(DATA, f))) renameSync(join(DATA, f), join(bak, f))
    log(`Backup DB UAT cũ → ${bak}`)
  }

  // 1. DB
  src.exec(`VACUUM INTO '${UAT_DB.replaceAll("'", "''")}'`)
  src.close()
  log(`DB: ${DEV_DB} → ${UAT_DB}`)

  // 2. Log các run
  const devRuns = join(DEV_DATA, 'runs')
  if (existsSync(devRuns)) {
    cpSync(devRuns, join(DATA, 'runs'), { recursive: true, force: true })
    log('Log run: đã chép data/runs/')
  }

  // 3. Worktree task + đường dẫn trong DB
  const db = new DatabaseSync(UAT_DB)
  const tasks = db.prepare('SELECT t.id, t.worktree_path AS wt, p.repo_path AS repo FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.worktree_path IS NOT NULL').all()
  const update = db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?')
  let moved = 0
  for (const t of tasks) {
    const rel = relative(DEV_DATA, resolve(t.wt))
    if (rel.startsWith('..') || resolve(rel) === rel) continue // worktree nằm ngoài data/ của DEV: giữ nguyên
    const dest = join(DATA, rel)
    if (existsSync(t.wt)) {
      mkdirSync(dirname(dest), { recursive: true })
      const mv = git(t.repo, ['worktree', 'move', t.wt, dest])
      if (mv.code !== 0) {
        log(`⚠ Task #${t.id}: không chuyển được worktree (${mv.err}). Giữ đường dẫn cũ.`)
        continue
      }
      moved++
    }
    update.run(dest, t.id)
  }
  // Task đang chạy dở ở DEV (khi --force) không thể tiếp tục ở UAT → để recover() khi khởi động đánh dấu lại.
  const counts = db.prepare('SELECT (SELECT count(*) FROM projects) p, (SELECT count(*) FROM tasks) t, (SELECT count(*) FROM runs) r').get()
  db.close()
  log(`Worktree: chuyển ${moved}/${tasks.length}`)
  log(`✔ Đã chép: ${counts.p} project, ${counts.t} task, ${counts.r} run`)
}

async function copyDb(force) {
  guardDevTasks(force)
  await guardRunningTasks(force)
  await stop()
  copyDevData()
  if (existsSync(join(UAT_DIR, 'server', 'src', 'index.ts'))) await start()
  log('⚠ Từ giờ hãy giao/chạy task ở UAT. Đừng chạy task song song ở DEV: hai DB dùng chung dãy ID nên sẽ trùng nhánh claude/task-<id>.')
}

// ------------------------------------------------------------------ deploy

/** Từ chối deploy khi UAT còn task đang chạy / chờ input (deploy sẽ kill các phiên Claude đó). */
async function guardRunningTasks(force) {
  const state = await fetchJson('/api/state')
  const busy = (state?.tasks ?? []).filter((t) => t.status === 'running' || t.status === 'needs_input')
  if (!busy.length) return
  const list = busy.map((t) => `  #${t.id} [${t.status}] ${t.title}`).join('\n')
  if (!force) die(`UAT còn ${busy.length} task đang chạy:\n${list}\nĐợi xong hoặc thêm --force để vẫn deploy.`)
  log(`--force: các task sau sẽ bị dừng:\n${list}`)
}

async function deploy(ref, force, withDb) {
  const sha = git(ROOT, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (sha.code !== 0) die(`Không tìm thấy ref "${ref}". Ref phải là branch/tag/commit đã commit.`)
  const current = git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']).out
  if (current === ref && git(ROOT, ['status', '--porcelain']).out)
    log(`⚠ Thư mục DEV có thay đổi chưa commit — UAT chỉ nhận code đã commit trên "${ref}".`)

  if (withDb) guardDevTasks(force)
  await guardRunningTasks(force)
  await stop()

  // 1. Worktree riêng, checkout detached đúng commit cần test. Thư mục data/ (gitignored) được giữ nguyên.
  if (!existsSync(join(UAT_DIR, '.git'))) {
    log(`Tạo worktree UAT tại ${UAT_DIR}`)
    git(ROOT, ['worktree', 'prune'])
    const add = git(ROOT, ['worktree', 'add', '--detach', UAT_DIR, sha.out])
    if (add.code !== 0) die(`git worktree add thất bại: ${add.err}`)
  } else {
    const co = git(UAT_DIR, ['checkout', '--force', '--detach', sha.out])
    if (co.code !== 0) die(`Checkout thất bại: ${co.err}`)
    git(UAT_DIR, ['clean', '-fd', '-e', 'data/', '-e', 'node_modules/'])
  }
  const subject = git(UAT_DIR, ['log', '-1', '--format=%h %s']).out
  log(`Code: ${ref} @ ${subject}`)

  // 2. Cài dependency khi package-lock thay đổi
  mkdirSync(DATA, { recursive: true })
  const lockHash = createHash('sha1').update(readFileSync(join(UAT_DIR, 'package-lock.json'))).digest('hex')
  const prev = readJson(INFO_FILE)
  if (prev?.lockHash !== lockHash || !existsSync(join(UAT_DIR, 'node_modules'))) {
    log('Cài dependency (npm ci)...')
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: UAT_DIR })
  } else log('Dependency không đổi, bỏ qua npm ci.')

  // 3. Build giao diện với nhãn môi trường UAT
  log('Build giao diện...')
  run('npm', ['run', 'build', '-w', 'web'], { cwd: UAT_DIR, env: { ...process.env, APP_ENV: 'uat' } })

  if (withDb) copyDevData()

  writeFileSync(
    INFO_FILE,
    JSON.stringify({ ref, sha: sha.out, subject, lockHash, deployedAt: new Date().toISOString() }, null, 2),
  )
  await start()
}

async function status() {
  const info = readJson(INFO_FILE)
  const pid = readPid()
  const alive = pid && isOurProcess(pid)
  const health = alive ? await fetchJson('/api/health') : undefined
  console.log(`Thư mục : ${UAT_DIR}`)
  console.log(`URL     : ${URL}`)
  console.log(`Trạng thái: ${alive ? (health ? `đang chạy (pid ${pid})` : `pid ${pid} sống nhưng không phản hồi`) : 'đã dừng'}`)
  if (info) console.log(`Bản deploy: ${info.ref} @ ${info.subject}\n            lúc ${info.deployedAt}`)
  else console.log('Bản deploy: chưa có')
}

function logs() {
  if (!existsSync(LOG_FILE)) die('Chưa có log.')
  const lines = readFileSync(LOG_FILE, 'utf8').split('\n')
  console.log(lines.slice(-80).join('\n'))
}

// ------------------------------------------------------------------ CLI

const [cmd, ...rest] = process.argv.slice(2)
const force = rest.includes('--force')
const ref = rest.find((a) => !a.startsWith('--')) ?? 'main'

switch (cmd) {
  case 'deploy':
    await deploy(ref, force, rest.includes('--copy-db'))
    break
  case 'copy-db':
    await copyDb(force)
    break
  case 'start':
    await start()
    break
  case 'stop':
    await guardRunningTasks(force)
    await stop()
    break
  case 'restart':
    await guardRunningTasks(force)
    await stop()
    await start()
    break
  case 'status':
    await status()
    break
  case 'logs':
    logs()
    break
  default:
    console.log('Dùng: node scripts/uat.mjs <deploy [ref] [--force] [--copy-db] | copy-db [--force] | start | stop | restart | status | logs>')
    process.exit(cmd ? 1 : 0)
}
