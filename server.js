// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());                // 必要なら origin を限定してもOK
app.use(express.json());

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 必要なら gpt-3.5-turbo-0125
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 起動時チェック
if (!OPENAI_API_KEY) {
  console.error("ENV OPENAI_API_KEY is missing!");
}

// Health check
app.get("/", (_req, res) => res.send("koinomae-api is alive"));

// 共通: OpenAI呼び出し用（20秒タイムアウト）
async function openaiChat(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error("OpenAI error:", resp.status, text);
      return { ok: false, error: { status: resp.status, text } };
    }
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    console.error("OpenAI fetch failed:", err?.name || "", err?.message || err);
    return { ok: false, error: { status: 500, text: String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

// 返信生成（LLM）
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "invalid_messages" });
    }

    const system = `
あなたは大学1年の「あかね」。優しく自然体。
- 日本語で返答。ため口8割・敬語2割
- 10〜50字、要所で質問もする（連続質問しすぎない）
- 個人情報請求/露骨な表現/オフライン誘導は拒否して別案を提案
    `.trim();

    const result = await openaiChat({
      model: MODEL,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: 180,
      temperature: 0.7,
    });

    if (!result.ok) {
      return res.status(500).json({ error: "openai_error", detail: result.error });
    }

    const data = result.data;
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "うん、なるほど。続き聞かせて？";
    return res.json({ reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "chat_failed" });
  }
});

// 採点（会話ログ→指標→チャットスコア0-20）
app.post("/score", async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (typeof transcript !== "string" || transcript.trim() === "") {
      return res.status(400).json({ error: "invalid_transcript" });
    }

    const system = `
会話から各指標を0-100で採点し、JSONのみ出力。
{"scores":{"initiative":0-100,"self_disclosure":0-100,"empathy":0-100,"clarity":0-100,"pace_balance":0-100,"hesitation":0-100},"flags":{"safety":true/false},"suggestion":"日本語20-60字"}
理由や説明は出さない。整数で。
    `.trim();

    const result = await openaiChat({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `会話ログ:\n${transcript}` },
      ],
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: "json_object" },
    });

    if (!result.ok) {
      return res.status(500).json({ error: "openai_error", detail: result.error });
    }

    const data = result.data;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.error("No choices:", JSON.stringify(data));
      return res.status(500).json({ error: "no_choices", detail: data });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("JSON parse failed:", content);
      return res.status(500).json({ error: "parse_failed", detail: content });
    }

    // 0-100 → 0-20、迷いペナルティ
    const s = parsed.scores || {};
    const avg =
      0.22 * (s.initiative || 0) +
      0.22 * (s.self_disclosure || 0) +
      0.20 * (s.empathy || 0) +
      0.18 * (s.clarity || 0) +
      0.18 * (s.pace_balance || 0);
    const raw20 = Math.round(avg / 5);
    const penalty = Math.min(3, Math.round(((s.hesitation || 0) / 34)));
    const chat_raw20 = Math.max(0, raw20 - penalty);

    return res.json({ ...parsed, chat_raw20 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "score_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on " + PORT));
