// 場合判定邏輯測試。執行：node --experimental-strip-types lib/event-matching.test.ts
import assert from 'node:assert'
import { test } from 'node:test'
import { pickBestEvent } from './event-matching.ts'

const timed = (summary: string, start: string, end: string, location = '') => ({
  summary, location,
  start: { dateTime: start },
  end: { dateTime: end },
})

const allDay = (summary: string, start: string, end: string, location = '') => ({
  summary, location,
  start: { date: start },
  end: { date: end },
})

const at = (iso: string) => new Date(iso)

test('活動進行中：早餐例會 07:00-09:00，07:45 掃名片', () => {
  const events = [timed('商會早餐例會', '2026-07-29T07:00:00+08:00', '2026-07-29T09:00:00+08:00', '台中林酒店')]
  const m = pickBestEvent(events, at('2026-07-29T07:45:00+08:00'))
  assert.equal(m?.title, '商會早餐例會')
  assert.equal(m?.location, '台中林酒店')
})

test('剛散會：09:00 結束，09:30 才掃', () => {
  const events = [timed('商會早餐例會', '2026-07-29T07:00:00+08:00', '2026-07-29T09:00:00+08:00')]
  assert.equal(pickBestEvent(events, at('2026-07-29T09:30:00+08:00'))?.title, '商會早餐例會')
})

test('隔太久不算：09:00 結束，下午 14:00 才掃', () => {
  const events = [timed('商會早餐例會', '2026-07-29T07:00:00+08:00', '2026-07-29T09:00:00+08:00')]
  assert.equal(pickBestEvent(events, at('2026-07-29T14:00:00+08:00')), null)
})

test('提早到場：15:00 開始，14:30 先交換名片', () => {
  const events = [timed('明志科大媒合會', '2026-08-21T15:00:00+08:00', '2026-08-21T17:00:00+08:00')]
  assert.equal(pickBestEvent(events, at('2026-08-21T14:30:00+08:00'))?.title, '明志科大媒合會')
})

test('太早不算：15:00 開始，11:00 就掃', () => {
  const events = [timed('明志科大媒合會', '2026-08-21T15:00:00+08:00', '2026-08-21T17:00:00+08:00')]
  assert.equal(pickBestEvent(events, at('2026-08-21T11:00:00+08:00')), null)
})

test('整天展覽：產業展覽 10/20-10/22，第二天掃名片', () => {
  // Google 的 end.date 是不含當天的隔天，10/20-10/22 的展覽 end 要填 10/23
  const events = [allDay('產業展覽 TiTE x IHT', '2026-10-20', '2026-10-23', '台北南港展覽館')]
  const m = pickBestEvent(events, at('2026-10-21T14:00:00+08:00'))
  assert.equal(m?.title, '產業展覽 TiTE x IHT')
  assert.equal(m?.isAllDay, true)
})

test('展覽結束後一天不算', () => {
  const events = [allDay('產業展覽 TiTE x IHT', '2026-10-20', '2026-10-23')]
  assert.equal(pickBestEvent(events, at('2026-10-23T14:00:00+08:00')), null)
})

test('展期中有具體會議時，以會議為準（會議比展覽精確）', () => {
  const events = [
    allDay('產業展覽 TiTE x IHT', '2026-10-20', '2026-10-23'),
    timed('與某某實業洽談', '2026-10-21T14:00:00+08:00', '2026-10-21T15:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-10-21T14:30:00+08:00'))?.title, '與某某實業洽談')
})

test('展期中非會議時段，仍算展覽', () => {
  const events = [
    allDay('產業展覽 TiTE x IHT', '2026-10-20', '2026-10-23'),
    timed('與某某實業洽談', '2026-10-21T14:00:00+08:00', '2026-10-21T15:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-10-21T10:00:00+08:00'))?.title, '產業展覽 TiTE x IHT')
})

test('兩場會議相鄰時，取正在進行的那場', () => {
  const events = [
    timed('早上的會', '2026-07-29T09:00:00+08:00', '2026-07-29T10:00:00+08:00'),
    timed('現在這場會', '2026-07-29T10:30:00+08:00', '2026-07-29T12:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-07-29T11:00:00+08:00'))?.title, '現在這場會')
})

test('已取消的活動不採用', () => {
  const events = [{ ...timed('取消的會', '2026-07-29T07:00:00+08:00', '2026-07-29T09:00:00+08:00'), status: 'cancelled' }]
  assert.equal(pickBestEvent(events, at('2026-07-29T08:00:00+08:00')), null)
})

test('沒有標題的活動不採用', () => {
  const events = [timed('', '2026-07-29T07:00:00+08:00', '2026-07-29T09:00:00+08:00')]
  assert.equal(pickBestEvent(events, at('2026-07-29T08:00:00+08:00')), null)
})

test('日曆全空時回傳 null', () => {
  assert.equal(pickBestEvent([], at('2026-07-29T08:00:00+08:00')), null)
})

test('重疊行程同分時取最晚開始的（產業展覽 vs 當天稍早的 早餐例會）', () => {
  const events = [
    timed('早餐例會', '2026-10-21T06:30:00+08:00', '2026-10-21T09:30:00+08:00'),
    timed('產業展覽', '2026-10-21T08:00:00+08:00', '2026-10-21T18:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-10-21T08:30:00+08:00'))?.title, '產業展覽')
})

test('早餐例會時段內（產業展覽還沒開始）仍算早餐例會', () => {
  const events = [
    timed('早餐例會', '2026-10-21T06:30:00+08:00', '2026-10-21T09:30:00+08:00'),
    timed('產業展覽', '2026-10-21T08:00:00+08:00', '2026-10-21T18:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-10-21T07:00:00+08:00'))?.title, '早餐例會')
})

test('展期中的具體洽談仍勝過整天展覽（最晚開始規則不會破壞原有行為）', () => {
  const events = [
    timed('產業展覽', '2026-10-21T08:00:00+08:00', '2026-10-21T18:00:00+08:00'),
    timed('與某某實業洽談', '2026-10-21T14:00:00+08:00', '2026-10-21T15:00:00+08:00'),
  ]
  assert.equal(pickBestEvent(events, at('2026-10-21T14:30:00+08:00'))?.title, '與某某實業洽談')
})
