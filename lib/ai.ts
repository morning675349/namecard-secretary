import OpenAI from 'openai'

// AI 客戶端（名片辨識與對話大腦共用）。
//
// ⚠️ 刻意延遲建立，不要改回模組載入時就 new。
// OpenAI 的建構子在缺金鑰時會直接丟錯，而 Next.js 在 build 階段會載入每個
// route 模組來收集設定，結果就是「還沒設定環境變數就連 build 都過不了」，
// 而且錯誤訊息完全看不出是缺金鑰。

let client: OpenAI | null = null

export function getOpenAI(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('缺少環境變數 OPENAI_API_KEY，請參考 .env.example')
    client = new OpenAI({ apiKey })
  }
  return client
}

// 使用的模型。要升級只改這一行，名片辨識與對話會一起套用。
export const AGENT_MODEL = 'gpt-5.5'
