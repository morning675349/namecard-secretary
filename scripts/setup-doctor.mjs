// 安裝健檢：檢查設定值的格式，並實際打 API 確認服務活著。
//
// 用法：
//   node scripts/setup-doctor.mjs              # 只檢查格式（不連外，很快）
//   node scripts/setup-doctor.mjs --live       # 再加上實際呼叫 LINE 與 OpenAI
//   node scripts/setup-doctor.mjs --live --url https://你的網址   # 連線上的健康檢查
//
// 讀 .env.local。還沒有這個檔案的話，先 cp .env.example .env.local 再填。
//
// 刻意零套件依賴，只用 Node 內建功能，因為這支要在「什麼都還沒裝好」
// 的狀態下跑得起來。npm install 失敗的人更需要它。
//
// 設計原則：每一條檢查都要說出「怎麼修」，不是只說「錯了」。
// 看得懂錯誤訊息的人不需要這支腳本。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const URL_ARG = args.includes('--url') ? args[args.indexOf('--url') + 1] : ''

const results = []
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail })
const warn = (name, detail) => results.push({ level: 'warn', name, detail })
const fail = (name, detail) => results.push({ level: 'fail', name, detail })

// ── 讀設定 ────────────────────────────────────────────────

const envPath = path.join(ROOT, '.env.local')
if (!fs.existsSync(envPath)) {
  console.log('找不到 .env.local。')
  console.log('先執行：cp .env.example .env.local')
  console.log('然後照 SETUP.md 把 13 項填好，再跑一次這支。')
  process.exit(1)
}

/** 簡單的 .env 解析。值可以加引號，也支援 private key 那種含 \n 的長字串 */
function parseEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

const env = parseEnv(fs.readFileSync(envPath, 'utf8'))
const get = k => (env[k] || '').trim()

// ── 格式檢查 ──────────────────────────────────────────────

const REQUIRED = [
  'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'ALLOWED_LINE_USER_IDS',
  'OPENAI_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY', 'FIREBASE_STORAGE_BUCKET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'ADMIN_PASSWORD', 'CRON_SECRET', 'NEXT_PUBLIC_BASE_URL',
]

const missing = REQUIRED.filter(k => !get(k))
if (missing.length) {
  fail('必填項目', `這 ${missing.length} 項還沒填：${missing.join('、')}\n     每一項怎麼拿見 SETUP.md`)
} else {
  ok('必填項目', `13 項都有填`)
}

// LINE
const secret = get('LINE_CHANNEL_SECRET')
if (secret && !/^[0-9a-f]{32}$/i.test(secret)) {
  fail('LINE_CHANNEL_SECRET', `應該是 32 碼十六進位，現在是 ${secret.length} 碼。\n     位置：Basic settings 分頁，不是 Messaging API 分頁`)
} else if (secret) ok('LINE_CHANNEL_SECRET')

const token = get('LINE_CHANNEL_ACCESS_TOKEN')
if (token && token.length < 100) {
  fail('LINE_CHANNEL_ACCESS_TOKEN', `太短（${token.length} 碼），正常是一百多碼。\n     要的是 Messaging API 分頁最底部的 long-lived token，不是 Channel ID`)
} else if (token) ok('LINE_CHANNEL_ACCESS_TOKEN')

const allow = get('ALLOWED_LINE_USER_IDS')
if (allow === 'PLACEHOLDER') {
  warn('ALLOWED_LINE_USER_IDS', '還是 PLACEHOLDER。部署後傳一則訊息給機器人，\n     到 Vercel Logs 找 "Blocked non-allowlisted user: U..." 換掉它')
} else if (allow) {
  const bad = allow.split(',').map(s => s.trim()).filter(s => s && !/^U[0-9a-f]{32}$/i.test(s))
  if (bad.length) fail('ALLOWED_LINE_USER_IDS', `這些格式不對：${bad.join('、')}\n     應該是 U 開頭加 32 碼十六進位，共 33 碼`)
  else ok('ALLOWED_LINE_USER_IDS', `${allow.split(',').length} 個使用者`)
}

// OpenAI
const oai = get('OPENAI_API_KEY')
if (oai && !oai.startsWith('sk-')) {
  fail('OPENAI_API_KEY', '應該以 sk- 開頭。別貼成 Organization ID 或 Project ID')
} else if (oai) ok('OPENAI_API_KEY')

// Firebase：這一組是最常出錯的
const projectId = get('FIREBASE_PROJECT_ID')
const clientEmail = get('FIREBASE_CLIENT_EMAIL')

if (projectId && /\s/.test(projectId)) {
  fail('FIREBASE_PROJECT_ID', `裡面有空白字元：「${projectId}」\n     專案 ID 不會有空格，多半是把「專案名稱」當成「專案 ID」貼了`)
} else if (projectId) ok('FIREBASE_PROJECT_ID', projectId)

if (clientEmail && !clientEmail.includes('@')) {
  fail('FIREBASE_CLIENT_EMAIL', '不是信箱格式。這一項在下載的金鑰 JSON 裡叫 client_email')
} else if (clientEmail && projectId) {
  // 服務帳戶信箱的網域段就是真正的專案 ID，兩者對不上代表有一個貼錯了。
  // 這條檢查是整支腳本最有價值的一條：本機連不上 Firestore 但正式環境正常，
  // 症狀完全不像設定錯，可以查上好幾個月。
  const domain = clientEmail.split('@')[1] || ''
  const idFromEmail = domain.replace('.iam.gserviceaccount.com', '')
  if (idFromEmail && idFromEmail !== projectId) {
    fail('Firebase 專案 ID 對不上',
      `FIREBASE_PROJECT_ID 是「${projectId}」，\n` +
      `     但服務帳戶信箱顯示真正的專案 ID 是「${idFromEmail}」。\n` +
      `     信箱的網域段才是對的，把 FIREBASE_PROJECT_ID 改成 ${idFromEmail}`)
  } else {
    ok('Firebase 專案 ID 一致', `${projectId} 與服務帳戶信箱相符`)
  }
}

const pk = get('FIREBASE_PRIVATE_KEY')
if (pk) {
  if (!pk.includes('BEGIN PRIVATE KEY')) {
    fail('FIREBASE_PRIVATE_KEY', '少了 -----BEGIN PRIVATE KEY----- 開頭，大概只複製到一部分')
  } else if (!pk.includes('\\n') && !pk.includes('\n')) {
    fail('FIREBASE_PRIVATE_KEY', '裡面沒有換行。從 JSON 複製時要連 \\n 一起帶上，不要手動刪掉')
  } else ok('FIREBASE_PRIVATE_KEY')
}

const bucket = get('FIREBASE_STORAGE_BUCKET')
if (bucket && !/\.(appspot\.com|firebasestorage\.app)$/.test(bucket)) {
  fail('FIREBASE_STORAGE_BUCKET', `「${bucket}」看起來不像 bucket 名稱。\n     應該長得像 你的專案.firebasestorage.app，在 Firebase 的 Storage 頁面最上方\n     也不要加 gs:// 前綴`)
} else if (bucket) ok('FIREBASE_STORAGE_BUCKET')

// Google
const gid = get('GOOGLE_CLIENT_ID')
if (gid && !gid.endsWith('.apps.googleusercontent.com')) {
  fail('GOOGLE_CLIENT_ID', '應該以 .apps.googleusercontent.com 結尾')
} else if (gid) ok('GOOGLE_CLIENT_ID')

// 後台與網址
const pw = get('ADMIN_PASSWORD')
if (pw && pw.length < 12) {
  warn('ADMIN_PASSWORD', `只有 ${pw.length} 碼。這組密碼擋的是你所有客戶的聯絡資料，建議 16 碼以上`)
} else if (pw) ok('ADMIN_PASSWORD')

const cron = get('CRON_SECRET')
if (cron && cron.length < 32) {
  warn('CRON_SECRET', `只有 ${cron.length} 碼，建議用 openssl rand -hex 32 產生`)
} else if (cron) ok('CRON_SECRET')

const base = URL_ARG || get('NEXT_PUBLIC_BASE_URL')
if (base) {
  if (!base.startsWith('https://')) fail('NEXT_PUBLIC_BASE_URL', '要用 https:// 開頭')
  else if (base.endsWith('/')) fail('NEXT_PUBLIC_BASE_URL', '結尾不要加斜線，會讓組出來的網址變成兩條斜線')
  else ok('NEXT_PUBLIC_BASE_URL', base)
}

// ── 實際連線檢查 ──────────────────────────────────────────

async function live() {
  if (token) {
    try {
      const r = await fetch('https://api.line.me/v2/bot/info', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        const info = await r.json()
        ok('LINE 連線', `機器人「${info.displayName}」`)
      } else {
        fail('LINE 連線', `HTTP ${r.status}。token 失效了，到 Messaging API 分頁最底部重新 Issue 一次`)
      }
    } catch (e) {
      fail('LINE 連線', `連不上：${e.message}`)
    }
  }

  if (oai) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${oai}` },
      })
      if (r.ok) ok('OpenAI 連線')
      else if (r.status === 401) fail('OpenAI 連線', 'key 不對或已撤銷')
      else fail('OpenAI 連線', `HTTP ${r.status}`)
    } catch (e) {
      fail('OpenAI 連線', `連不上：${e.message}`)
    }
  }

  if (base && cron) {
    try {
      const r = await fetch(`${base}/api/health`, {
        headers: { Authorization: `Bearer ${cron}` },
      })
      const body = await r.text()
      if (r.ok) ok('線上健康檢查', '四個子系統都正常')
      else fail('線上健康檢查', `HTTP ${r.status}：${body.slice(0, 300)}`)
    } catch (e) {
      warn('線上健康檢查', `還沒部署或連不上（${e.message}），部署完再跑一次`)
    }
  }
}

// ── 輸出 ──────────────────────────────────────────────────

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌' }

async function main() {
  if (LIVE) await live()

  console.log('')
  for (const r of results) {
    console.log(`${ICON[r.level]} ${r.name}${r.detail ? `：${r.detail}` : ''}`)
  }

  const fails = results.filter(r => r.level === 'fail').length
  const warns = results.filter(r => r.level === 'warn').length
  console.log('')
  if (fails) {
    console.log(`${fails} 項要修，${warns} 項提醒。照上面每一條的說明修完再跑一次。`)
  } else if (warns) {
    console.log(`格式都正確，${warns} 項提醒可以先往下走。`)
  } else {
    console.log('全部通過。')
  }
  if (!LIVE) console.log('加上 --live 可以實際呼叫 LINE 與 OpenAI 確認服務活著。')

  process.exit(fails ? 1 : 0)
}

main()
