export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase-admin'
import { pushMessage } from '@/lib/line-client'
import { getPendingFollowUps } from '@/lib/contact-service'
import { requireCronAuth } from '@/lib/cron-auth'

/**
 * 每日跟進提醒（台灣時間早上 8 點，排程設定在 vercel.json）。
 *
 * 名片收進來之後最常見的失敗不是找不到，是「忘了要跟進」。
 * 這支每天把到期的人推到你眼前，沒有要跟進的人就不吵你。
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req)
  if (denied) return denied

  const usersSnap = await db.collection('users').get()
  const results: Array<{ user: string; sent: boolean; error?: string }> = []

  for (const userDoc of usersSnap.docs) {
    const lineUserId = userDoc.id
    try {
      // 用 contact-service 的版本：它刻意避開 where 加 orderBy 的複合查詢，
      // 因為那需要另外建 Firestore 索引，缺索引時會整支無聲失敗
      const followUps = await getPendingFollowUps(lineUserId)

      if (followUps.length === 0) {
        results.push({ user: lineUserId.slice(0, 8), sent: false })
        continue
      }

      const today = new Date().toLocaleDateString('zh-TW', {
        timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long',
      })

      const lines = [
        `🌅 早安！${today}`,
        '',
        `📋 今天該跟進 ${followUps.length} 位：`,
        ...followUps.map(c => {
          const name = c.nameZh || c.nameEn || '未知'
          return `  ・${name}（${c.company}）⭐${c.score} ${c.category}`
        }),
        '',
        '輸入「跟進」看詳細建議，或直接說「找某某某」叫出卡片。',
      ]

      await pushMessage(lineUserId, lines.join('\n'))
      results.push({ user: lineUserId.slice(0, 8), sent: true })
    } catch (err) {
      // 失敗要留下痕跡並回報，不能只吞掉
      console.error(`Daily briefing error for ${lineUserId}:`, err)
      results.push({ user: lineUserId.slice(0, 8), sent: false, error: String(err).slice(0, 200) })
    }
  }

  const failed = results.filter(r => r.error).length
  return NextResponse.json({ ok: failed === 0, users: results.length, failed, results })
}
