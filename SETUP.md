# 安裝指南

從零到可以用，大約一小時。

照順序做，**不要跳步驟**，後面的步驟會用到前面拿到的東西。

---

## 步驟 1：LINE 機器人

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 用你的 LINE 帳號登入
2. 建立一個 **Provider**（名字隨便取，例如你的公司名）
3. 在這個 Provider 底下建立 **Messaging API** 頻道
4. 到 **Basic settings** 分頁，複製 **Channel secret**
5. 到 **Messaging API** 分頁，捲到最底部，按 **Issue** 發行 **Channel access token**

> 這個 token 視窗關掉就看不到了，先貼到記事本。

6. 同一頁往上找 **Auto-reply messages**，點進去**關閉自動回覆**

> 不關的話罐頭訊息會蓋掉機器人的回覆，症狀很像壞掉。

---

## 步驟 2：Firebase

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立專案
2. 左側 **Firestore Database** → 建立資料庫 → 地區選 **asia-east1（台灣）**
3. 左側 **Storage** → 開始使用 → 地區一樣選 **asia-east1**

> ⚠️ 地區建立之後**不能更改**，選錯只能砍掉重建。

4. 左上齒輪 → **專案設定** → **服務帳戶** → **產生新的私密金鑰**，會下載一個 JSON
5. 打開那個 JSON，裡面的 `project_id`、`client_email`、`private_key` 等一下要用
6. 回到 Storage 頁面，複製最上方的 bucket 名稱（長得像 `你的專案.firebasestorage.app`）

---

## 步驟 3：OpenAI

1. 到 [platform.openai.com/api-keys](https://platform.openai.com/api-keys) 建立 API key
2. 到 **Billing** 儲值，建議先存 20 美元

> 不儲值的話機器人會回「credit balance 不足」。單人使用一個月大概 5 到 15 美元。

---

## 步驟 4：部署到 Vercel

1. 把這個專案推到你自己的 GitHub repo
2. 到 [Vercel](https://vercel.com/new) 匯入那個 repo
3. 先不要按 Deploy，到 **Environment Variables** 把 `.env.example` 裡的項目全部填好

`NEXT_PUBLIC_BASE_URL` 先隨便填，部署完拿到網址再回來改。

4. 按 Deploy，記下拿到的網址

---

## 步驟 5：Google 日曆授權

這一步讓機器人能自動判斷「這張名片是在哪認識的」。

1. 到 [Google Cloud Console](https://console.cloud.google.com/) → 選到步驟 2 建立的那個專案
2. **API 與服務** → **程式庫** → 搜尋 **Google Calendar API** → 啟用
3. **API 與服務** → **OAuth 同意畫面** → 選「外部」→ 填基本資料 → 測試使用者加上你自己的 Gmail
4. **API 與服務** → **憑證** → 建立 **OAuth 用戶端 ID** → 類型選「網頁應用程式」
5. **已授權的重新導向 URI** 填：

```
https://你的vercel網址/api/auth/google/callback
```

6. 把拿到的 Client ID 與 Client Secret 填回 Vercel 環境變數

---

## 步驟 6：接上 webhook

1. 回到 LINE Developers 的 **Messaging API** 分頁
2. **Webhook URL** 填：

```
https://你的vercel網址/api/line/webhook
```

3. 打開 **Use webhook**
4. 按 **Verify**，應該回 Success

---

## 步驟 7：補上白名單與重新部署

1. 用手機加機器人好友，隨便傳一則訊息
2. 到 Vercel 的 **Logs** 找到你的 LINE userId（`U` 開頭的 33 碼）
3. 填進環境變數 `ALLOWED_LINE_USER_IDS`

> ⚠️ **這步不要省略。** 不設白名單等於任何人加好友都能用，燒的是你的 OpenAI 費用。

4. 順便把 `NEXT_PUBLIC_BASE_URL` 改成真正的網址
5. **重新部署**（Vercel 改環境變數後一定要重新部署才生效）

---

## 步驟 8：上架圖文選單

1. 本機產生選單底圖：

```bash
pip3 install pillow
python3 scripts/generate-richmenu.py
```

2. 把產生的 `public/richmenu.png` 一起 commit 並推上去，等 Vercel 部署完
3. 登入後台 `https://你的網址/admin`，用你設定的 `ADMIN_PASSWORD`
4. 呼叫上架端點：

```bash
curl -X POST https://你的網址/api/admin/richmenu -H "Cookie: admin_token=從瀏覽器開發者工具複製"
```

> 順序不能顛倒：底圖是從線上抓的，沒先部署會傳到舊圖或失敗。

---

## 驗收

傳一張名片給機器人，你應該收到：

1. 「📷 分析中...」
2. 一張卡片，上面有名片原圖、姓名、公司、評分、場合

接著試試：

```
找 剛剛那家公司
跟進
統計
```

---

## 出問題時

先跑健康檢查，一次確認環境變數、LINE token、Firestore、OpenAI 四項：

```bash
curl -H "Authorization: Bearer 你的CRON_SECRET" https://你的網址/api/health
```

全過回 200，任一項掛掉回 503 並告訴你是哪一項。

### 常見狀況

| 症狀 | 多半是 |
|---|---|
| 完全沒回應 | LINE token 失效，或 Use webhook 沒開 |
| 回罐頭訊息 | Auto-reply messages 沒關 |
| 回「發生錯誤」 | 環境變數少填，跑健康檢查看是哪一項 |
| 名片圖顯示不出來 | `FIREBASE_STORAGE_BUCKET` 填錯 |
| 場合一直是「未判定」 | 日曆沒授權，或當下日曆上沒有行程 |
