// --- 先頭のENV設定 ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FALLBACK_MODEL = "gpt-3.5-turbo-0125";

// OpenAI呼び出し（共通）
async function openaiChatOnce(model, messages, { max_tokens=180, temperature=0.7 } = {}) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens, temperature }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(()=>"");
    console.error("OpenAI error:", model, resp.status, text);
    return { ok:false, error:{status:resp.status, text} };
  }
  const data = await resp.json().catch(()=>null);
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";
  if (!reply) {
    console.error("No choices:", model, JSON.stringify(data||{}));
    return { ok:false, error:{status:500, text:"no_choices"} };
  }
  return { ok:true, reply };
}

// モデルを順に試す
async function tryModels(messages) {
  const order = [PRIMARY_MODEL, FALLBACK_MODEL];
  for (const m of order) {
    const r = await openaiChatOnce(m, messages);
    if (r.ok) return r.reply;
  }
  return ""; // ここに落ちることがあればネット/課金系
}

// /chat 本体
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

    const reply = await tryModels([{ role:"system", content:system }, ...messages]);
    if (!reply) {
      // ここまで来たらOpenAI側が完全にNG。原因表示して非空を返す
      return res.status(502).json({ error:"upstream_failed", reply:"今ちょっと混んでるみたい。もう一度送ってみて！" });
    }
    return res.json({ reply });
  } catch (e) {
    console.error("chat_failed:", e);
    return res.status(500).json({ error:"chat_failed" });
  }
});

// /score は前の robust 版のままでOK
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
