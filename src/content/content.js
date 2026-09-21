// Sift content script: watches the timeline, batches posts, applies decisions,
// and renders the quick-action menu, placeholders, and the filtered drawer.
(() => {
  if (window.__siftLoaded) return;
  window.__siftLoaded = true;

  const TWEET_SEL = 'article[data-testid="tweet"]';
  const BATCH_WINDOW_MS = 400;
  const BATCH_MAX = 10;
  const HIDDEN_ATTR = "data-sift-hidden";

  const state = {
    enabled: true,
    filters: [],
    providerKind: "demo",
    seen: new Set(),
    queue: [],
    flushTimer: null,
    hidden: new Map(), // postId -> { article, placeholder, decision, post }
    restoring: new Set(),
    failed: false,
    onDeviceSession: null,
    onDeviceUnavailable: false,
  };

  // ---------- storage ----------
  async function loadConfig() {
    const s = await chrome.storage.local.get(["enabled", "filters", "provider"]);
    state.enabled = s.enabled !== false;
    state.filters = (s.filters || []).filter((f) => f.enabled);
    state.providerKind = s.provider?.kind || "demo";
  }

  // ---------- extraction ----------
  function extractPost(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : "";
    let author = "";
    const userBlock = article.querySelector('[data-testid="User-Name"]');
    if (userBlock) {
      const handleLink = [...userBlock.querySelectorAll('a[href^="/"]')]
        .map((a) => a.textContent.trim())
        .find((t) => t.startsWith("@"));
      author = handleLink || "";
    }
    let id = "";
    const timeLink = article.querySelector('a[href*="/status/"] time');
    if (timeLink) id = timeLink.parentElement.href;
    if (!id) id = "txt:" + hashCode(author + "|" + text);
    const isAd = !timeLink || [...article.querySelectorAll("span")].some((s) => s.textContent.trim() === "Ad");
    return { id, text, author, isAd, url: id.startsWith("http") ? id : "" };
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  // ---------- queue / batching ----------
  function enqueue(article) {
    if (!state.enabled) return;
    if (article.hasAttribute("data-sift-seen")) return;
    article.setAttribute("data-sift-seen", "1");
    const post = extractPost(article);
    if (!post.text && !post.isAd) return;
    if (state.seen.has(post.id)) return;
    state.seen.add(post.id);
    state.queue.push({ article, post });
    attachQuickAction(article, post);
    if (state.queue.length >= BATCH_MAX) flush();
    else if (!state.flushTimer) {
      state.flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
    }
  }

  async function flush() {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    const batch = state.queue.splice(0, BATCH_MAX);
    if (batch.length === 0) return;
    if (state.queue.length && !state.flushTimer) state.flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
    if (state.filters.length === 0 && !(await hasMutedAuthors())) return;
    try {
      let decisions;
      if (state.providerKind === "on_device") {
        decisions = { results: await classifyOnDevice(batch.map((b) => b.post)) };
      } else {
        decisions = await chrome.runtime.sendMessage({ type: "sift:classify", posts: batch.map((b) => b.post) });
      }
      if (decisions?.error) throw new Error(decisions.error);
      state.failed = false;
      const byId = new Map((decisions.results || []).map((d) => [String(d.id), d]));
      for (const { article, post } of batch) {
        const d = byId.get(String(post.id));
        if (d?.hide && !state.restoring.has(post.id)) hidePost(article, post, d);
      }
      updatePill();
    } catch (e) {
      state.failed = true;
      updatePill(e.message);
      console.warn("[sift] classification failed:", e.message);
    }
  }

  async function hasMutedAuthors() {
    const s = await chrome.storage.local.get("mutedAuthors");
    return (s.mutedAuthors || []).length > 0;
  }

  // ---------- on-device (Chrome built-in Prompt API) ----------
  async function classifyOnDevice(posts) {
    if (state.onDeviceUnavailable) throw new Error("On-device model unavailable in this browser.");
    if (typeof self.LanguageModel === "undefined") {
      state.onDeviceUnavailable = true;
      throw new Error("Chrome's built-in AI (LanguageModel) is not available here. Pick another provider in settings.");
    }
    if (!state.onDeviceSession) {
      const avail = await self.LanguageModel.availability();
      if (avail === "unavailable") {
        state.onDeviceUnavailable = true;
        throw new Error("On-device model not available on this device.");
      }
      state.onDeviceSession = await self.LanguageModel.create({
        initialPrompts: [{
          role: "system",
          content: "You classify social media posts against user filters. Reply with JSON only.",
        }],
      });
    }
    const rules = state.filters.map((f) => f.text);
    const prompt = [
      "FILTERS: " + rules.join(" ; "),
      "For each post below decide hide true/false. JSON only: {\"results\":[{\"id\":\"..\",\"hide\":true,\"reason\":\"..\",\"filter\":\"..\"}]}",
      ...posts.map((p) => `id=${p.id} text: ${p.text.slice(0, 400)}`),
    ].join("\n");
    const raw = await state.onDeviceSession.prompt(prompt, { responseConstraint: { type: "object" } }).catch(() => state.onDeviceSession.prompt(prompt));
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const byId = new Map((parsed.results || []).map((r) => [String(r.id), r]));
    return posts.map((p) => {
      const r = byId.get(String(p.id));
      return { id: p.id, hide: !!r?.hide, reason: r?.reason || "", filter: r?.filter || null };
    });
  }

  // ---------- hiding / restoring ----------
  function hidePost(article, post, decision) {
    if (article.hasAttribute(HIDDEN_ATTR) || !article.isConnected) return;
    article.setAttribute(HIDDEN_ATTR, "1");
    const ph = document.createElement("div");
    ph.className = "sift-placeholder";
    const label = decision.filter || "filtered";
    ph.innerHTML = `
      <span class="sift-ph-dot"></span>
      <span class="sift-ph-text"><b>Filtered</b> · ${escapeHtml(label)}${decision.reason ? ` · <span class="sift-ph-reason">${escapeHtml(decision.reason)}</span>` : ""}</span>
      <button class="sift-ph-restore" type="button">Restore</button>`;
    ph.querySelector(".sift-ph-restore").addEventListener("click", () => restorePost(post.id));
    article.style.display = "none";
    article.parentElement.insertBefore(ph, article);
    state.hidden.set(post.id, { article, placeholder: ph, decision, post });
  }

  async function restorePost(id) {
    const entry = state.hidden.get(id);
    if (!entry) return;
    state.restoring.add(id);
    entry.article.style.display = "";
    entry.article.removeAttribute(HIDDEN_ATTR);
    entry.placeholder.remove();
    state.hidden.delete(id);
    updatePill();
    const s = await chrome.storage.local.get("restoredIds");
    const restored = [id, ...(s.restoredIds || [])].slice(0, 300);
    await chrome.storage.local.set({ restoredIds: restored });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- quick action ("Quiet this post") ----------
  function attachQuickAction(article, post) {
    const group = article.querySelector('div[role="group"]');
    if (!group || group.querySelector(".sift-quick-btn")) return;
    const btn = document.createElement("button");
    btn.className = "sift-quick-btn";
    btn.type = "button";
    btn.title = "Sift: quiet this post";
    btn.setAttribute("aria-label", "Sift: quiet this post");
    btn.innerHTML = funnelSvg();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openQuickMenu(btn, post);
    });
    group.appendChild(btn);
  }

  function funnelSvg() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 5h18l-7 8v5.5L10 21v-8L3 5z"/></svg>`;
  }

  let openMenu = null;
  function closeQuickMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
    document.removeEventListener("click", onDocClick, true);
  }
  function onDocClick(e) {
    if (openMenu && !openMenu.contains(e.target)) closeQuickMenu();
  }

  function openQuickMenu(anchor, post) {
    closeQuickMenu();
    const menu = document.createElement("div");
    menu.className = "sift-quick-menu";
    const snippet = post.text.length > 80 ? post.text.slice(0, 80) + "…" : post.text;
    const opts = [
      { label: "Fewer posts like this", rule: `Posts similar to: "${snippet}"` },
      { label: "Hide this topic", rule: null }, // filled from hashtags or keywords
      post.author ? { label: `Hide ${post.author}`, author: post.author } : null,
      { label: "Ads and promos", rule: "Promoted posts, ads, giveaways, and engagement-bait promos" },
      { label: "Rage or bait tone", rule: "Rage-bait, dunk posts, and engagement-farming outrage" },
    ].filter(Boolean);

    // topic guess: prefer a hashtag, else the first meaningful words
    const tag = (post.text.match(/#[\w]+/) || [null])[0];
    opts[1].rule = tag
      ? `Posts about ${tag}`
      : `Posts about: "${post.text.split(/\s+/).slice(0, 5).join(" ")}"`;

    menu.innerHTML = `<div class="sift-qm-title">Quiet this post</div>` +
      opts.map((o, i) => `<button type="button" data-i="${i}">${escapeHtml(o.label)}</button>`).join("");
    menu.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const opt = opts[Number(b.dataset.i)];
      closeQuickMenu();
      if (opt.author) {
        const s = await chrome.storage.local.get("mutedAuthors");
        const list = s.mutedAuthors || [];
        if (!list.includes(opt.author)) list.push(opt.author);
        await chrome.storage.local.set({ mutedAuthors: list });
      } else if (opt.rule) {
        await addRule(opt.rule);
      }
      // re-classify everything currently visible
      rescanAll();
      toast("Filter added. Re-sifting…");
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${window.scrollY + r.bottom + 6}px`;
    menu.style.left = `${Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - 240)}px`;
    openMenu = menu;
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  }

  function restoreQuiet(id) {
    // Re-show without recording a "restored" vote (used when rules change).
    const entry = state.hidden.get(id);
    if (!entry) return;
    entry.article.style.display = "";
    entry.article.removeAttribute(HIDDEN_ATTR);
    entry.placeholder.remove();
    state.hidden.delete(id);
  }

  async function addRule(text) {
    const s = await chrome.storage.local.get("filters");
    const filters = s.filters || [];
    filters.push({ id: "f" + Date.now().toString(36), text, enabled: true, source: "quick" });
    await chrome.storage.local.set({ filters });
    state.filters = filters.filter((f) => f.enabled);
  }

  // ---------- toolbar pill + drawer ----------
  let pill, drawer;
  function ensurePill() {
    if (pill) return;
    pill = document.createElement("div");
    pill.className = "sift-pill";
    pill.innerHTML = `<span class="sift-pill-funnel">${funnelSvg()}</span><span class="sift-pill-label">Sift</span><span class="sift-pill-count">0</span>`;
    pill.addEventListener("click", toggleDrawer);
    document.body.appendChild(pill);
  }

  function updatePill(error) {
    ensurePill();
    const n = state.hidden.size;
    pill.querySelector(".sift-pill-count").textContent = n;
    pill.classList.toggle("sift-pill-error", !!error);
    pill.title = error ? `Sift: ${error}` : "Sift: view filtered posts";
    if (drawer?.classList.contains("open")) renderDrawer();
  }

  function toggleDrawer() {
    if (!drawer) {
      drawer = document.createElement("div");
      drawer.className = "sift-drawer";
      document.body.appendChild(drawer);
    }
    drawer.classList.toggle("open");
    if (drawer.classList.contains("open")) renderDrawer();
  }

  function renderDrawer() {
    const items = [...state.hidden.entries()];
    drawer.innerHTML = `
      <div class="sift-drawer-head">
        <span>Filtered (${items.length})</span>
        <div class="sift-drawer-head-btns">
          <button class="sift-drawer-settings" type="button" title="Settings">${gearSvg()}</button>
          <button class="sift-drawer-close" type="button" title="Close">✕</button>
        </div>
      </div>
      <div class="sift-drawer-body">
        ${items.length === 0 ? `<div class="sift-drawer-empty">Nothing filtered yet. As you scroll, posts matching your filters land here with the reason.</div>` : ""}
        ${items.map(([id, it]) => `
          <div class="sift-card" data-id="${escapeHtml(id)}">
            <div class="sift-card-top">
              <span class="sift-card-filter">${escapeHtml(it.decision.filter || "filtered")}</span>
              <button class="sift-card-restore" type="button">Restore</button>
            </div>
            <div class="sift-card-text">${escapeHtml(it.post.text.slice(0, 180))}${it.post.text.length > 180 ? "…" : ""}</div>
            ${it.decision.reason ? `<div class="sift-card-reason">Why: ${escapeHtml(it.decision.reason)}</div>` : ""}
          </div>`).join("")}
      </div>`;
    drawer.querySelector(".sift-drawer-close").addEventListener("click", toggleDrawer);
    drawer.querySelector(".sift-drawer-settings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "sift:open-options" }));
    drawer.querySelectorAll(".sift-card-restore").forEach((b) => {
      b.addEventListener("click", (e) => {
        const id = e.target.closest(".sift-card").dataset.id;
        restorePost(id);
        renderDrawer();
      });
    });
  }

  function gearSvg() {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.22.63.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>`;
  }

  let toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "sift-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // ---------- observation ----------
  function scanExisting() {
    document.querySelectorAll(TWEET_SEL).forEach(enqueue);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.(TWEET_SEL)) enqueue(node);
        else node.querySelectorAll?.(TWEET_SEL).forEach(enqueue);
      }
    }
  });

  // open drawer when popup asks
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "sift:open-drawer") { ensurePill(); if (!drawer || !drawer.classList.contains("open")) toggleDrawer(); sendResponse({ ok: true }); }
    if (msg?.type === "sift:state-changed") { loadConfig().then(() => { state.seen.clear(); scanExisting(); }); sendResponse({ ok: true }); }
  });

  function rescanAll() {
    state.seen.clear();
    document.querySelectorAll("[data-sift-seen]").forEach((el) => el.removeAttribute("data-sift-seen"));
    state.hidden.forEach((_, id) => restoreQuiet(id));
    updatePill();
    scanExisting();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled || changes.filters || changes.provider || changes.mutedAuthors) {
      loadConfig().then(rescanAll);
    }
  });

  loadConfig().then(() => {
    ensurePill();
    scanExisting();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
