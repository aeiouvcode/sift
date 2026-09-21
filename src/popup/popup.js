const $ = (s) => document.querySelector(s);

async function load() {
  const s = await chrome.storage.local.get(["enabled", "filters", "stats", "provider"]);
  $("#enabled").checked = s.enabled !== false;
  renderFilters(s.filters || []);
  $("#count").textContent = s.stats?.hidden ?? 0;
  const kind = s.provider?.kind || "demo";
  const notes = {
    demo: "Demo mode: offline keyword matching. Add an API key in Settings for real classification.",
    gemini: "Using Gemini with your key.",
    openai_compat: "Using your OpenAI-compatible endpoint.",
    on_device: "Using Chrome's built-in on-device AI (experimental).",
  };
  $("#provider-note").textContent = notes[kind] || "";
}

function renderFilters(filters) {
  const ul = $("#filters");
  ul.innerHTML = "";
  const active = filters.filter((f) => f.enabled);
  if (active.length === 0) {
    ul.innerHTML = `<li class="empty">No filters yet. Add one, or use the funnel button on any post.</li>`;
    return;
  }
  for (const f of active) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="txt" title=""></span><button class="del" title="Remove">✕</button>`;
    li.querySelector(".txt").textContent = f.text;
    li.querySelector(".txt").title = f.text;
    li.querySelector(".del").addEventListener("click", async () => {
      const s = await chrome.storage.local.get("filters");
      await chrome.storage.local.set({ filters: (s.filters || []).filter((x) => x.id !== f.id) });
      load();
    });
    ul.appendChild(li);
  }
}

$("#enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

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

$("#view-filtered").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "sift:open-drawer" }).catch(() => {});
  window.close();
});

$("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

load();
