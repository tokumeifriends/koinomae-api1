// server.js (robust)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());                   // 必要なら { origin: ["https://xxx.github.io"] } に絞る
app.use(express.json({ limit: "1mb" }));

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
if (!OPENAI_API_KEY) {
  console.error("ENV OPENAI_API_KEY is missing!");
}

// ====== Utils ======
async function openaiChat(body, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

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

    // OpenAI側のHTTPエラー
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("OpenAI error:", resp.status, text);
      return { ok: false, status: resp.status, detail: text || "(no body)" };
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      console.error("OpenAI: JSON parse failed (empty body)");
      return { ok: false, status: 500, detail: "json_parse_failed" };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("OpenAI fetch failed:", err?.name || "", err?.message || err);
    return { ok: false, status: 500, detail: String(err) };
  } finally {
    clearTimeout(t);
  }
}

// ====== Health check ======
app.get("/", (_req, res) => res.send("koinomae-api is alive"));

// ====== /chat ======
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "invalid_messages" });
    }

    const system = `
あなたは大学1年の「あかね」。優しく自然体。
- 日本語で返答。ため口8割・敬語2割
- 10〜50字、相手の感情へ寄り添い、時々だけ質問を返す
- 個人情報請求/露骨な表現/オフライン誘導は拒否し、穏やかな代案を提案
    `.trim();

    const result = await openaiChat({
      model: MODEL,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: 180,
      temperature: 0.7,
    });

    if (!result.ok) {
      // クライアントにも理由を返す
      return res
        .status(500)
        .json({ error: "openai_error", detail: result.detail, status: result.status });
    }

    const data = result.data;
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error("No choices in OpenAI response:", JSON.stringify(data));
      return res.status(500).json({ error: "no_choices", detail: data });
    }

    return res.json({ reply });
  } catch (e) {
    console.error("chat_failed:", e);
    return res.status(500).json({ error: "chat_failed" });
  }
});

// ====== /score ======
app.post("/score", async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (typeof transcript !== "string" || transcript.trim() === "") {
      return res.status(400).json({ error: "invalid_transcript" });
    }

    const system = `
会話ログをもとに、以下フォーマットのJSONのみを日本語で返す。説明や余分な文字は一切出力しない。
{"scores":{"initiative":0-100,"self_disclosure":0-100,"empathy":0-100,"clarity":0-100,"pace_balance":0-100,"hesitation":0-100},
 "flags":{"safety":true/false},
 "suggestion":"20〜60字の具体的な改善提案（日本語）"}
    `.trim();

    const result = await openaiChat({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `会話ログ:\n${transcript}` },
      ],
      temperature: 0.2,
      max_tokens: 240,
      response_format: { type: "json_object" },
    });

    if (!result.ok) {
      return res
        .status(500)
        .json({ error: "openai_error", detail: result.detail, status: result.status });
    }

    const data = result.data;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.error("No choices in score:", JSON.stringify(data));
      return res.status(500).json({ error: "no_choices", detail: data });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("score JSON parse failed:", content);
      return res.status(500).json({ error: "parse_failed", detail: content });
    }

    // 0-100 → 0-20（加重平均） + 迷いペナルティ
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
    console.error("score_failed:", e);
    return res.status(500).json({ error: "score_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on " + PORT));
