import { getOpenAI, AGENT_MODEL } from './ai'
import { profile } from '../config/profile'

// 名片辨識與 CRM 評估。
//
// 評分、分類、跟進建議全部由 config/profile.ts 驅動，
// 這個檔案本身不該出現任何特定行業的字眼。要改判斷邏輯請改設定檔。

export interface CardData {
  nameZh: string
  nameEn: string
  company: string
  companyEn: string
  title: string
  titleEn: string
  mobile: string
  officePhone: string
  fax: string
  email: string
  address: string
  website: string
  services: string[]
  industry: '製造業' | '貿易商' | '服務業' | '科技' | '設計創意' | '金融法律' | '建築營造' | '餐飲零售' | '其他'
  companySize: '微型' | '小型' | '中型' | '大型' | '不明'
  score: number
  category: string
  /** 是否符合 profile.specialOpportunity；沒設定機會時固定為 false */
  opportunityMatch: boolean
  /** 符合的理由與切入建議；不符合或沒設定機會時為空字串 */
  opportunityNote: string
  followUpDays: number
  followUpSuggestion: string
  reasoning: string
  /** 辨識沒有十足把握的欄位，讓使用者當場就能發現錯誤 */
  uncertainFields: string[]
}

const INDUSTRIES = ['製造業', '貿易商', '服務業', '科技', '設計創意', '金融法律', '建築營造', '餐飲零售', '其他'] as const
const COMPANY_SIZES = ['微型', '小型', '中型', '大型', '不明'] as const

// ── 台灣人名辨識規則 ────────────────────────────────────────
// 這段與使用者的行業無關，是所有台灣使用者都需要的共通資產，不要刪。
const NAME_RULES = `━━━ 人名辨識（最關鍵，必須逐偏旁確認） ━━━
台灣人名大量使用罕見字，絕不能用「看起來像」的常見字代替。

步驟：先認偏旁（左邊或上下部首），再認右邊字根，最後確認整字。

常見混淆字（左邊是正確字，右邊是錯誤替代）：
・瀞 ≠ 靜　　有三點水氵，靜沒有水旁
・瑀 ≠ 媛　　有王字旁玉，右邊是禹
・婕 ≠ 媛/娟　女字旁，右邊是捷的右半「疌」，不是爰
・皓 ≠ 倍/晧　白字旁，右邊是告，不是人字旁
・燁 ≠ 傑/葉　火字旁，不是人字旁
・鎧 ≠ 銘/鉞　金字旁，右邊是愷的右半
・瑋 ≠ 煒　　　王字旁玉，不是火字旁

規則：
1. 先看偏旁（氵水、玉王、女、火、金），偏旁錯了整字就錯
2. 若有英文或拼音，必須交叉驗證（Jing → 看偏旁決定是瀞還是靜）
3. 不確定就列進 uncertainFields，絕不用常見字硬替代罕見字

━━━ 電話辨識 ━━━
- 台灣手機：09 開頭共 10 碼，格式 09xx-xxxxxx
- 市話：區碼（02/03/04/06/07/08）加 7 到 8 碼
- 完整抄寫所有數字，看到多組電話分別填入 mobile 與 officePhone`

const UNCERTAIN_RULES = `━━━ 關於 uncertainFields（很重要） ━━━
這個欄位決定使用者會不會當場發現辨識錯誤。
光線差、角度歪、名片有燙金或藝術字體時辨識本來就會不準，這不是問題；
不講出來才是問題，因為使用者要等好幾週後聯絡不到人才發現。

符合以下任一條就要列進去，寧可多列不要少列：
- 人名含罕見字、靠上下文猜的、或中英文對不起來
- 字跡被反光、陰影、摺痕、手指遮到
- 電話位數看不清楚或可能漏字
- 公司全名與商標字樣不一致，不確定該用哪個

全部都很確定時填空陣列。`

function buildSystemPrompt(): string {
  const { business, categories, categoryRules, scoringRules, followUpDays, specialOpportunity } = profile

  const opportunitySection = specialOpportunity
    ? `━━━ 特別機會標記 ━━━
使用者另外在推廣「${specialOpportunity.name}」：${specialOpportunity.description}
適合的對象：${specialOpportunity.matchCriteria}

- 符合上述條件時 opportunityMatch 填 true
- opportunityNote 用一句話說明為什麼適合，以及建議的切入角度
- 不符合時 opportunityMatch 填 false、opportunityNote 填空字串`
    : `━━━ 特別機會標記 ━━━
使用者沒有設定特別想媒合的機會。
opportunityMatch 一律填 false，opportunityNote 一律填空字串。`

  return `你是一個商業名片 OCR 與 CRM 分析助手。你的任務是：
1. 精確辨識名片上的所有文字
2. 將資訊解析成結構化 JSON
3. 根據使用者的業務背景對這位聯絡人做 CRM 評估

${NAME_RULES}

━━━ 使用者的業務背景 ━━━
- 身分：${business.role}
- 提供的服務：${business.services}
- 目標客戶：${business.targetCustomers}
- 其他背景：${business.context}

━━━ 評分標準（1 到 10） ━━━
${scoringRules.map(r => `- ${r}`).join('\n')}

━━━ 分類規則（只選一個） ━━━
${categoryRules.map(r => `- ${r}`).join('\n')}
可選值：${categories.join('、')}

${opportunitySection}

━━━ 跟進天數 ━━━
- 7 分以上：${followUpDays.high} 天
- 4 到 6 分：${followUpDays.medium} 天
- 3 分以下：${followUpDays.low} 天

${UNCERTAIN_RULES}

回傳 JSON，欄位說明：
- nameZh / nameEn：中英文姓名，沒有則空字串
- company / companyEn：公司中英文名稱
- title / titleEn：中英文職稱
- mobile / officePhone / fax：各類電話
- email / address / website：聯絡資訊
- services：名片上列出的服務項目或產品（陣列）
- industry：從 ${INDUSTRIES.join('、')} 選一個
- companySize：微型（<10人）、小型（10-50）、中型（50-200）、大型（200+）、不明
- score：評分 1 到 10
- category：主分類
- opportunityMatch / opportunityNote：見上方特別機會標記
- followUpDays：跟進天數
- followUpSuggestion：具體跟進建議，一句話
- reasoning：評分理由，一句話
- uncertainFields：沒把握的欄位英文名陣列

未識別的欄位填空字串或空陣列。`
}

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    nameZh: { type: 'string' },
    nameEn: { type: 'string' },
    company: { type: 'string' },
    companyEn: { type: 'string' },
    title: { type: 'string' },
    titleEn: { type: 'string' },
    mobile: { type: 'string' },
    officePhone: { type: 'string' },
    fax: { type: 'string' },
    email: { type: 'string' },
    address: { type: 'string' },
    website: { type: 'string' },
    services: { type: 'array', items: { type: 'string' } },
    industry: { type: 'string', enum: INDUSTRIES },
    companySize: { type: 'string', enum: COMPANY_SIZES },
    score: { type: 'integer' },
    // 分類選項直接取自設定檔，改設定檔就會跟著變
    category: { type: 'string', enum: profile.categories },
    opportunityMatch: { type: 'boolean' },
    opportunityNote: { type: 'string' },
    followUpDays: { type: 'integer' },
    followUpSuggestion: { type: 'string' },
    reasoning: { type: 'string' },
    uncertainFields: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'nameZh', 'nameEn', 'company', 'companyEn', 'title', 'titleEn',
    'mobile', 'officePhone', 'fax', 'email', 'address', 'website',
    'services', 'industry', 'companySize', 'score', 'category',
    'opportunityMatch', 'opportunityNote', 'followUpDays',
    'followUpSuggestion', 'reasoning', 'uncertainFields',
  ],
  additionalProperties: false,
} as const

export async function analyzeCard(imageBuffer: Buffer): Promise<CardData> {
  const base64 = imageBuffer.toString('base64')

  const response = await getOpenAI().chat.completions.create({
    model: AGENT_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
          { type: 'text', text: '請仔細辨識名片上所有資訊，回傳完整 JSON。所有欄位都必須填寫，沒有資訊的欄位填空字串或空陣列。' },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'business_card', strict: true, schema: CARD_SCHEMA },
    },
  })

  const raw = response.choices[0].message.content
  if (!raw) throw new Error('名片辨識沒有回傳內容')
  return JSON.parse(raw) as CardData
}
