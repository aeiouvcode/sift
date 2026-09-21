// Sift - provider clients. Each provider turns (rules, posts) into decisions.
// Decision shape: { id, hide: boolean, reason: string, filter: string|null }

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini (BYO key)",
    needsKey: true,
    defaultModel: "gemini-2.5-flash-lite",
  },
  openai_compat: {
    label: "OpenAI-compatible API (BYO key)",
    needsKey: true,
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  on_device: {
    label: "On-device (Chrome built-in AI, experimental)",
    needsKey: false,
  },
  demo: {
    label: "Demo mode (offline keyword matching, no key)",
    needsKey: false,
  },
};

export function buildPrompt(rules, posts) {
  const ruleLines = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const postLines = posts
    .map((p) => {
      const bits = [];
      bits.push(`id=${p.id}`);
      bits.push(`author=${p.author || "unknown"}`);
      if (p.isAd) bits.push(`[marked as ad by the platform]`);
      bits.push(`text: ${truncate(p.text, 900)}`);
      return bits.join(" | ");
    })
    .join("\n---\n");
  return [
    "You classify social media posts against a user's personal feed filters.",
    "The user wrote these filters in their own words. Hide a post when it clearly matches ANY filter.",
    "When in doubt, do NOT hide. Never hide a post for matching only tangentially.",
    "",
    "FILTERS:",
    ruleLines,
    "",
    "POSTS:",
    postLines,
    "",
    'Reply with JSON only, no markdown: {"results":[{"id":"<id>","hide":true|false,"reason":"<one short sentence, plain words>","filter":"<the matched filter text, or null>"}]}',
    "Include every post id exactly once.",
  ].join("\n");
}

function truncate(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function parseDecisions(raw, posts) {
  let text = (raw || "").trim();
  // Strip markdown fences if a model adds them anyway.
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("model returned no JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const byId = new Map(results.map((r) => [String(r.id), r]));
  return posts.map((p) => {
    const r = byId.get(String(p.id));
    if (!r) return { id: p.id, hide: false, reason: "", filter: null };
    return {
      id: p.id,
      hide: !!r.hide,
      reason: typeof r.reason === "string" ? r.reason : "",
      filter: typeof r.filter === "string" ? r.filter : null,
    };
  });
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(600 * Math.pow(2, i));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function classifyWithGemini(cfg, rules, posts) {
  const model = cfg.model || PROVIDERS.gemini.defaultModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": cfg.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(rules, posts) }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseDecisions(text, posts);
}

export async function classifyWithOpenAICompat(cfg, rules, posts) {
  const base = (cfg.baseUrl || PROVIDERS.openai_compat.defaultBaseUrl).replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || PROVIDERS.openai_compat.defaultModel,
      messages: [{ role: "user", content: buildPrompt(rules, posts) }],
      temperature: 0,
    }),
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return parseDecisions(text, posts);
}

// Offline keyword matcher so people can try Sift without any key.
// Deliberately simple and clearly labeled "demo" everywhere it shows up.
const DEMO_STOPWORDS = new Set(["and", "the", "or", "of", "to", "in", "on", "for", "a", "an", "this", "that", "posts", "post", "about", "like", "with", "from", "its", "it"]);

const stem = (t) => (t.length > 4 ? t.replace(/s$/, "") : t);

export function classifyDemo(rules, posts) {
  const termFor = rules.map((r) =>
    r.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !DEMO_STOPWORDS.has(t)).map(stem)
  );
  return posts.map((p) => {
    const hay = " " + (p.text + " " + (p.author || "")).toLowerCase().split(/[^a-z0-9]+/).map(stem).join(" ") + " ";
    let hitIdx = -1, hitTerm = null;
    termFor.forEach((terms, i) => {
      if (hitIdx !== -1) return;
      const t = terms.find((t) => t && hay.includes(" " + t + " "));
      if (t) { hitIdx = i; hitTerm = t; }
    });
    return {
      id: p.id,
      hide: hitIdx !== -1,
      reason: hitTerm ? `demo match on "${hitTerm}"` : "",
      filter: hitIdx !== -1 ? rules[hitIdx] : null,
    };
  });
}
