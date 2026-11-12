// Test logic mở rộng/thu nhỏ left-menu của web (file thuần, không phụ thuộc DOM/React)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDEBAR_STORAGE_KEY,
  compactBadge,
  isSidebarShortcut,
  loadCollapsed,
  parseCollapsed,
  saveCollapsed,
  serializeCollapsed,
  type KVStorage,
} from '../../web/src/lib/sidebar.ts'

function memStorage(init: Record<string, string> = {}): KVStorage & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

const broken: KVStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

test('parseCollapsed: chỉ "1"/"true" là thu nhỏ, còn lại mặc định mở rộng', () => {
  assert.equal(parseCollapsed('1'), true)
  assert.equal(parseCollapsed('true'), true)
  assert.equal(parseCollapsed('0'), false)
  assert.equal(parseCollapsed('false'), false)
  assert.equal(parseCollapsed(null), false)
  assert.equal(parseCollapsed(undefined), false)
  assert.equal(parseCollapsed('garbage'), false)
})

test('serialize ↔ parse khứ hồi', () => {
  for (const v of [true, false]) assert.equal(parseCollapsed(serializeCollapsed(v)), v)
})

test('loadCollapsed / saveCollapsed lưu đúng key', () => {
  const st = memStorage()
  assert.equal(loadCollapsed(st), false)
  saveCollapsed(st, true)
  assert.equal(st.data[SIDEBAR_STORAGE_KEY], '1')
  assert.equal(loadCollapsed(st), true)
  saveCollapsed(st, false)
  assert.equal(loadCollapsed(st), false)
})

test('storage lỗi hoặc không có ⇒ không ném lỗi, mặc định mở rộng', () => {
  assert.equal(loadCollapsed(broken), false)
  assert.doesNotThrow(() => saveCollapsed(broken, true))
  assert.equal(loadCollapsed(null), false)
  assert.equal(loadCollapsed(undefined), false)
  assert.doesNotThrow(() => saveCollapsed(undefined, true))
})

test('isSidebarShortcut: "[" khi không gõ trong ô nhập', () => {
  assert.equal(isSidebarShortcut({ key: '[', targetTag: 'BODY' }), true)
  assert.equal(isSidebarShortcut({ key: '[' }), true)
  assert.equal(isSidebarShortcut({ key: ']', targetTag: 'BODY' }), false)
  assert.equal(isSidebarShortcut({ key: '[', targetTag: 'INPUT' }), false)
  assert.equal(isSidebarShortcut({ key: '[', targetTag: 'textarea' }), false)
  assert.equal(isSidebarShortcut({ key: '[', targetTag: 'SELECT' }), false)
  assert.equal(isSidebarShortcut({ key: '[', targetTag: 'DIV', isContentEditable: true }), false)
  assert.equal(isSidebarShortcut({ key: '[', ctrlKey: true }), false)
  assert.equal(isSidebarShortcut({ key: '[', metaKey: true }), false)
  assert.equal(isSidebarShortcut({ key: '[', altKey: true }), false)
})

test('compactBadge: rút gọn số lớn', () => {
  assert.equal(compactBadge(0), '')
  assert.equal(compactBadge(-1), '')
  assert.equal(compactBadge(1), '1')
  assert.equal(compactBadge(9), '9')
  assert.equal(compactBadge(10), '9+')
  assert.equal(compactBadge(120), '9+')
})
