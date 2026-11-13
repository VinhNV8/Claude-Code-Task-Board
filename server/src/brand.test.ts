// Logo + tên thương hiệu "Claude Workspace": hàm thuần (web/src/lib/brand.ts) và tài sản tĩnh (favicon, index.html).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APP_NAME, pageTitle } from '../../web/src/lib/brand.ts'

const web = (p: string) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8')

test('tên tool là Claude Workspace', () => assert.equal(APP_NAME, 'Claude Workspace'))

test('pageTitle ghép nhãn môi trường và tên trang', () => {
  assert.equal(pageTitle(), 'Claude Workspace')
  assert.equal(pageTitle({ env: 'UAT' }), '[UAT] Claude Workspace')
  assert.equal(pageTitle({ page: 'Đăng nhập' }), 'Đăng nhập · Claude Workspace')
  assert.equal(pageTitle({ env: 'DEV', page: 'X' }), 'X · [DEV] Claude Workspace')
})

test('favicon logo.svg là SVG hợp lệ có viewBox và nhãn truy cập', () => {
  const svg = web('public/logo.svg')
  assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /viewBox="0 0 64 64"/)
  assert.match(svg, /aria-label="Claude Workspace"/)
  assert.ok((svg.match(/<rect/g) ?? []).length >= 4)
})

test('index.html dùng favicon và tiêu đề mới', () => {
  const html = web('index.html')
  assert.match(html, /<title>Claude Workspace<\/title>/)
  assert.match(html, /rel="icon"[^>]+href="\/logo\.svg"/)
})

test('giao diện không còn tên cũ "Claude Task Board"', () => {
  for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html']) {
    assert.doesNotMatch(web(f), /Claude Task Board/, f)
  }
})
