# 給 AI 助理的設定指引

這份是寫給 **Claude Code、Codex 或任何 AI 編碼助理**看的。

如果使用者把這個資料夾丟給你，說「幫我改成我自己的版本」，照下面做。

人類使用者請看 [README.md](README.md) 與 [SETUP.md](SETUP.md)。

---

## 這是什麼

給 B2B 業務用的 LINE 機器人：拍名片 → AI 辨識 → 自動建檔 → 重複自動合併 → 提醒跟進 → 匯出名單。

技術棧：Next.js（App Router）+ Firebase（Firestore 與 Storage）+ OpenAI + LINE Messaging API，部署在 Vercel。

---

## 你要做的事，照順序

### 第 1 步：先訪談，不要直接改

**不要憑空填設定。** 先問使用者這五件事，問完再動手：

1. 你公司賣什麼？產品或服務是什麼？
2. 你想找什麼樣的客戶？（產業、公司規模、哪個部門的窗口）
3. 你平常在哪些場合收名片？（展覽、商會、客戶拜訪、協會活動⋯⋯）
4. 你希望名片怎麼分類？想得到的就講，想不到我給預設
5. 有沒有特別想推的產品線或代理品牌？（沒有就跳過）

問題四五使用者答不出來時，用預設值往下走，不要卡在這裡反覆追問。

### 第 2 步：只改這一個檔案

**`config/profile.ts`**

這是整個專案唯一需要為使用者客製的檔案。把訪談結果填進去。

填寫要點：

- `business` 四個欄位寫得越具體，名片評分越準。寫「做網頁的」不如寫「客製化網站規劃與 SEO，服務中小企業主與工廠」
- `categories` 和 `categoryRules` **必須一起改**，數量與順序要對應
- `scoringRules` 寫成「幾分的人長什麼樣」，不要寫抽象原則
- `fixedSources` 填使用者最常去的三個場合，會變成掃完名片的快速按鈕
- `specialOpportunity` 沒有就保持 `null`，不要硬掰一個

### 第 3 步：不要動這些

除非使用者明確要求新增功能，否則下列檔案不要改：

| 檔案 | 為什麼不要動 |
|---|---|
| `lib/card-analyzer.ts` 的 `NAME_RULES` | 台灣罕見字的偏旁辨識規則，所有台灣使用者都需要，刪了辨識率會掉 |
| `lib/card-analyzer.ts` 的 `UNCERTAIN_RULES` | 讓 AI 誠實回報沒把握的欄位。拿掉之後辨識錯誤會變成靜默錯誤，使用者要幾週後才發現 |
| `lib/event-matching.ts` | 場合判定邏輯，有 15 個測試在保護 |
| `lib/expo-report.ts` | 跟進排序邏輯，有測試在保護 |
| `lib/csv.ts` | 含 UTF-8 BOM 與公式注入防護，改壞會讓 Excel 亂碼或產生資安漏洞 |
| `lib/contact-merge.ts` | 去重規則，有 24 個測試在保護。特別是「只有公司電話相同不處理」那條，放寬會產生永久性的誤判提示 |
| `lib/cron-auth.ts` | 環境變數未設定時 fail closed，不要改成放行 |
| `lib/admin-session.ts` | 後台登入的 HMAC 與常數時間比對 |

### 第 4 步：驗證

```bash
npm install
npm test          # 應該全部通過
npx tsc --noEmit  # 應該零錯誤
npm run build     # 應該 Compiled successfully
```

`npm test` 只涵蓋純邏輯模組（場合判定、戰果排序、CSV、卡片組裝、批次處理）。

碰外部服務的部分（OCR、LINE、Firebase）沒有單元測試，只能部署後實測。

### 第 5 步：引導部署

照 [SETUP.md](SETUP.md) 一步一步帶使用者做。

**最常見的卡關點，先提醒他：**

1. **Firebase 地區選錯**。Firestore 和 Storage 都要選 `asia-east1`，建立之後不能改
2. **環境變數少填**。`.env.example` 裡 11 項全部必填，少一項就有功能無聲壞掉
3. **LINE 的 Auto-reply messages 要關閉**，否則罐頭訊息會蓋掉機器人的回覆
4. **Vercel 改完環境變數要重新部署才生效**
5. **`ALLOWED_LINE_USER_IDS` 一定要設**。不設等於任何人加好友都能用，燒的是使用者的 OpenAI 費用

---

## 使用者想加功能時

這套架構有三個慣例，加功能時請遵守，不然會跟既有程式碼打架。

### 慣例一：會出錯的判斷邏輯要抽成純函式

`lib/` 底下的 `event-matching`、`expo-report`、`csv`、`flex`、`batch` 都是**零 I/O 純函式**，所以可以單獨測試，`npm test` 跑完只要幾十毫秒。

新增判斷邏輯（排序、分級、格式化、解析）請照這個形狀寫，並附測試。

碰外部服務的那層（`contact-service`、`line-client`、`google-calendar`）靠型別與線上驗證，不寫單元測試。

### 慣例二：不要用 Firestore 複合查詢

`where` 加 `orderBy` 需要另外建索引，沒建會整支拋錯，而且錯誤常被 try/catch 吞掉變成靜默失敗。

**一律只用單一 `where('lineUserId', '==', ...)`，其餘條件全撈進記憶體過濾。**

資料量到幾千筆再來煩惱效能。

### 慣例三：失敗不能靜默

對外部服務的呼叫一定要檢查回應並寫 log。

`lib/line-client.ts` 的 `callLineApi` 就是範例：LINE 回非 2xx 時會丟例外並在 log 寫明原因（包含「token 已失效，請重新發行」這種可執行的提示）。

不要為了讓流程「看起來順」而把錯誤吞掉。

---

## 架構速查

```
config/profile.ts          ← 唯一要客製的檔案
lib/
  card-analyzer.ts         名片 OCR 與 CRM 評估（由 profile 驅動）
  agent.ts                 對話大腦，19 個工具
  contact-service.ts       Firestore 資料層
  event-matching.ts        從日曆判定「在哪認識的」（純函式）
  expo-mode.ts             展場模式狀態
  expo-report.ts           戰果報告與跟進排序（純函式）
  drafts.ts                批次起草跟進訊息
  csv.ts                   名單匯出（純函式）
  flex.ts                  LINE 卡片組裝（純函式）
  contact-merge.ts         重複名片的判斷與合併計畫（純函式）
  error-log.ts             例外寫進 Firestore，後台讀得到
  batch.ts                 限流並行加時間預算（純函式）
  dedup.ts                 事件去重，避免 LINE 重送造成重複建檔
  line-client.ts           LINE API 封裝
  richmenu.ts              圖文選單定義
app/api/line/webhook/      LINE 進入點
app/api/cron/daily-briefing/  每日跟進提醒，順便清過期錯誤紀錄
app/api/admin/errors/      讀錯誤紀錄
app/api/admin/validate-flex/  用 LINE 官方端點驗證卡片格式
app/admin/                 後台（列表、編輯、匯出 Excel）
scripts/generate-richmenu.py  產生選單底圖
```

---

## 重要的設計取捨，不要「優化」掉

**掃名片只回兩則訊息，而且不問問題。**
早期版本一張名片回四則、其中兩則要使用者回答，展場上完全無法使用。
不要為了「收集更完整的資料」而加回追問。

**結果卡片上一定要有名片原圖。**
辨識錯誤真正的代價不是會錯，是使用者當下不知道它錯了。
原圖擺在解析結果旁邊，錯誤當場看得出來。不要為了版面乾淨拿掉。

**動到 Flex 卡片就要在 `/api/admin/validate-flex` 加對應的案例。**
不是「部署後跑一次既有的驗證」，那擋不住新增的分支。
曾經有一個 `inputOption` 寫了 LINE 不存在的值，整張卡片被退 400，
使用者只看到「發生錯誤」，而名片其實已經建檔成功。卡片上線十一天才第一次被真的用到。
能用測試守門的就寫測試（測試會跟著程式碼一起被迫更新），驗證端點補測試驗不到的 LINE 規格。

**「手機相同但姓名不同」永遠不要改成自動合併。**
同公司不同人共用總機或分機是真的會發生，實測資料裡就有。
誤判一次，使用者就會開始忽略所有合併提示，真正的重複也跟著被忽略。

**圖文選單有三顆按鈕刻意不走 AI。**
「掃名片」是固定回覆，「找人」和「匯出名單」只叫出鍵盤。
這省下 API 費用也省下十幾秒等待。不要為了統一而把它們改成走 agent。

**批次處理的時間預算要比函式上限小很多。**
`BATCH_BUDGET_MS` 設 32 秒而函式上限 60 秒，不是算錯。
deadline 只擋「還沒開始」的工作，已經開跑的那張還要跑完，再加收尾推播。

**OpenAI 客戶端一定要延遲建立。**
`lib/ai.ts` 用 `getOpenAI()` 而不是模組載入時就 `new OpenAI(...)`。
OpenAI 建構子缺金鑰會直接丟錯，而 Next.js build 階段會載入每個 route 模組，
結果就是「還沒設定環境變數連 build 都過不了」，錯誤訊息還看不出是缺金鑰。
專案必須在零設定的狀態下 `npm run build` 成功，這是模板的基本要求。
