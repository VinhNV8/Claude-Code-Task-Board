// Mã hoá bí mật lưu trong SQLite (API key) bằng AES-256-GCM.
// Khoá lấy từ TASKBOARD_SECRET_KEY (32 byte, dạng hex 64 ký tự hoặc base64), nếu không có thì tự sinh
// và lưu ở `<DATA_DIR>/secret.key` (quyền 0600). Mục đích: file DB bị sao chép/lộ một mình thì không đọc được key.
// Không thay được kho bí mật của hệ điều hành: ai đọc được cả thư mục data/ vẫn giải mã được.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = 'v1'
const KEY_BYTES = 32

export class SecretBoxError extends Error {}

/** Đọc khoá 32 byte từ chuỗi hex hoặc base64. */
export function parseKey(raw: string): Buffer {
  const s = raw.trim()
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  if (buf.length !== KEY_BYTES) throw new SecretBoxError(`Khoá mã hoá phải dài ${KEY_BYTES} byte (hex 64 ký tự hoặc base64)`)
  return buf
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

export function decryptSecret(box: string, key: Buffer): string {
  const [v, iv, tag, ct] = box.split(':')
  if (v !== PREFIX || !iv || !tag || ct === undefined) throw new SecretBoxError('Dữ liệu mã hoá không đúng định dạng')
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new SecretBoxError('Không giải mã được bí mật (khoá mã hoá đã đổi hoặc dữ liệu hỏng)')
  }
}

/** Khoá của máy này: biến môi trường, hoặc file trong thư mục dữ liệu (tự tạo lần đầu). */
export function loadOrCreateKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.TASKBOARD_SECRET_KEY) return parseKey(env.TASKBOARD_SECRET_KEY)
  const file = join(dataDir, 'secret.key')
  if (existsSync(file)) return parseKey(readFileSync(file, 'utf8'))
  const key = randomBytes(KEY_BYTES)
  writeFileSync(file, key.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return key
}
