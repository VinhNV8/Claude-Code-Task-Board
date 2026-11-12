import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-telegram-'))
process.env.TASKBOARD_DB = ':memory:'
const { db, settings, telegramToken } = await import('./db.ts')

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

test('settings: token Telegram lưu riêng, không bao giờ nằm trong Settings', () => {
  assert.deepEqual(settings.get().telegram, { enabled: false, chatId: '', appUrl: '', hasToken: false })

  telegramToken.set(TOKEN)
  const cur = settings.get()
  assert.equal(cur.telegram.hasToken, true)
  const saved = settings.set({ ...cur, telegram: { ...cur.telegram, enabled: true, chatId: '42' } })
  assert.deepEqual(saved.telegram, { enabled: true, chatId: '42', appUrl: '', hasToken: true })
  assert.ok(!JSON.stringify(saved).includes(TOKEN))

  const appRow = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }
  assert.ok(!appRow.value.includes(TOKEN))
  assert.ok(!appRow.value.includes('hasToken'))
  assert.equal(telegramToken.get(), TOKEN)

  telegramToken.set(null)
  assert.equal(telegramToken.get(), undefined)
  assert.equal(settings.get().telegram.hasToken, false)
  assert.equal(settings.get().telegram.chatId, '42')
})
