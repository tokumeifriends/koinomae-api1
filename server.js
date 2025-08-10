import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());            // フロントからのアクセス許可（CORS）
app.use(express.json());

// 返信生成（LLM）
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body; // [{role, content}...]
    const system = `
あなたは大学1年の「あかね」。優しく自然体。
- 日本語で返答。ため口8割・敬語2割
- 10〜50字、要所で質問もする（連続質問しすぎない）
- 個人情報請求/露骨な表現/オフライン誘導は拒否して別案を提案
    `.trim();

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: system }, ...messages],
        max_tokens: 180,
        temperature: 0.7
      })
    });

    const data = await openaiRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "うん、なるほど。続き聞かせて？";

    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "chat_failed" });
  }
});

// 採点（会話ログ→指標→チャットスコア0-20）
app.post("/score", async (req, res) => {
  try {
    const { transcript } = req.body; // 文字列で会話ログ
    const system = `
会話から各指標を0-100で採点し、JSONのみ出力。
{"scores":{"initiative":0-100,"self_disclosure":0-100,"empathy":0-100,"clarity":0-100,"pace_balance":0-100,"hesitation":0-100},"flags":{"safety":true/false},"suggestion":"日本語20-60字"}
理由や説明は出さない。整数で。
    `.trim();

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: `会話ログ:\n${transcript}` }
        ],
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: "json_object" }
      })
    });

    const data = await openaiRes.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    // 0-100 → 0-20、迷いペナルティ
    const s = parsed.scores;
    const avg = 0.22*s.initiative + 0.22*s.self_disclosure + 0.20*s.empathy + 0.18*s.clarity + 0.18*s.pace_balance;
    const raw20 = Math.round(avg/5);
    const penalty = Math.min(3, Math.round((s.hesitation||0)/34));
    const chat_raw20 = Math.max(0, raw20 - penalty);

    res.json({ ...parsed, chat_raw20 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "score_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on " + PORT));
