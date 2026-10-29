// 把例外寫進 Firestore，讓失敗原因不必靠 Vercel log 才看得到。
//
// 為什麼需要這一層：console.error 只有部署平台的 log 看得到，
// 而本機沒有正式環境的憑證時根本重現不了問題，等於只能用猜的。
// 錯誤寫進資料庫之後，用後台端點就讀得回來，查問題不必翻雲端 log。
//
// 寫入刻意 fail open：記錯誤本身絕對不能把主流程再弄壞一次。

import { db } from './firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'

const COLLECTION = 'error_logs'
const RETENTION_DAYS = 14

/** 例外轉成可讀字串，Error 之外的東西（字串、物件）也要撈得出內容 */
function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    return { message: err.message.slice(0, 2000), stack: (err.stack || '').slice(0, 4000) }
  }
  try {
    return { message: JSON.stringify(err).slice(0, 2000), stack: '' }
  } catch {
    return { message: String(err).slice(0, 2000), stack: '' }
  }
}

/**
 * 記一筆錯誤。where 用來標出是哪個環節（例如 'scan.pushFlex'）。
 * extra 放當下的關鍵資料，方便事後重建情境，不要放個資以外用不到的東西。
 */
export async function logError(where: string, err: unknown, extra?: Record<string, unknown>) {
  const { message, stack } = describe(err)
  console.error(`[${where}]`, message)
  try {
    await db.collection(COLLECTION).add({
      where,
      message,
      stack,
      extra: extra ?? {},
      createdAt: Timestamp.now(),
    })
  } catch (inner) {
    // 記錯誤失敗就只剩 console，但主流程照走
    console.error('logError 本身失敗:', inner)
  }
}

/** 清掉過期紀錄，由每日 cron 呼叫 */
export async function purgeOldErrorLogs(): Promise<number> {
  const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 86400_000)
  const snap = await db.collection(COLLECTION).where('createdAt', '<', cutoff).get()
  await Promise.all(snap.docs.map(d => d.ref.delete()))
  return snap.size
}
