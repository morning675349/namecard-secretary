import type OpenAI from 'openai'
import { getOpenAI, AGENT_MODEL } from './ai'
import { profile } from '../config/profile'
import { getHistory, appendExchange } from './conversation'
import {
  searchContacts, findContactByName, getPendingFollowUps,
  updateContactStatus, updateContactField, addContactNote,
  getContactStats, getLatestContact, updateContactSource,
  getContactsBySource, getAllContacts, Contact,
  previewDuplicates, setPendingMerges, getPendingMerges, clearPendingMerges,
  mergeContactPair, unmergeContact,
} from './contact-service'
import { getExpoMode, startExpoMode, endExpoMode } from './expo-mode'
import { contactCarousel, ContactCardData, duplicateCarousel } from './flex'
import type { DuplicateCardData } from './flex'
import { pushFlex, pushMessage } from './line-client'
import { buildExpoReport, rankExpoContacts, tierOf } from './expo-report'
import type { ExpoContactLite } from './expo-report'
import { draftFollowups, MAX_DRAFTS_PER_BATCH } from './drafts'
import type { DraftTarget } from './drafts'
import { buildNewsletterCsv, buildFullCsv } from './csv'
import type { ExportRow } from './csv'
import { uploadExportCsv } from './storage'

// ── 共用格式化 ──────────────────────────────────────────────

/** 筆記開頭會帶時間戳記，顯示給使用者時拿掉比較乾淨 */
export function stripNoteTimestamp(note: string): string {
  return note.replace(/^\[[^\]]*\]\s*/, '')
}

function contactBrief(c: Contact): string {
  return [
    `姓名：${c.nameZh || c.nameEn || '未知'}`,
    `公司：${c.company || '未知'}`,
    c.title ? `職稱：${c.title}` : '',
    c.mobile ? `手機：${c.mobile}` : '',
    c.email ? `Email：${c.email}` : '',
    `評分：${c.score}/10｜分類：${c.category}｜狀態：${c.status}`,
  ].filter(Boolean).join('\n')
}

function contactFull(c: Contact): string {
  return [
    contactBrief(c),
    c.website ? `網站：${c.website}` : '',
    c.address ? `地址：${c.address}` : '',
    c.industry ? `產業：${c.industry}｜規模：${c.companySize}` : '',
    c.services?.length ? `服務項目：${c.services.join('、')}` : '',
    c.source ? `認識場合：${c.source}` : '',
    c.followUpSuggestion ? `跟進建議：${c.followUpSuggestion}` : '',
    c.opportunityMatch ? `機會：${c.opportunityNote}` : '',
    c.notes?.length ? `歷史筆記：\n${c.notes.map(n => `・${stripNoteTimestamp(n)}`).join('\n')}` : '（尚無筆記）',
  ].filter(Boolean).join('\n')
}

function toExpoLite(c: Contact): ExpoContactLite {
  return {
    id: c.id || '',
    name: c.nameZh || c.nameEn || '未知',
    company: c.company || '',
    score: c.score ?? 0,
    industry: c.industry || '',
    opportunityMatch: !!c.opportunityMatch,
    noteCount: c.notes?.length ?? 0,
    hasEmail: !!(c.email && c.email.includes('@')),
  }
}

function toExportRow(c: Contact): ExportRow {
  return {
    email: c.email || '',
    name: c.nameZh || c.nameEn || '未知',
    company: c.company || '',
    title: c.title || '',
    industry: c.industry || '',
    source: c.source || '',
    mobile: c.mobile || c.officePhone || '',
    score: c.score ?? 0,
    category: c.category || '',
    status: c.status || '',
    notes: (c.notes || []).map(stripNoteTimestamp),
  }
}

// ── 工具定義 ────────────────────────────────────────────────
const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: '在名片庫搜尋聯絡人，支援姓名、公司、職稱、產業、分類的模糊搜尋，回傳最多 5 筆摘要。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜尋關鍵字' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_contact_cards',
      description: '用卡片顯示搜尋結果，卡片上有撥號、起草跟進訊息、標記已聯絡的按鈕。使用者想「看看某人」或要對某人採取行動時優先用這個，比純文字好用。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜尋關鍵字' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contact_details',
      description: '取得單一聯絡人的完整資料，含所有歷史筆記與跟進建議。要起草訊息或回答細節時先呼叫這個。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '姓名或公司名' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_latest_contact',
      description: '取得最近一次掃描建立的聯絡人。使用者說「剛剛那張名片」「這個人」時用這個。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pending_followups',
      description: '列出已到期、需要跟進的聯絡人，最多 5 筆。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_contact_status',
      description: '更新聯絡人的跟進狀態。使用者說「我聯絡過王大明了」「跟林董成交了」時用這個。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名或公司名' },
          status: { type: 'string', enum: ['待跟進', '已聯絡', '已提案', '成交', '婉拒'] },
        },
        required: ['name', 'status'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_contact_note',
      description: '幫聯絡人新增筆記，例如聊到的需求、個人資訊、後續待辦。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名或公司名' },
          note: { type: 'string', description: '筆記內容' },
        },
        required: ['name', 'note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correct_contact_field',
      description: '修正名片辨識錯誤的姓名或公司名稱。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '目前記錄的姓名或公司名，用來找到這筆資料' },
          field: { type: 'string', enum: ['nameZh', 'nameEn', 'company', 'companyEn'] },
          value: { type: 'string', description: '正確的值' },
        },
        required: ['name', 'field', 'value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_contact_source',
      description: '修改聯絡人的認識場合。使用者說「他是在某某展認識的」「場合記錯了」時用這個。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名或公司名' },
          source: { type: 'string', description: '正確的場合名稱' },
        },
        required: ['name', 'source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contact_stats',
      description: '取得名片庫統計：總數、本週新增、分類與產業分佈、跟進狀態分佈。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_expo_mode',
      description: '開啟展場模式。使用者說「進入展場模式」「我在某某展了」時用這個。開啟後掃名片會自動套用指定場合、回覆縮成精簡卡片、不再逐張追問，適合一次要掃幾十張的展覽或聚會。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { source: { type: 'string', description: '場合名稱' } },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_expo_mode',
      description: '結束展場模式並自動送出戰果報告。使用者說「結束展場模式」「收攤」「活動結束了」時用這個。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expo_status',
      description: '查詢目前是否在展場模式、場合名稱與已掃張數。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expo_report',
      description: '產出某個場合的戰果報告：分級統計、現場聊過幾位、產業分佈、建議跟進順序。使用者說「某某展戰果」「這場收穫如何」時用這個。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { source: { type: 'string', description: '場合名稱，可只給關鍵字' } },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_batch_followups',
      description: '批次起草跟進訊息並直接傳給使用者，一次最多 5 封，優先挑現場聊過、評分高的人。使用者說「幫這些人各寫一封」時用這個；說「再寫」時把 skip 往後加。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '場合名稱' },
          tier: { type: 'string', enum: ['A', 'B', 'C', '全部'], description: 'A=8分以上，B=6到7，C=5以下' },
          skip: { type: 'string', description: '跳過前幾位，第一次填 0' },
        },
        required: ['source', 'tier', 'skip'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_contacts',
      description: '把名單匯出成 CSV 並回傳下載連結（7 天有效）。使用者說「匯出名單」「給我可以寄信的名單」時用這個。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '場合名稱；留空字串表示匯出全部' },
          format: { type: 'string', enum: ['newsletter', 'full'], description: 'newsletter=電子報寄信用，只含有 Email 的人；full=完整備份，含筆記' },
          tier: { type: 'string', enum: ['A', 'B', 'C', 'BC', '全部'], description: 'BC=B與C合併，給「高分自己聯絡、其餘群發」用' },
        },
        required: ['source', 'format', 'tier'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preview_duplicate_contacts',
      description: '盤點重複的名片：姓名與電話都相同的算確定同一人，手機相同但姓名不同的要使用者判斷。只產生提案不寫入。使用者說「檢查重複」「有沒有重複的名片」「清一下重複」時用這個。',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_duplicate_merges',
      description: '把 preview_duplicate_contacts 列出的重複正式合併。只有在使用者明確說要合併之後才可以呼叫。selection 傳「auto」只合併確定同一人的那幾組，「all」全部合併，或逗號分隔的編號例如「1,3,5」只合併指定的幾組。',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          selection: { type: 'string', description: '「auto」、「all」，或逗號分隔的編號如「1,3」' },
        },
        required: ['selection'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo_merge',
      description: '還原一次合併，把被併掉的那筆救回來。使用者說「合併錯了」「還原」「那不是同一個人」時用這個。需要被併掉那筆的聯絡人 id，可以從 preview_duplicate_contacts 的結果拿到。',
      strict: true,
      parameters: {
        type: 'object',
        properties: { contactId: { type: 'string', description: '被併掉那筆的聯絡人 id' } },
        required: ['contactId'],
        additionalProperties: false,
      },
    },
  },
]

// ── 工具實作（綁定 lineUserId，確保只能存取自己的資料）──────
type ToolArgs = Record<string, string>

function buildHandlers(lineUserId: string): Record<string, (a: ToolArgs) => Promise<string>> {
  return {
    async search_contacts({ query }) {
      const results = await searchContacts(lineUserId, query)
      if (results.length === 0) return `找不到「${query}」相關的聯絡人。`
      return results.map(contactBrief).join('\n---\n')
    },

    async show_contact_cards({ query }) {
      const results = await searchContacts(lineUserId, query)
      if (results.length === 0) return `找不到「${query}」相關的聯絡人，沒有卡片可以顯示。`

      const cards: ContactCardData[] = results.map(c => ({
        contactId: c.id || '',
        name: c.nameZh || c.nameEn || '未知',
        company: c.company || '',
        title: c.title || '',
        score: c.score ?? 0,
        category: c.category || '',
        status: c.status || '',
        source: c.source || '',
        lastNote: c.notes?.length ? stripNoteTimestamp(c.notes[c.notes.length - 1]) : '',
        mobile: c.mobile || '',
        officePhone: c.officePhone || '',
      }))

      await pushFlex(lineUserId, contactCarousel(cards))
      return `已送出 ${cards.length} 張卡片。卡片已顯示完整資料與操作按鈕，你的回覆簡短一句即可，不要重複列出這些人的細節。`
    },

    async get_contact_details({ name }) {
      const c = await findContactByName(lineUserId, name)
      if (!c) return `找不到「${name}」。可以先用 search_contacts 確認正確姓名。`
      return contactFull(c)
    },

    async get_latest_contact() {
      const c = await getLatestContact(lineUserId)
      if (!c) return '名片庫目前還沒有任何聯絡人。'
      return contactFull(c)
    },

    async list_pending_followups() {
      const contacts = await getPendingFollowUps(lineUserId)
      if (contacts.length === 0) return '目前沒有逾期的跟進任務。'
      return contacts
        .map(c => `${c.nameZh || c.nameEn}（${c.company}）⭐${c.score} ${c.category}｜建議：${c.followUpSuggestion}`)
        .join('\n')
    },

    async update_contact_status({ name, status }) {
      const c = await findContactByName(lineUserId, name)
      if (!c?.id) return `找不到「${name}」，無法更新狀態。`
      await updateContactStatus(lineUserId, c.id, status as Contact['status'])
      return `已將 ${c.nameZh || c.nameEn}（${c.company}）狀態更新為：${status}`
    },

    async add_contact_note({ name, note }) {
      const c = await findContactByName(lineUserId, name)
      if (!c?.id) return `找不到「${name}」，無法加筆記。`
      await addContactNote(lineUserId, c.id, note)
      return `已為 ${c.nameZh || c.nameEn}（${c.company}）儲存筆記。`
    },

    async correct_contact_field({ name, field, value }) {
      const c = await findContactByName(lineUserId, name)
      if (!c?.id) return `找不到「${name}」。`
      await updateContactField(lineUserId, c.id, field as 'nameZh' | 'nameEn' | 'company' | 'companyEn', value)
      return `已將 ${field} 修正為：${value}`
    },

    async update_contact_source({ name, source }) {
      const c = await findContactByName(lineUserId, name)
      if (!c?.id) return `找不到「${name}」，無法修改場合。`
      await updateContactSource(lineUserId, c.id, source)
      return `已將 ${c.nameZh || c.nameEn}（${c.company}）的認識場合改為：${source}`
    },

    async get_contact_stats() {
      return JSON.stringify(await getContactStats(lineUserId))
    },

    async start_expo_mode({ source }) {
      const current = await getExpoMode(lineUserId)
      const switched = current ? `（原本的「${current.source}」已結束，共掃了 ${current.scanned} 張）\n` : ''
      await startExpoMode(lineUserId, source)
      return `${switched}已開啟展場模式：${source}。接下來掃的名片都會自動記在這個場合。結束時說「收攤」。`
    },

    async end_expo_mode() {
      const ended = await endExpoMode(lineUserId)
      if (!ended) return '目前沒有在展場模式。'

      // 收攤當下就把戰果報告推出去。活動的價值在收完名片之後才開始兌現，
      // 等使用者自己想到要問，熱度已經過了。
      const contacts = await getContactsBySource(lineUserId, ended.source)
      await pushMessage(lineUserId, buildExpoReport(ended.source, contacts.map(toExpoLite)))

      return `展場模式已結束，「${ended.source}」掃了 ${ended.scanned} 張名片，戰果報告已送出。報告內容已完整呈現，你的回覆一句話帶過即可。`
    },

    async get_expo_status() {
      const mode = await getExpoMode(lineUserId)
      if (!mode) return '目前不在展場模式，掃名片會照平常流程走（自動查日曆判定場合）。'
      return `展場模式進行中：${mode.source}，已掃 ${mode.scanned} 張。`
    },

    async get_expo_report({ source }) {
      const contacts = await getContactsBySource(lineUserId, source)
      await pushMessage(lineUserId, buildExpoReport(source, contacts.map(toExpoLite)))
      return `已送出「${source}」的戰果報告（${contacts.length} 張名片）。報告已完整呈現，你的回覆一句話帶過即可。`
    },

    async draft_batch_followups({ source, tier, skip }) {
      const contacts = await getContactsBySource(lineUserId, source)
      if (contacts.length === 0) return `找不到「${source}」的聯絡人，沒有對象可以起草。`

      const ranked = rankExpoContacts(contacts.map(toExpoLite))
      const pool = tier === '全部' ? ranked : ranked.filter(c => tierOf(c.score) === tier)
      const start = Math.max(0, Number.parseInt(skip, 10) || 0)
      const batch = pool.slice(start, start + MAX_DRAFTS_PER_BATCH)

      if (batch.length === 0) {
        return start > 0
          ? `「${source}」的 ${tier} 級名單已經全部寫完了，總共 ${pool.length} 位。`
          : `「${source}」裡沒有 ${tier} 級的聯絡人。`
      }

      const byId = new Map(contacts.map(c => [c.id || '', c]))
      const targets: DraftTarget[] = batch.map(b => {
        const c = byId.get(b.id)
        return {
          name: b.name,
          company: c?.company || '',
          title: c?.title || '',
          industry: c?.industry || '',
          source: c?.source || source,
          opportunityMatch: !!c?.opportunityMatch,
          opportunityNote: c?.opportunityNote || '',
          followUpSuggestion: c?.followUpSuggestion || '',
          notes: (c?.notes || []).map(stripNoteTimestamp),
        }
      })

      const drafts = await draftFollowups(targets)
      if (drafts.length === 0) return '草稿生成失敗，請再試一次。'

      // 一人一則分開推播，方便使用者逐則複製貼上
      for (const d of drafts) {
        await pushMessage(lineUserId, `✍️ 給 ${d.name}\n\n${d.message}`)
      }

      const done = start + batch.length
      const remain = pool.length - done
      return `已送出 ${drafts.length} 則草稿（${tier} 級第 ${start + 1} 到 ${done} 位${remain > 0 ? `，還剩 ${remain} 位` : '，已全部寫完'}）。草稿已顯示給使用者，你的回覆只要簡短說明進度。${remain > 0 ? `使用者說「再寫」時 skip 填 ${done}。` : ''}`
    },

    async preview_duplicate_contacts() {
      const groups = (await previewDuplicates(lineUserId))
        .filter(g => g.primary.id && g.secondary.id)
      if (groups.length === 0) {
        await setPendingMerges(lineUserId, [])
        return '沒有重複的名片，名單是乾淨的。'
      }

      const when = (c: { createdAt?: { seconds: number } }) =>
        c.createdAt
          ? new Date(c.createdAt.seconds * 1000)
              .toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
          : '?'

      // 卡片每組兩顆按鈕，按完就結束。
      // 以前是回一段文字要使用者打「合併 1,2,5」，編號跟人名的對應要自己在腦中維持。
      const cards: DuplicateCardData[] = groups.slice(0, 12).map(g => ({
        verdict: g.verdict,
        primaryId: g.primary.id!,
        secondaryId: g.secondary.id!,
        primaryName: g.primary.nameZh || g.primary.nameEn || '',
        secondaryName: g.secondary.nameZh || g.secondary.nameEn || '',
        primaryWhen: when(g.primary),
        secondaryWhen: when(g.secondary),
        company: g.primary.company || g.secondary.company || '',
        phone: g.primary.mobile || g.primary.officePhone || '',
        primarySource: g.primary.source || '',
        primaryNoteCount: g.primary.notes?.length || 0,
      }))

      // 提案仍然存著，使用者想用「合併確定的」這種講法時 apply_duplicate_merges 才有東西可用
      await setPendingMerges(lineUserId, groups.map(g => ({
        primaryId: g.primary.id!,
        secondaryId: g.secondary.id!,
        label: `${g.primary.nameZh || g.primary.nameEn || ''}＋${g.secondary.nameZh || g.secondary.nameEn || ''}`,
        verdict: g.verdict,
      })))

      await pushFlex(lineUserId, duplicateCarousel(cards))

      const autoCount = groups.filter(g => g.verdict === 'auto').length
      const suggestCount = groups.length - autoCount
      const overflow = groups.length - cards.length

      return [
        `已送出 ${cards.length} 張重複名片卡片，每張上面有「合併成一筆」與「不是同一人」兩顆按鈕。`,
        `其中 ${autoCount} 組姓名與電話都相同，${suggestCount} 組手機相同但姓名不同需要他判斷。`,
        overflow > 0 ? `另有 ${overflow} 組超過單次卡片上限，處理完這批再說一次「檢查重複」就會出現。` : '',
        '卡片已經顯示完整資料與按鈕，你的回覆不要再用文字重複列一次這些人，簡短一句話即可。',
        '可以順便告訴他：想一次處理掉確定的那幾組，直接說「合併確定的」就好，不必逐張按。',
      ].filter(Boolean).join('\n')
    },

    async apply_duplicate_merges({ selection }) {
      const pairs = await getPendingMerges(lineUserId)
      if (!pairs.length) return '沒有待確認的合併提案，請先執行 preview_duplicate_contacts。'

      const pick = (selection || '').trim().toLowerCase()
      let chosen: typeof pairs
      if (pick === 'auto') {
        chosen = pairs.filter(p => p.verdict === 'auto')
      } else if (pick === 'all') {
        chosen = pairs
      } else {
        const idx = new Set(
          pick.split(/[,，\s]+/).map(n => Number(n.trim())).filter(n => Number.isInteger(n) && n >= 1)
        )
        chosen = pairs.filter((_, i) => idx.has(i + 1))
      }
      if (!chosen.length) return `selection「${selection}」沒有對應到任何一組，請確認編號。`

      const done: string[] = []
      const failed: string[] = []
      for (const p of chosen) {
        const r = await mergeContactPair(lineUserId, p.primaryId, p.secondaryId)
        if (r.ok) done.push(`${p.label}${r.changes.length ? `（${r.changes.join('、')}）` : '（內容相同，無欄位需要補）'}`)
        else failed.push(`${p.label}：${r.reason || '未知原因'}`)
      }

      // 全部處理完才清掉提案；只處理一部分時留著，使用者可以接著處理剩下的
      const remaining = pairs.length - chosen.length
      if (remaining === 0) await clearPendingMerges(lineUserId)

      return [
        `已合併 ${done.length} 組：`,
        ...done.map(d => `・${d}`),
        failed.length ? `\n有 ${failed.length} 組沒成功：\n${failed.map(f => `・${f}`).join('\n')}` : '',
        remaining > 0 ? `\n還有 ${remaining} 組沒處理，要繼續的話說一聲。` : '',
        '\n合併錯了可以說「還原」，被併掉的名片都留著沒有刪除。',
      ].filter(Boolean).join('\n')
    },

    async undo_merge({ contactId }) {
      const ok = await unmergeContact(lineUserId, contactId)
      return ok
        ? '已還原，那筆名片又回到名單裡了。'
        : '找不到這筆合併紀錄，可能 id 不對，或者那筆本來就沒有被合併。'
    },

    async export_contacts({ source, format, tier }) {
      const all = source.trim()
        ? await getContactsBySource(lineUserId, source)
        : await getAllContacts(lineUserId)
      if (all.length === 0) return `找不到「${source.trim() || '全部聯絡人'}」的聯絡人，沒有名單可以匯出。`

      // 分級切分：高分的自己聯絡，其餘的群發，這是多數人實際的工作方式
      const inTier = (score: number) =>
        tier === '全部' ? true : tier === 'BC' ? tierOf(score) !== 'A' : tierOf(score) === tier
      const contacts = all.filter(c => inTier(c.score ?? 0))
      const tierLabel = tier === '全部' ? '' : ` ${tier} 級`
      const label = `${source.trim() || '全部聯絡人'}${tierLabel}`
      if (contacts.length === 0) return `「${source.trim() || '全部聯絡人'}」裡沒有${tierLabel}的聯絡人。`

      const rows: ExportRow[] = contacts.map(toExportRow)
      let csv: string
      let summary: string
      if (format === 'newsletter') {
        const r = buildNewsletterCsv(rows)
        if (r.included === 0) return `「${label}」裡沒有任何人留下 Email，無法產出寄信名單。可以改匯出完整名單（format 填 full）。`
        csv = r.csv
        summary = `寄信名單：${r.included} 位有 Email${r.skipped > 0 ? `，另有 ${r.skipped} 位沒留 Email 已略過` : ''}`
      } else {
        csv = buildFullCsv(rows)
        summary = `完整名單：${rows.length} 位，含筆記與所有欄位`
      }

      // 簽章網址依賴 Firebase Storage 設定，失敗時不能讓使用者卡住，
      // 退而告知後台匯出路徑（那條路徑有登入保護，不會因降級而外洩名單）
      let url: string
      let expire: string
      try {
        const uploaded = await uploadExportCsv(csv, `${label}-${format}`)
        url = uploaded.url
        expire = uploaded.expiresAt.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
      } catch (err) {
        console.error('Export upload failed:', err)
        return `名單整理好了（${summary}），但產生下載連結時失敗，可能是 Firebase Storage 設定有問題。請先到後台 /admin/contacts 用「匯出 Excel」取得名單。錯誤訊息：${String(err).slice(0, 120)}`
      }

      await pushMessage(lineUserId, `📥 ${label}\n${summary}\n\n${url}\n\n（連結 ${expire} 前有效，過期跟我說一聲重新產生）`)
      return `已送出「${label}」的下載連結。連結已顯示給使用者，你的回覆一句話帶過即可，不要重複貼網址。`
    },
  }
}

// ── 系統提示 ────────────────────────────────────────────────
function systemPrompt(): string {
  const now = new Date()
  const dateStr = now.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit',
  })
  const { business, assistantName } = profile

  return `你是「${assistantName}」，透過 LINE 幫主人整理名片與人脈的 AI 助理。

現在時間：${dateStr}（Asia/Taipei）。解析「明天」「下週三」等相對時間時以此為準。

主人的背景：
- 身分：${business.role}
- 提供的服務：${business.services}
- 目標客戶：${business.targetCustomers}
- 其他背景：${business.context}

你的職責：
1. 名片管理：搜尋聯絡人、更新跟進狀態、記筆記、修正辨識錯誤、修改認識場合、回報統計
2. 展場支援：開關展場模式、產出戰果報告
3. 跟進支援：批次起草跟進訊息、匯出名單

行為準則：
- 動手前先用工具查證，不要憑空猜測名片庫內容
- 使用者的口語要主動理解意圖：「我剛跟王大明通過電話」等於更新狀態為已聯絡
- 一句話可能包含多個動作（例如「跟王大明聊完了，他想做官網，下週再約」等於更新狀態加記筆記），全部都要執行
- 找不到聯絡人時，告訴使用者最接近的搜尋結果，不要瞎猜
- 使用者想對某個人採取行動時，優先用 show_contact_cards，卡片上的按鈕比打字快
- 展覽或聚會這種要連續掃很多張名片的場合，主動建議開啟展場模式；使用者說收攤就提醒他關掉
- 收攤（end_expo_mode）會自動送出戰果報告，不用再另外呼叫 get_expo_report
- 活動後的完整動線是：戰果報告 → 批次起草跟進 → 匯出名單。使用者看完報告後主動提醒他可以接著做
- 合併重複名片一定要兩步：先 preview_duplicate_contacts 送出卡片，等使用者按按鈕或明確說要合併哪些，才 apply_duplicate_merges。絕不可以跳過確認直接合併
- 掃名片時「姓名與電話都相同」會自動合併，這是刻意的，不需要問。但「手機相同而姓名不同」永遠不自動合併，因為同公司不同人共用號碼是真的會發生
- 使用者說「合併錯了」「那不是同一個人」時用 undo_merge，被併掉的名片都留著沒有刪除
- 無法確定使用者意圖時，簡短問清楚，不要長篇大論

回覆格式（LINE 純文字）：
- 繁體中文，口語自然，簡潔，不用 Markdown 符號
- 適度用表情符號開頭標記類型（✅ 完成、🔍 搜尋結果、✍️ 草稿、⚠️ 問題）
- 條列用「・」，一行一句，不要擠成一團
- 聚焦在使用者要的東西，不要重複多餘客套`
}

// ── 主入口：tool-calling 迴圈 ───────────────────────────────
const MAX_ITERATIONS = 8

export async function runAgent(lineUserId: string, userText: string): Promise<string> {
  const history = await getHistory(lineUserId)
  const handlers = buildHandlers(lineUserId)

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt() },
    ...history.map(t => ({ role: t.role, content: t.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: 'user', content: userText },
  ]

  let answer = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await getOpenAI().chat.completions.create({
      model: AGENT_MODEL,
      messages,
      tools: TOOL_DEFS,
    })

    const message = response.choices[0].message
    messages.push(message)

    const toolCalls = (message.tool_calls || []).filter(tc => tc.type === 'function')
    if (toolCalls.length === 0) {
      answer = message.content?.trim() || ''
      break
    }

    for (const call of toolCalls) {
      const handler = handlers[call.function.name]
      let result: string
      if (!handler) {
        result = `錯誤：沒有這個工具（${call.function.name}）。`
      } else {
        try {
          result = await handler(JSON.parse(call.function.arguments || '{}'))
        } catch (err) {
          console.error(`Tool ${call.function.name} failed:`, err)
          result = `工具執行失敗：${err instanceof Error ? err.message : '未知錯誤'}。請告訴使用者這個動作沒有成功。`
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  if (!answer) answer = '⚠️ 這件事我處理太久了，可以說得更具體一點嗎？'

  await appendExchange(lineUserId, userText, answer)
  return answer
}
