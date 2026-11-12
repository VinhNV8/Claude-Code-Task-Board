import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronError, nextRun, nextRuns, parseCron } from './cron.ts'

// Giờ địa phương: new Date(năm, tháng-1, ngày, giờ, phút)
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('parseCron: các dạng cú pháp', () => {
  const c = parseCron('*/15 9-17 1,15 JAN-MAR mon-fri')
  assert.deepEqual([...c.minutes], [0, 15, 30, 45])
  assert.deepEqual([...c.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual([...c.days], [1, 15])
  assert.deepEqual([...c.months], [1, 2, 3])
  assert.deepEqual([...c.weekdays], [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCron('5/20 * * * *').minutes], [5, 25, 45])
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0]) // 7 = Chủ nhật
  assert.deepEqual([...parseCron('@daily').hours], [0])
  assert.deepEqual([...parseCron('  0   8  * * *  ').hours], [8])
})

test('parseCron: báo lỗi tiếng Việt khi sai', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *', '@reboot']) {
    assert.throws(() => parseCron(bad), CronError, bad)
  }
  assert.throws(() => parseCron('61 * * * *'), /phút/)
})

test('nextRun: luôn sau thời điểm bắt đầu, tính theo phút', () => {
  assert.equal(nextRun('* * * * *', at(2026, 1, 1, 10, 0) + 30_000), at(2026, 1, 1, 10, 1))
  assert.equal(nextRun('* * * * *', at(2026, 1, 1, 10, 0)), at(2026, 1, 1, 10, 1))
  assert.equal(nextRun('30 9 * * *', at(2026, 1, 1, 9, 30)), at(2026, 1, 2, 9, 30))
  assert.equal(nextRun('30 9 * * *', at(2026, 1, 1, 8, 0)), at(2026, 1, 1, 9, 30))
})

test('nextRun: sang tháng/năm, ngày 29/2', () => {
  assert.equal(nextRun('0 0 1 * *', at(2026, 12, 15)), at(2027, 1, 1))
  assert.equal(nextRun('0 12 29 2 *', at(2026, 3, 1)), at(2028, 2, 29, 12))
  assert.equal(nextRun('0 0 31 * *', at(2026, 4, 1)), at(2026, 5, 31))
})

test('nextRun: thứ trong tuần và luật OR giữa ngày/thứ', () => {
  // 12/11/2026 là thứ Năm
  assert.equal(nextRun('0 9 * * MON', at(2026, 11, 12)), at(2026, 11, 16, 9))
  assert.equal(nextRun('0 9 * * 1-5', at(2026, 11, 13, 10)), at(2026, 11, 16, 9)) // bỏ qua T7, CN
  // Ngày 20 HOẶC Chủ nhật: Chủ nhật 15/11 đến trước
  assert.equal(nextRun('0 0 20 * 0', at(2026, 11, 12)), at(2026, 11, 15))
  // Trường ngày bắt đầu bằng * (kể cả */1) thì chỉ xét thứ
  assert.equal(nextRun('0 0 */1 * 0', at(2026, 11, 12)), at(2026, 11, 15))
})

test('nextRun: không bao giờ xảy ra thì trả null', () => {
  assert.equal(nextRun('0 0 31 2 *', at(2026, 1, 1)), null)
  assert.equal(nextRun('0 0 30 2 *', at(2026, 1, 1)), null)
})

test('nextRuns: danh sách tăng dần', () => {
  assert.deepEqual(nextRuns('0 */6 * * *', at(2026, 1, 1, 1), 3), [at(2026, 1, 1, 6), at(2026, 1, 1, 12), at(2026, 1, 1, 18)])
  assert.deepEqual(nextRuns('0 0 31 2 *', at(2026, 1, 1), 3), [])
})
