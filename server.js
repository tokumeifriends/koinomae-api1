// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());                 // 必要なら { origin: ["https://tokumeifriends.github.io"] } などに制限
app.use(express.json({ limit: "1mb" }));

// ===== ENV =====
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PRIMARY_MODEL  = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const FALLBACK_MODEL = "gpt-3.5-turbo-0125"; // 使えない場合もあるが一応フォールバック

if (!OPENAI_API_KEY) {
  console.error("ENV OPENAI_API_KEY is missing!");
}

// ===== OpenAI呼び出し（1回分） =====
async function openaiChatOnce({ model, messages, max_tokens = 180, temperature = 0.7, response_format }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens, temperature, response_format }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("OpenAI error:", model, resp.status, text);
    return { ok: false, status: resp.status, text };
  }

  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content?.trim() || "";
  if (!content) {
    console.error("No choices / empty content:", model, JSON.stringify(data || {}));
    return { ok: false, status: 500, text: "no_choices" };
  }
  return { ok: true, content };
}

// ===== モデルを順に試す =====
async function tryModels({ messages, max_tokens, temperature, response_format }) {
  const order = [PRIMARY_MODEL, FALLBACK_MODEL];
  for (const model of order) {
    const r = await openaiChatOnce({ model, messages, max_tokens, temperature, response_format });
    if (r.ok) return r.content;
  }
  return ""; // 上流NG（キー/課金/レート等）
}

// ===== Health / Debug / Smoke =====
app.get("/", (_req, res) => res.send("koinomae-api is alive"));

app.get("/debug", (_req, res) => {
  const key = OPENAI_API_KEY;
  const masked = key ? key.slice(0, 6) + "..." + key.slice(-4) : "";
  res.json({
    hasKey: !!key,
    len: key.length,
    startsWith_sk: key.startsWith("sk-"),
    preview: masked,
    model: PRIMARY_MODEL
  });
});

app.get("/smoke", async (_req, res) => {
  const msg = [{ role: "user", content: "10〜20字で元気づける一言を日本語で。絵文字1つ。" }];
  const content = await tryModels({ messages: msg, max_tokens: 60, temperature: 0.7 });
  res.json({ ok: !!content, modelOrder: [PRIMARY_MODEL, FALLBACK_MODEL], content });
});

// ===== /chat =====
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "invalid_messages" });
    }

    const system = `
あなたは大学1年の「あかね」。優しく自然体。
- 日本語。ため口8割・敬語2割
- 10〜50字、感情に寄り添い、時々だけ質問
- 個人情報要求/露骨/オフライン誘導は拒否して代案を提案
    `.trim();

    const content = await tryModels({
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: 180,
      temperature: 0.7,
    });

    if (!content) {
      // 上流失敗時でも必ず非空を返す（UX維持）
      return res.status(502).json({ error: "upstream_failed", reply: "今混んでるみたい。もう一回送ってみて！" });
    }
    return res.json({ reply: content });
  } catch (e) {
    console.error("chat_failed:", e);
    return res.status(500).json({ error: "chat_failed" });
  }
});

// ===== /score =====
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

    const content = await tryModels({
      messages: [
        { role: "system", content: system },
        { role: "user", content: `会話ログ:\n${transcript}` },
      ],
      max_tokens: 240,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    if (!content) {
      return res.status(502).json({ error: "upstream_failed", detail: "empty_content" });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("score JSON parse failed:", content);
      return res.status(500).json({ error: "parse_failed", detail: content });
    }

    const s = parsed.scores || {};
    const avg =
      0.22 * (s.initiative || 0) +
      0.22 * (s.self_disclosure || 0) +
      0.20 * (s.empathy || 0) +
      0.18 * (s.clarity || 0) +
      0.18 * (s.pace_balance || 0);

    const raw20    = Math.round(avg / 5);
    const penalty  = Math.min(3, Math.round(((s.hesitation || 0) / 34)));
    const chat_raw20 = Math.max(0, raw20 - penalty);

    return res.json({ ...parsed, chat_raw20 });
  } catch (e) {
    console.error("score_failed:", e);
    return res.status(500).json({ error: "score_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on " + PORT));
