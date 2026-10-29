export const dynamic = 'force-dynamic'
// Vercel Hobby 方案的硬上限就是 60 秒，寫更大的數字只會被靜默忽略並誤導後續維護者。
// 升級 Pro 之後可以調高，同時記得放寬下面的 BATCH_BUDGET_MS。
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { downloadLineImage, replyMessage, pushMessage, pushFlex } from '@/lib/line-client'
import { findEventAround, MatchedEvent } from '@/lib/google-calendar'
import { scanResultMessage, uncertainLabelsOf } from '@/lib/flex'
import { analyzeCard } from '@/lib/card-analyzer'
import { uploadCardImage } from '@/lib/storage'
import { db } from '@/lib/firebase-admin'
import {
  saveContact, updateContactSource, updateContactField, addContactNote,
  findMergeForNewCard, mergeContactPair, refreshFollowUp, dismissMergePair,
  getContactById, updateContactStatus,
  setPendingSource, consumePendingSource, getLatestContact,
  setPendingCorrection, consumePendingCorrection,
} from '@/lib/contact-service'
import { runAgent } from '@/lib/agent'
import { claimEvent } from '@/lib/dedup'
import { getExpoMode, bumpExpoCount, ExpoMode } from '@/lib/expo-mode'
import { runBatch } from '@/lib/batch'
import { appendSystemNote } from '@/lib/conversation'
import { logError } from '@/lib/error-log'
import { profile } from '@/config/profile'

// 一疊名片一起傳進來時，留多少時間給收尾推播。
// 這個數字要比 maxDuration 小夠多：deadline 只擋「還沒開始」的工作，
// 已經開跑的那一張還要跑完，加上最後的摘要推播才算結束。
const BATCH_BUDGET_MS = 32_000
const BATCH_CONCURRENCY = 3

/**
 * 使用者白名單。
 * agent 每句話都有 API 成本，不設白名單等於任何人加好友都能燒你的錢。
 * 未設定時放行所有人（方便第一次部署測試），設定後僅白名單可用。
 */
function isAllowedUser(lineUserId: string | undefined): boolean {
  const allow = (process.env.ALLOWED_LINE_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allow.length === 0) return true
  return !!lineUserId && allow.includes(lineUserId)
}

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET || ''
  const hash = crypto.createHmac('sha256', secret).update(body).digest()
  let sigBuf: Buffer
  try {
    sigBuf = Buffer.from(signature, 'base64')
  } catch {
    return false
  }
  if (sigBuf.length !== hash.length) return false
  return crypto.timingSafeEqual(hash, sigBuf)
}

// 回覆優先用 replyToken（不佔推播額度），處理太久 token 過期就改用 push
async function replyOrPush(replyToken: string, lineUserId: string, text: string) {
  try {
    if (replyToken) {
      await replyMessage(replyToken, text)
      return
    }
  } catch (err) {
    console.error('Reply failed, falling back to push:', err)
  }
  await pushMessage(lineUserId, text)
}

// 錯誤通知本身失敗時不能再往外丟，否則 webhook 回 500 會讓 LINE 反覆重送，
// 造成同一則訊息被處理多次（名片重複建檔、agent 重複計費）
async function notifyFailureQuietly(replyToken: string, lineUserId: string, text: string) {
  try {
    await replyOrPush(replyToken, lineUserId, text)
  } catch (err) {
    console.error('Failed to deliver error notice to user:', err)
  }
}

type ScanResult = {
  card: Awaited<ReturnType<typeof analyzeCard>>
  contactId: string
  imageUrl: string
  source: string
  /** 併進既有名片時，這筆合併改了什麼。空陣列代表沒有合併 */
  mergedChanges: string[]
  /** 手機撞號但姓名不同的既有名片，要問使用者是不是同一人 */
  suggestMerge: { contactId: string; name: string; company: string } | null
}

/** 掃一張名片並建檔，場合優先用展場模式宣告的名稱，其次才問日曆 */
async function scanCard(
  messageId: string, lineUserId: string, expo: ExpoMode | null, matched: MatchedEvent | null
): Promise<ScanResult> {
  const imageBuffer = await downloadLineImage(messageId)
  const card = await analyzeCard(imageBuffer)
  const contactId = await saveContact(lineUserId, card)

  // 縮圖要放進結果卡片讓使用者一眼核對辨識有沒有錯，所以這裡要等上傳完成。
  // 上傳失敗不能擋住建檔，卡片少一張圖照樣能用。
  let imageUrl = ''
  try {
    imageUrl = await uploadCardImage(imageBuffer, contactId)
    await db.collection('contacts').doc(contactId).update({ cardImageUrl: imageUrl })
  } catch (err) {
    console.error('Card image upload failed:', err)
  }

  let source = ''
  if (expo) {
    await updateContactSource(lineUserId, contactId, expo.source)
    await addContactNote(lineUserId, contactId, `在「${expo.source}」認識`)
    source = expo.source
  } else if (matched) {
    await updateContactSource(lineUserId, contactId, matched.title)
    await addContactNote(
      lineUserId, contactId,
      `在「${matched.title}」認識${matched.location ? `（${matched.location}）` : ''}`
    )
    source = matched.title
  }

  // 去重：姓名與電話都對得上就併進既有那筆，不留兩筆。
  //
  // 刻意「先建檔再合併」而不是「先查再決定要不要建檔」：
  //   1. 合併邏輯只有一套（lib/contact-merge.ts 的 planMerge），有測試，不必再寫一條分支
  //   2. 被併掉的那筆是軟刪除，所以這次的辨識結果會留著。
  //      同一個人的名片被掃兩次等於做了兩次獨立辨識，之後要核對名字時這是唯一的對照來源
  const { auto, suggest } = await findMergeForNewCard(lineUserId, card, contactId)
  let mergedChanges: string[] = []
  let finalId = contactId
  if (auto?.id) {
    const merged = await mergeContactPair(lineUserId, auto.id, contactId)
    if (merged.ok) {
      mergedChanges = merged.changes
      finalId = merged.survivingId
      // 合併後卡片上的場合要顯示活著那筆的場合，不是這次掃到的
      source = auto.source && auto.source !== '其他' ? auto.source : source
      // 又遇到同一個人，跟進日期從今天重算。
      // 不重算的話主檔留著舊日期，而卡片顯示「今天＋這次建議的天數」，兩者對不上。
      await refreshFollowUp(lineUserId, finalId, card.followUpDays)
      mergedChanges.push('跟進日期重新排')
    }
  }

  const first = suggest[0]
  const suggestMerge = !auto && first?.id
    ? { contactId: first.id, name: first.nameZh || first.nameEn || '', company: first.company || '' }
    : null

  return { card, contactId: finalId, imageUrl, source, mergedChanges, suggestMerge }
}

function cardLine(card: ScanResult['card'], index?: number, merged = false): string {
  const name = card.nameZh || card.nameEn || '未知'
  const company = card.company ? `（${card.company}）` : ''
  const prefix = index === undefined ? '' : `${index}. `
  // 批次摘要沒有名片縮圖可以核對，所以至少要標出哪幾張辨識沒把握
  const warn = card.uncertainFields?.length ? ' ⚠️' : ''
  // 併入既有的也要標，否則使用者數「我掃了 12 張但名單只多 9 筆」會以為掉了三張
  const mark = merged ? ' ♻️併入' : ''
  return `${prefix}${name}${company} ⭐${card.score}/10 ${card.category}${warn}${mark}`
}

async function sendScanCard(lineUserId: string, r: ScanResult, expoIndex: number) {
  const followUpDate = new Date()
  followUpDate.setDate(followUpDate.getDate() + r.card.followUpDays)
  const followUpStr = followUpDate.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
  const uncertain = uncertainLabelsOf(r.card.uncertainFields || [])

  // 卡片一旦被 LINE 拒收就會丟例外，但名片其實已經建檔成功了。
  // 不能因為「顯示方式」失敗就讓使用者以為整張掃失敗，所以退回純文字摘要。
  try {
    await pushFlex(lineUserId, scanResultMessage({
      contactId: r.contactId,
      imageUrl: r.imageUrl,
      name: r.card.nameZh || r.card.nameEn || '',
      company: r.card.company || '',
      title: r.card.title || '',
      mobile: r.card.mobile || r.card.officePhone || '',
      email: r.card.email || '',
      source: r.source,
      score: r.card.score ?? 0,
      category: r.card.category || '',
      followUpDate: followUpStr,
      uncertainLabels: uncertain,
      expoIndex,
      mergedChanges: r.mergedChanges,
      suggestMerge: r.suggestMerge,
    }))
  } catch (err) {
    await logError('scan.pushFlex', err, {
      contactId: r.contactId,
      hasHeroImage: !!r.imageUrl,
      merged: r.mergedChanges.length > 0,
      hasSuggest: !!r.suggestMerge,
      uncertainCount: uncertain.length,
    })
    const lines = [
      r.mergedChanges.length
        ? (expoIndex > 0 ? `♻️ 第 ${expoIndex} 張｜併入既有名片` : '♻️ 這個人已經有了，已併入既有名片')
        : (expoIndex > 0 ? `📇 第 ${expoIndex} 張` : '✅ 名片已建檔'),
      r.mergedChanges.length ? `這次補上：${r.mergedChanges.join('、')}` : '',
      r.suggestMerge ? `⚠️ 手機跟「${r.suggestMerge.name}」一樣，同一人的話跟我說「合併」` : '',
      cardLine(r.card),
      r.card.title ? `職稱：${r.card.title}` : '',
      (r.card.mobile || r.card.officePhone) ? `電話：${r.card.mobile || r.card.officePhone}` : '',
      r.card.email ? `Email：${r.card.email}` : '',
      r.source ? `場合：${r.source}` : '場合：⚠️ 未判定',
      expoIndex === 0 ? `跟進：${followUpStr}` : '',
      uncertain.length ? `⚠️ 這幾欄沒把握：${uncertain.join('、')}` : '',
    ].filter(Boolean)
    await pushMessage(lineUserId, lines.join('\n'))
  }
}

/**
 * 掃名片：一則確認加一張卡片，不丟出任何需要回答的問題。
 *
 * 卡片上放名片縮圖是關鍵：辨識錯誤真正的代價不是會錯，
 * 是當下不知道它錯了，等要聯絡時才發現名字是錯的。
 */
async function handleImageMessage(messageId: string, replyToken: string, lineUserId: string) {
  const expo = await getExpoMode(lineUserId)

  // 分析要十幾秒，先回一句讓使用者知道有收到
  await replyMessage(replyToken, '📷 分析中...')

  // 展場模式已經宣告場合，不必再查日曆
  const matched = expo ? null : await findEventAround(lineUserId, new Date())
  const result = await scanCard(messageId, lineUserId, expo, matched)
  const expoIndex = expo ? await bumpExpoCount(lineUserId) : 0

  await sendScanCard(lineUserId, result, expoIndex)

  // 讓 agent 的對話記憶知道剛掃了誰，之後「他的電話多少」接得上
  const displayName = result.card.nameZh || result.card.nameEn || '未知'
  appendSystemNote(
    lineUserId,
    `剛掃描了一張名片並${result.mergedChanges.length ? '併入既有聯絡人' : '建檔'}：` +
    `${displayName}（${result.card.company}）${result.source ? `，場合是「${result.source}」` : '，場合尚未判定'}`
  ).catch(err => console.error('Conversation note failed:', err))
}

/** 一次傳多張：限流並行加時間預算，處理不完的明確告知而不是靜默吞掉 */
async function handleBatchImages(
  events: { messageId: string; replyToken: string }[], lineUserId: string
) {
  if (events[0].replyToken) {
    await replyMessage(events[0].replyToken, `📷 收到 ${events.length} 張名片，分析中（請稍候）...`)
  }

  const expo = await getExpoMode(lineUserId)
  // 一疊名片通常來自同一場活動，只查一次日曆就好
  const matched = expo ? null : await findEventAround(lineUserId, new Date())

  const outcome = await runBatch(
    events,
    e => scanCard(e.messageId, lineUserId, expo, matched),
    { concurrency: BATCH_CONCURRENCY, deadlineAt: Date.now() + BATCH_BUDGET_MS }
  )

  if (expo && outcome.done.length > 0) {
    await bumpExpoCount(lineUserId, outcome.done.length)
  }

  const uncertainCount = outcome.done.filter(({ result }) => result.card.uncertainFields?.length).length
  const mergedCount = outcome.done.filter(({ result }) => result.mergedChanges.length > 0).length
  const suggestCount = outcome.done.filter(({ result }) => result.suggestMerge).length

  const lines = [
    `✅ 批次掃描完成！共 ${outcome.done.length} 張名片`,
    ...(mergedCount > 0 ? [`♻️ ${mergedCount} 張是已經有的人，已併入既有名片`] : []),
    ...(suggestCount > 0 ? [`❓ ${suggestCount} 張手機跟既有名片撞號但姓名不同，說「檢查重複」我列給你看`] : []),
    ...(outcome.failed.length > 0 ? [`⚠️ ${outcome.failed.length} 張分析失敗`] : []),
    ...(outcome.skipped.length > 0 ? [`⏳ ${outcome.skipped.length} 張因處理時間不足未完成，請再傳一次`] : []),
    ...(matched ? [`📍 場合：${matched.title}（已自動記錄）`] : []),
    ...(expo ? [`📍 場合：${expo.source}（展場模式）`] : []),
    '',
    ...outcome.done.map(({ result }, i) => cardLine(result.card, i + 1, result.mergedChanges.length > 0)),
    '',
    ...(uncertainCount > 0
      ? [`⚠️ 有 ${uncertainCount} 張辨識沒把握（標 ⚠️ 的），建議回頭看一下名片原圖`]
      : []),
    (matched || expo) ? '📌 場合記錯的話跟我說一聲，我幫你改' : '📌 這批還沒判定場合，跟我說一聲我幫你補',
  ]

  await pushMessage(lineUserId, lines.join('\n'))
}

// ── Postback（卡片與圖文選單的按鈕）─────────────────────────
async function handlePostback(data: string, replyToken: string, lineUserId: string) {
  // 圖文選單的「掃名片」：固定回覆，不送 agent，省一次 API 費用與等待
  if (data === 'menu:scan') {
    const expo = await getExpoMode(lineUserId)
    await replyMessage(
      replyToken,
      expo
        ? `📷 展場模式進行中（${expo.source}），已掃 ${expo.scanned} 張。\n直接傳名片照片即可，一次傳多張也可以。`
        : '📷 直接傳名片照片給我，我會自動辨識並建檔。\n一次傳多張也可以。'
    )
    return
  }
  // 選單上只負責叫出鍵盤的按鈕，不需要後端動作
  if (data.startsWith('menu:')) return

  const draftMatch = data.match(/^draft:(\w+)$/)
  if (draftMatch) {
    const c = await getContactById(lineUserId, draftMatch[1])
    if (!c) {
      await replyMessage(replyToken, '⚠️ 找不到這筆聯絡人')
      return
    }
    await replyMessage(replyToken, '✍️ 草稿生成中...')
    const answer = await runAgent(lineUserId, `幫我寫跟進訊息給 ${c.nameZh || c.nameEn || c.company}`)
    await pushMessage(lineUserId, answer)
    return
  }

  const contactedMatch = data.match(/^contacted:(\w+)$/)
  if (contactedMatch) {
    const ok = await updateContactStatus(lineUserId, contactedMatch[1], '已聯絡')
    await replyMessage(replyToken, ok ? '✅ 已標記為已聯絡' : '⚠️ 找不到這筆聯絡人')
    return
  }

  const srcMatch = data.match(/^src:(.+):(\w+)$/)
  if (srcMatch) {
    const [, source, contactId] = srcMatch
    const ok = await updateContactSource(lineUserId, contactId, source)
    await replyMessage(replyToken, ok ? `✅ 已記錄場合：${source}` : '⚠️ 找不到這筆聯絡人')
    return
  }

  // 合併：primary 是既有那筆（較早建檔），secondary 是剛掃的這筆。
  // 順序顛倒會把舊的場合與筆記併進新的那筆，等於把累積的資訊丟掉。
  const mergeMatch = data.match(/^merge:(\w+):(\w+)$/)
  if (mergeMatch) {
    const result = await mergeContactPair(lineUserId, mergeMatch[1], mergeMatch[2])
    await replyMessage(
      replyToken,
      result.ok
        ? `♻️ 已合併成一筆${result.changes.length ? `\n這次補上：${result.changes.join('、')}` : '\n兩筆內容相同，沒有需要補的欄位'}`
        : `⚠️ 合併沒有完成：${result.reason || '未知原因'}`
    )
    return
  }

  // 「不是同一人」：記下來，下次檢查重複不再問同一組
  const notDupMatch = data.match(/^notdup:(\w+):(\w+)$/)
  if (notDupMatch) {
    const ok = await dismissMergePair(lineUserId, notDupMatch[1], notDupMatch[2])
    await replyMessage(
      replyToken,
      ok
        ? '👌 記住了，這兩筆是不同的人，以後檢查重複不會再問這一組'
        : '⚠️ 找不到這兩筆名片，可能已經被合併或刪掉了'
    )
    return
  }

  const otherMatch = data.match(/^src_other:(\w+)$/)
  if (otherMatch) {
    await setPendingSource(lineUserId, otherMatch[1])
    await replyMessage(replyToken, `請直接輸入場合名稱，例如：\n${profile.fixedSources[0] || '某某展'}`)
    return
  }

  const correctNameMatch = data.match(/^correct_name:(\w+)$/)
  if (correctNameMatch) {
    await setPendingCorrection(lineUserId, 'nameZh', correctNameMatch[1])
    await replyMessage(replyToken, '請輸入正確的名字：')
    return
  }

  const correctCompanyMatch = data.match(/^correct_company:(\w+)$/)
  if (correctCompanyMatch) {
    await setPendingCorrection(lineUserId, 'company', correctCompanyMatch[1])
    await replyMessage(replyToken, '請輸入正確的公司名稱：')
    return
  }
}

// ── 文字訊息：固定流程優先，其餘交給 agent ──────────────────
async function handleTextMessage(text: string, replyToken: string, lineUserId: string) {
  const t = text.trim()

  // 快速回覆按鈕帶出的「場合名稱：」輸入
  const customSourceMatch = t.match(/^場合名稱：?(.+)$/)
  if (customSourceMatch) {
    const sourceName = customSourceMatch[1].trim()
    let contactId = await consumePendingSource(lineUserId)
    if (!contactId) {
      const latest = await getLatestContact(lineUserId)
      contactId = latest?.id || null
    }
    if (!contactId) {
      await replyMessage(replyToken, '⚠️ 找不到對應名片，請先掃描名片')
      return
    }
    const ok = await updateContactSource(lineUserId, contactId, sourceName)
    await replyMessage(replyToken, ok ? `✅ 已記錄場合：${sourceName}` : '⚠️ 找不到這筆聯絡人')
    return
  }

  // 按了卡片上「修正名字／公司」之後的輸入
  const pendingCorr = await consumePendingCorrection(lineUserId)
  if (pendingCorr) {
    const ok = await updateContactField(lineUserId, pendingCorr.contactId, pendingCorr.field, t)
    if (!ok) {
      await replyMessage(replyToken, '⚠️ 找不到這筆聯絡人')
      return
    }
    const label = pendingCorr.field === 'nameZh' ? '名字' : '公司名稱'
    await replyMessage(replyToken, `✅ 已修正${label}為：${t}`)
    return
  }

  // 其餘全部交給 agent：自然語言理解加工具呼叫加對話記憶
  const answer = await runAgent(lineUserId, t)
  await replyOrPush(replyToken, lineUserId, answer)
}

// ── 主入口 ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body = await req.text()
  const signature = req.headers.get('x-line-signature') || ''

  if (!verifySignature(body, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const data = JSON.parse(body)
  const allEvents: Array<Record<string, any>> = data.events || []
  const events = allEvents.filter(e => {
    if (isAllowedUser(e.source?.userId)) return true
    console.warn('Blocked non-allowlisted user:', e.source?.userId)
    return false
  })

  const imageEvents = events.filter(e => e.type === 'message' && e.message?.type === 'image')
  const otherEvents = events.filter(e => !(e.type === 'message' && e.message?.type === 'image'))

  if (imageEvents.length > 1) {
    const lineUserId = imageEvents[0].source?.userId
    try {
      // 去重以事件 ID 為準：LINE 重送時同一批圖片不會被建檔兩次
      const fresh = []
      for (const e of imageEvents) {
        if (await claimEvent(e.webhookEventId || e.message.id)) {
          fresh.push({ messageId: e.message.id, replyToken: e.replyToken })
        }
      }
      if (fresh.length > 0) await handleBatchImages(fresh, lineUserId)
    } catch (err) {
      await logError('webhook.batchImage', err)
      await notifyFailureQuietly('', lineUserId, '⚠️ 批次掃描發生錯誤，請稍後再試')
    }
  } else if (imageEvents.length === 1) {
    const e = imageEvents[0]
    const lineUserId = e.source?.userId
    try {
      if (await claimEvent(e.webhookEventId || e.message.id)) {
        await handleImageMessage(e.message.id, e.replyToken, lineUserId)
      }
    } catch (err) {
      await logError('webhook.image', err)
      await notifyFailureQuietly(e.replyToken, lineUserId, '⚠️ 發生錯誤，請稍後再試')
    }
  }

  for (const event of otherEvents) {
    const lineUserId = event.source?.userId
    const replyToken = event.replyToken

    try {
      if (!(await claimEvent(event.webhookEventId || `${event.type}-${replyToken}`))) continue

      if (event.type === 'message' && event.message?.type === 'text') {
        await handleTextMessage(event.message.text, replyToken, lineUserId)
      } else if (event.type === 'postback') {
        await handlePostback(event.postback.data, replyToken, lineUserId)
      }
    } catch (err) {
      await logError('webhook.event', err, { eventType: event.type })
      const msg = !process.env.OPENAI_API_KEY
        ? '⚠️ AI 引擎尚未設定（缺少 OPENAI_API_KEY），請到環境變數補上'
        : '⚠️ 發生錯誤，請稍後再試'
      await notifyFailureQuietly(replyToken, lineUserId, msg)
    }
  }

  return NextResponse.json({ ok: true })
}
