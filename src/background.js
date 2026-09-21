// Sift service worker: storage schema, decision cache, provider calls.
import {
  PROVIDERS,
  classifyWithGemini,
  classifyWithOpenAICompat,
  classifyDemo,
  buildPrompt,
} from "./providers.js";

const DEFAULTS = {
  enabled: true,
  filters: [],        // [{ id, text, enabled, source: 'user'|'quick' }]
  mutedAuthors: [],   // ["@handle"]
  restoredIds: [],    // posts the user put back; never re-hide
  provider: {
    kind: "demo",
    apiKey: "",
    model: "",
    baseUrl: "",
  },
  stats: { hidden: 0, classified: 0, apiCalls: 0 },
  cache: {},          // hash -> { hide, reason, filter, ts }
  customOriginGranted: false,
};

const CACHE_LIMIT = 600;
const RESTORED_LIMIT = 300;

async function getState() {
  const s = await chrome.storage.local.get(null);
  return { ...structuredClone(DEFAULTS), ...s, provider: { ...DEFAULTS.provider, ...(s.provider || {}) }, stats: { ...DEFAULTS.stats, ...(s.stats || {}) } };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function rulesFingerprint(state) {
  const rules = state.filters.filter((f) => f.enabled).map((f) => f.text.trim().toLowerCase());
  rules.sort();
  return rules.join(" || ") + "##" + state.mutedAuthors.join(",");
}

async function classify(posts) {
  const state = await getState();
  if (!state.enabled) return { results: posts.map((p) => ({ id: p.id, hide: false })) };

  const rules = state.filters.filter((f) => f.enabled).map((f) => f.text);
  const restored = new Set(state.restoredIds);
  const muted = new Set(state.mutedAuthors.map((a) => a.toLowerCase()));
  const fp = await sha(rulesFingerprint(state));

  const results = [];
  const needsModel = [];
  const cache = state.cache;
  let cacheDirty = false;

  for (const p of posts) {
    if (restored.has(p.id)) {
      results.push({ id: p.id, hide: false, reason: "restored by you", filter: null });
      continue;
    }
    if (p.author && muted.has(p.author.toLowerCase())) {
      results.push({ id: p.id, hide: true, reason: `you hid ${p.author}`, filter: "Hidden author", cached: true });
      continue;
    }
    if (rules.length === 0) {
      results.push({ id: p.id, hide: false });
      continue;
    }
    const key = await sha(fp + "::" + (p.text || "") + "::" + (p.isAd ? "ad" : ""));
    const hit = cache[key];
    if (hit) {
      results.push({ id: p.id, hide: hit.hide, reason: hit.reason, filter: hit.filter, cached: true });
    } else {
      needsModel.push({ post: p, key });
    }
  }

  if (needsModel.length > 0) {
    let fresh = [];
    const kind = state.provider.kind;
    if (kind === "demo") {
      fresh = classifyDemo(rules, needsModel.map((n) => n.post));
    } else if (kind === "gemini") {
      if (!state.provider.apiKey) throw new Error("Add your Gemini API key in Sift settings.");
      fresh = await classifyWithGemini(state.provider, rules, needsModel.map((n) => n.post));
    } else if (kind === "openai_compat") {
      if (!state.provider.apiKey) throw new Error("Add your API key in Sift settings.");
      fresh = await classifyWithOpenAICompat(state.provider, rules, needsModel.map((n) => n.post));
    } else {
      throw new Error("Unknown provider: " + kind);
    }
    state.stats.apiCalls += 1;
    const keyById = new Map(needsModel.map((n) => [String(n.post.id), n.key]));
    for (const d of fresh) {
      const key = keyById.get(String(d.id));
      if (key) {
        cache[key] = { hide: d.hide, reason: d.reason, filter: d.filter, ts: Date.now() };
        cacheDirty = true;
      }
      results.push(d);
    }
    // LRU-ish trim
    const keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys
        .sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0))
        .slice(0, keys.length - CACHE_LIMIT)
        .forEach((k) => delete cache[k]);
      cacheDirty = true;
    }
  }

  state.stats.classified += posts.length;
  const hiddenNow = results.filter((r) => r.hide).length;
  state.stats.hidden += hiddenNow;
  await setState({ stats: state.stats, ...(cacheDirty || needsModel.length ? { cache } : {}) });

  return { results };
}

async function testProvider() {
  const state = await getState();
  const rules = ["crypto giveaways and airdrop spam"];
  const posts = [
    { id: "t1", text: "Giving away 500 ETH to celebrate! Drop your wallet below.", author: "@airdrop_daily", isAd: false },
    { id: "t2", text: "Made sourdough for the first time today. Crumb shot inside.", author: "@baker", isAd: false },
  ];
  const kind = state.provider.kind;
  let out;
  if (kind === "demo") out = classifyDemo(rules, posts);
  else if (kind === "gemini") {
    if (!state.provider.apiKey) throw new Error("No API key saved.");
    out = await classifyWithGemini(state.provider, rules, posts);
  } else if (kind === "openai_compat") {
    if (!state.provider.apiKey) throw new Error("No API key saved.");
    out = await classifyWithOpenAICompat(state.provider, rules, posts);
  } else throw new Error("Unknown provider");
  const t1 = out.find((r) => r.id === "t1");
  const t2 = out.find((r) => r.id === "t2");
  if (!t1?.hide) throw new Error("Provider answered, but did not flag the obvious spam post.");
  if (t2?.hide) throw new Error("Provider over-hid: it flagged a harmless bread post.");
  return { ok: true, detail: `Key works. Spam hidden, bread kept. (${PROVIDERS[kind]?.label || kind})` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "sift:classify":
          sendResponse(await classify(msg.posts || []));
          break;
        case "sift:test":
          sendResponse(await testProvider());
          break;
        case "sift:build-prompt-preview": {
          const state = await getState();
          const rules = state.filters.filter((f) => f.enabled).map((f) => f.text);
          sendResponse({ prompt: buildPrompt(rules.length ? rules : ["(no filters yet)"], [{ id: "example", text: "(a post from your timeline)", author: "@someone", isAd: false }]) });
          break;
        }
        case "sift:open-options":
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // async sendResponse
});
