const $ = (s) => document.querySelector(s);

const PROVIDERS = [
  { kind: "gemini", name: "Google Gemini", desc: "Fast and cheap. Bring your own API key from aistudio.google.com.", needsKey: true, defaultModel: "gemini-2.5-flash-lite" },
  { kind: "openai_compat", name: "OpenAI-compatible", desc: "OpenAI, OpenRouter, Groq, a local server - any /chat/completions endpoint.", needsKey: true, defaultModel: "gpt-4o-mini", hasBase: true },
  { kind: "on_device", name: "On-device (experimental)", desc: "Chrome's built-in Gemini Nano. Nothing leaves the machine. Needs a recent Chrome with built-in AI enabled.", needsKey: false },
  { kind: "demo", name: "Demo mode", desc: "Offline keyword matching. No key, no network. Good for trying the UX; not real classification.", needsKey: false },
];

let current = { kind: "demo", apiKey: "", model: "", baseUrl: "" };

async function load() {
  const s = await chrome.storage.local.get(["provider", "filters", "mutedAuthors", "stats"]);
  current = { ...current, ...(s.provider || {}) };
  renderProviders();
  renderFilters(s.filters || []);
  renderMuted(s.mutedAuthors || []);
  const st = s.stats || { hidden: 0, classified: 0, apiCalls: 0 };
  $("#stats").textContent = `${st.classified} posts classified, ${st.hidden} hidden, ${st.apiCalls} API calls so far.`;
  syncFields();
}

function renderProviders() {
  const wrap = $("#providers");
  wrap.innerHTML = "";
  for (const p of PROVIDERS) {
    const label = document.createElement("label");
    label.className = p.kind === current.kind ? "sel" : "";
    label.innerHTML = `<input type="radio" name="provider" value="${p.kind}"><span><span class="p-name"></span><br><span class="p-desc"></span></span>`;
    label.querySelector(".p-name").textContent = p.name;
    label.querySelector(".p-desc").textContent = p.desc;
    label.querySelector("input").checked = p.kind === current.kind;
    label.querySelector("input").addEventListener("change", () => {
      current.kind = p.kind;
      renderProviders();
      syncFields();
    });
    wrap.appendChild(label);
  }
}

function syncFields() {
  const p = PROVIDERS.find((x) => x.kind === current.kind);
  $("#field-key").classList.toggle("hidden", !p.needsKey);
  $("#field-model").classList.toggle("hidden", !p.needsKey);
  $("#field-base").classList.toggle("hidden", !p.hasBase);
  $("#api-key").value = current.apiKey || "";
  $("#model").value = current.model || p.defaultModel || "";
  $("#model").placeholder = p.defaultModel || "";
  $("#base-url").value = current.baseUrl || "";
  $("#origin-note").textContent = p.hasBase
    ? "A custom endpoint may ask for one extra browser permission when you save."
    : "";
}

$("#save-provider").addEventListener("click", async () => {
  current.apiKey = $("#api-key").value.trim();
  current.model = $("#model").value.trim();
  current.baseUrl = $("#base-url").value.trim();
  if (current.kind === "openai_compat" && current.baseUrl) {
    try {
      const origin = new URL(current.baseUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) setResult("Permission for that endpoint was not granted; requests to it will fail.", "err");
    } catch { setResult("That base URL does not look valid.", "err"); return; }
  }
  await chrome.storage.local.set({ provider: current });
  setResult("Saved.", "ok");
});

$("#test-provider").addEventListener("click", async () => {
  setResult("Testing…", "");
  try {
    // save first so the worker tests what's on screen
    await chrome.storage.local.set({ provider: { ...current, apiKey: $("#api-key").value.trim(), model: $("#model").value.trim(), baseUrl: $("#base-url").value.trim() } });
    const res = await chrome.runtime.sendMessage({ type: "sift:test" });
    if (res?.error) setResult(res.error, "err");
    else setResult(res.detail || "Works.", "ok");
  } catch (e) {
    setResult(e.message, "err");
  }
});

function setResult(msg, cls) {
  const el = $("#test-result");
  el.textContent = msg;
  el.className = "hint " + cls;
}

function renderFilters(filters) {
  const ul = $("#filters");
  ul.innerHTML = "";
  if (filters.length === 0) { ul.innerHTML = `<li class="empty">None yet.</li>`; return; }
  for (const f of filters) {
    const li = document.createElement("li");
    li.innerHTML = `<input type="checkbox" ${f.enabled ? "checked" : ""} title="Enabled"><span class="txt"></span>${f.source === "quick" ? '<span class="tag">from a post</span>' : ""}<button class="del" title="Delete">✕</button>`;
    li.querySelector(".txt").textContent = f.text;
    li.querySelector("input").addEventListener("change", async (e) => {
      const s = await chrome.storage.local.get("filters");
      await chrome.storage.local.set({ filters: (s.filters || []).map((x) => x.id === f.id ? { ...x, enabled: e.target.checked } : x) });
    });
    li.querySelector(".del").addEventListener("click", async () => {
      const s = await chrome.storage.local.get("filters");
      await chrome.storage.local.set({ filters: (s.filters || []).filter((x) => x.id !== f.id) });
      load();
    });
    ul.appendChild(li);
  }
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#new-filter").value.trim();
  if (!text) return;
  const s = await chrome.storage.local.get("filters");
  const filters = s.filters || [];
  filters.push({ id: "f" + Date.now().toString(36), text, enabled: true, source: "user" });
  await chrome.storage.local.set({ filters });
  $("#new-filter").value = "";
  load();
});

function renderMuted(muted) {
  const ul = $("#muted");
  ul.innerHTML = "";
  if (muted.length === 0) { ul.innerHTML = `<li class="empty">None. Use the funnel on a post to hide its author.</li>`; return; }
  for (const a of muted) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="txt"></span><button class="del" title="Unhide">✕</button>`;
    li.querySelector(".txt").textContent = a;
    li.querySelector(".del").addEventListener("click", async () => {
      const s = await chrome.storage.local.get("mutedAuthors");
      await chrome.storage.local.set({ mutedAuthors: (s.mutedAuthors || []).filter((x) => x !== a) });
      load();
    });
    ul.appendChild(li);
  }
}

$("#clear-cache").addEventListener("click", async () => {
  await chrome.storage.local.set({ cache: {} });
  $("#stats").textContent = "Cache cleared.";
});

$("#clear-all").addEventListener("click", async () => {
  if (!confirm("Erase all Sift data (filters, key, cache, stats) from this browser?")) return;
  await chrome.storage.local.clear();
  load();
});

load();
