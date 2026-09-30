/* TDP Daily Deals — website. Reads deals.json (rebuilt every few hours by build_deals.py in a GitHub Action),
   then searches, filters, sorts and spins the Lucky wheel entirely in the browser. */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const CAT_FALLBACK = [
    { id: "music", name: "Music & Gigs", emoji: "🎸" },
    { id: "cinema", name: "Cinema", emoji: "🎬" },
    { id: "theatre", name: "Theatre & Musicals", emoji: "🎭" },
    { id: "comedy", name: "Shows & Events", emoji: "🎪" },
  ];
  const LUCKY = { pool: 30, power: 2 };

  const state = {
    data: null, deals: [], cats: CAT_FALLBACK, sources: [],
    q: "", cat: "all", sort: "score", freeOnly: false, codesOnly: false, off: new Set(),
    lastLucky: null,
  };

  // ---------------------------------------------------------------- helpers

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  /** Same normalisation as build_deals.py norm(): lowercase, no accents, & → and, non [a-z0-9£%] → space, padded. */
  function norm(s) {
    const t = String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ").replace(/[^a-z0-9£%]+/g, " ").trim();
    return ` ${t} `;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
  const catOf = (id) => state.cats.find((c) => c.id === id) || { id, name: id, emoji: "🎟️" };
  const sourceName = (id) => (state.sources.find((s) => s.id === id) || {}).name || id;

  function ago(iso) {
    if (!iso) return "";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  function whenText(d) {
    if (d.expires) {
      const e = new Date(d.expires), now = new Date();
      const days = Math.floor((new Date(e.getFullYear(), e.getMonth(), e.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
      if (days <= 0) return "Ends today";
      if (days === 1) return "Ends tomorrow";
      return "Ends " + e.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    }
    if (d.published) return "Posted " + ago(d.published);
    return "";
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------------------------------------------------------------- filtering

  const isFree = (d) => d.kind === "free" || d.price === 0 || (d.badges || []).includes("FREE");
  const hasCode = (d) => d.kind === "voucher" || !!d.code;

  function haystack(d) {
    if (!d._hay) {
      d._hay = norm([d.title, d.subtitle, d.merchant, d.venue, (d.badges || []).join(" "), catOf(d.category).name, sourceName(d.source)].join(" "));
    }
    return d._hay;
  }

  /** Every query word must start a word in the deal's text ("wick" finds "Wicked"). */
  function matchesQuery(d, words) {
    if (!words.length) return true;
    const h = haystack(d);
    return words.every((w) => h.includes(" " + w));
  }

  function filtered({ ignoreCat = false } = {}) {
    const words = norm(state.q).trim().split(" ").filter(Boolean);
    return state.deals.filter((d) =>
      (ignoreCat || state.cat === "all" || d.category === state.cat) &&
      !state.off.has(d.source) &&
      (!state.freeOnly || isFree(d)) &&
      (!state.codesOnly || hasCode(d)) &&
      matchesQuery(d, words));
  }

  function sorted(list) {
    const by = {
      score: () => 0,
      discount: (a, b) => (b.discount ?? -1) - (a.discount ?? -1),
      price: (a, b) => (isFree(a) ? 0 : a.price ?? 1e9) - (isFree(b) ? 0 : b.price ?? 1e9),
      new: (a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0),
      hot: (a, b) => (b.heat ?? -1) - (a.heat ?? -1),
    }[state.sort] || (() => 0);
    return [...list].sort((a, b) => by(a, b) || b.score - a.score || a.title.localeCompare(b.title));
  }

  // ---------------------------------------------------------------- rendering

  function badgeClass(b) {
    if (/°$/.test(b)) return "badge hot";
    if (b === "FREE") return "badge free";
    if (/^Code /.test(b)) return "badge code";
    if (/%|^save|\boff\b/i.test(b)) return "badge save";
    return "badge";
  }

  function scoreClass(s) { return s >= 80 ? "good" : s >= 65 ? "ok" : "low"; }

  function cardHTML(d) {
    const c = catOf(d.category);
    const url = safeUrl(d.url), img = safeUrl(d.image);
    const badges = (d.badges || []).filter((b) => !(d.source === "news" && b === d.subtitle)).slice(0, 5);
    const trusted = d.source === "news" ? esc(d.subtitle || "News") : `<b>✓</b> ${esc(sourceName(d.source))}`;
    return `
      <article class="card ${esc(d.category)}" data-id="${esc(d.id)}">
        <a class="media" href="${esc(url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ph">${c.emoji}</span>`}
          <span class="cat-pill">${c.emoji} ${esc(c.name)}</span>
          <span class="score ${scoreClass(d.score)}" style="--s:${Math.max(0, Math.min(100, d.score | 0))}" title="Deal score ${d.score}/100"><span>${d.score | 0}</span></span>
        </a>
        <div class="body">
          <h3><a href="${esc(url)}" target="_blank" rel="noopener">${esc(d.title)}</a></h3>
          ${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}
          ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="${badgeClass(b)}">${esc(b)}</span>`).join("")}</div>` : ""}
          <div class="meta"><span class="price">${esc(d.priceText || "")}</span><span class="ends">${esc(whenText(d))}</span></div>
          <div class="foot-row">
            <span class="src">${trusted}</span>
            <span class="actions">
              ${d.code ? `<button class="btn small" type="button" data-copy="${esc(d.code)}">Copy code</button>` : ""}
              <a class="btn primary small" href="${esc(url)}" target="_blank" rel="noopener">${d.source === "news" ? "Read ↗" : "Get deal ↗"}</a>
            </span>
          </div>
        </div>
      </article>`;
  }

  function renderCats() {
    const base = filtered({ ignoreCat: true });
    const counts = { all: base.length };
    for (const d of base) counts[d.category] = (counts[d.category] || 0) + 1;
    const chips = [{ id: "all", name: "All deals", emoji: "✨" }, ...state.cats];
    $("#cats").innerHTML = chips.map((c) =>
      `<button class="chip" type="button" data-cat="${esc(c.id)}" aria-pressed="${state.cat === c.id}">
         <span aria-hidden="true">${c.emoji}</span>${esc(c.name)}<span class="n">${counts[c.id] || 0}</span></button>`).join("");
  }

  function renderSources() {
    $("#srcChips").innerHTML = state.sources.map((s) =>
      `<button class="chip" type="button" data-src="${esc(s.id)}" aria-pressed="${!state.off.has(s.id)}" title="Show or hide ${esc(s.name)} deals">${esc(s.name)}</button>`).join("");
    $("#sourcesList").innerHTML = state.sources.map((s) => `
      <div class="srcrow">
        <span class="st" title="${s.ok ? "Working" : "Not available right now"}">${s.ok ? "✅" : "⚠️"}</span>
        <span><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.name)}</a>
          <span class="muted small"> · ${s.count} deal${s.count === 1 ? "" : "s"}</span></span>
        <p>${esc(s.about || "")}</p>
      </div>`).join("");
  }

  function renderMore() {
    const q = state.q.trim();
    const el = $("#more");
    if (!q) { el.hidden = true; return; }
    const e = encodeURIComponent(q);
    el.innerHTML = `Search more for “${esc(q)}”: ` + [
      [`https://www.hotukdeals.com/search?q=${e}`, "HotUKDeals"],
      [`https://www.todaytix.com/london/search?q=${e}`, "TodayTix"],
      [`https://officiallondontheatre.com/search/?s=${e}`, "Official London Theatre"],
      [`https://news.google.com/search?q=${encodeURIComponent(q + " tickets deal")}&hl=en-GB&gl=GB&ceid=GB:en`, "Google News"],
    ].map(([u, n]) => `<a href="${u}" target="_blank" rel="noopener">${n}</a>`).join(" · ");
    el.hidden = false;
  }

  function render() {
    renderCats();
    renderMore();
    const list = sorted(filtered());
    const grid = $("#grid");
    if (!list.length) {
      grid.innerHTML = `<div class="empty">No deals match${state.q ? ` “${esc(state.q)}”` : ""} right now.<br>Try another word, clear a filter, or use the links above to search the sites directly.</div>`;
    } else {
      grid.innerHTML = list.map(cardHTML).join("");
    }
    const total = state.deals.length;
    $("#info").textContent = list.length === total
      ? `${total} deals, best first.`
      : `${list.length} of ${total} deals.`;
    wireImages(grid);
  }

  /** Roughly 16:9 pictures fill the slot; square or very wide ones (logos, banners) are shown whole over a blurred copy of themselves. */
  function fitImage(img) {
    const ratio = img.naturalWidth / img.naturalHeight;
    if (!img.naturalWidth || (ratio >= 1.4 && ratio <= 2.1)) return;
    const media = img.closest(".media");
    if (!media || media.classList.contains("square")) return;
    const bg = document.createElement("span");
    bg.className = "bg";
    bg.style.backgroundImage = `url("${encodeURI(img.src).replace(/"/g, "%22")}")`;
    media.classList.add("square");
    media.prepend(bg);
  }

  function wireImages(root) {
    root.querySelectorAll(".media img").forEach((img) => {
      img.addEventListener("error", () => {
        const card = img.closest(".card");
        const c = catOf(card && card.classList[1]);
        img.replaceWith(Object.assign(document.createElement("span"), { className: "ph", textContent: c.emoji }));
      }, { once: true });
      if (img.complete) fitImage(img);
      else img.addEventListener("load", () => fitImage(img), { once: true });
    });
  }

  function renderUpdated() {
    if (!state.data) return;
    const el = $("#updated");
    el.textContent = "Updated " + ago(state.data.generatedAt);
    el.title = new Date(state.data.generatedAt).toLocaleString("en-GB");
  }

  // ---------------------------------------------------------------- URL hash (shareable searches)

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.q = p.get("q") || "";
    state.cat = p.get("cat") || "all";
    $("#q").value = state.q;
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set("q", state.q.trim());
    if (state.cat !== "all") p.set("cat", state.cat);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  // ---------------------------------------------------------------- I'm Feeling Lucky

  function luckyCandidates() {
    return [...filtered()].sort((a, b) => b.score - a.score).slice(0, LUCKY.pool);
  }

  function pickLucky(cands) {
    let pool = cands;
    if (pool.length > 1 && state.lastLucky) pool = pool.filter((d) => d.id !== state.lastLucky);
    const weights = pool.map((d) => Math.pow(Math.max(1, d.score), LUCKY.power));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  let spinTimer = null;
  function lucky() {
    const cands = luckyCandidates();
    if (!cands.length) { toast("No deals match — clear a filter first"); return; }
    const pick = pickLucky(cands);
    state.lastLucky = pick.id;
    // warm the image cache so the reel doesn't flash empty cards
    for (const d of [pick, ...cands]) if (safeUrl(d.image)) new Image().src = d.image;

    const ov = $("#lucky"), reel = $("#reel");
    ov.hidden = false;
    $("#luckyActions").hidden = true;
    $("#luckyTitle").textContent = "🍀 Feeling lucky…";
    reel.classList.remove("landed");
    reel.classList.add("spinning");
    $("#confetti").innerHTML = "";
    clearTimeout(spinTimer);

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frames = reduce ? 0 : 24;
    let i = 0, prev = null;
    const show = (d) => {
      reel.innerHTML = cardHTML(d);
      const card = reel.firstElementChild;
      card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
      wireImages(reel);
    };
    const step = () => {
      if (i >= frames) { land(pick); return; }
      let d = cands[Math.floor(Math.random() * cands.length)];
      if (cands.length > 1 && d === prev) d = cands[(cands.indexOf(d) + 1) % cands.length];
      prev = d; show(d);
      const t = i / frames;
      i++;
      spinTimer = setTimeout(step, 30 + 210 * t * t); // ease-out: fast, then slowing (~2.2 s in total)
    };
    const land = (d) => {
      show(d);
      reel.classList.remove("spinning");
      void reel.offsetWidth;
      reel.classList.add("landed");
      $("#luckyTitle").textContent = "🍀 Your lucky deal!";
      const go = $("#luckyGo");
      go.href = safeUrl(d.url) || "#";
      go.textContent = d.source === "news" ? "Read it ↗" : "Take me there ↗";
      $("#luckyActions").hidden = false;
      go.focus({ preventScroll: true });
      if (!reduce) confetti();
    };
    step();
  }

  function confetti() {
    const box = $("#confetti");
    const colors = ["#FF3D7F", "#FFA23D", "#FFC83D", "#8B6CFF", "#3DB2FF", "#2BD67B"];
    box.innerHTML = Array.from({ length: 46 }, () => {
      const left = Math.random() * 100, dx = (Math.random() - 0.5) * 160, rot = (Math.random() - 0.5) * 900;
      const delay = Math.random() * 0.35, col = colors[(Math.random() * colors.length) | 0];
      return `<i style="left:${left}%;background:${col};--dx:${dx}px;--rot:${rot}deg;animation-delay:${delay}s"></i>`;
    }).join("");
  }

  function closeLucky() {
    clearTimeout(spinTimer);
    $("#lucky").hidden = true;
    $("#luckyBtn").focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- theme

  const THEMES = ["auto", "dark", "light"];
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    $("#themeBtn").title = `Theme: ${t}`;
  }

  // ---------------------------------------------------------------- events

  function wire() {
    let typing;
    $("#q").addEventListener("input", (e) => {
      state.q = e.target.value;
      clearTimeout(typing);
      typing = setTimeout(() => { render(); writeHash(); }, 120);
    });
    $("#searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = $("#q").value;
      render(); writeHash();
      $("#cats").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#cats").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b) return;
      state.cat = b.dataset.cat; render(); writeHash();
    });
    $("#srcChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-src]"); if (!b) return;
      const id = b.dataset.src;
      state.off.has(id) ? state.off.delete(id) : state.off.add(id);
      store.set("tdd-off", [...state.off].join(","));
      renderSources(); render();
    });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
    $("#freeOnly").addEventListener("change", (e) => { state.freeOnly = e.target.checked; render(); });
    $("#codesOnly").addEventListener("change", (e) => { state.codesOnly = e.target.checked; render(); });
    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-copy]"); if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); toast(`Copied code ${b.dataset.copy}`); }
      catch { toast(`Code: ${b.dataset.copy}`); }
    });
    $("#luckyBtn").addEventListener("click", lucky);
    $("#luckyAgain").addEventListener("click", lucky);
    $("#luckyClose").addEventListener("click", closeLucky);
    $("#lucky").addEventListener("click", (e) => { if (e.target.id === "lucky") closeLucky(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#lucky").hidden) closeLucky(); });
    $("#sourcesBtn").addEventListener("click", () => $("#sourcesDlg").showModal());
    $("#sourcesDlg").addEventListener("click", (e) => { if (e.target.id === "sourcesDlg") $("#sourcesDlg").close(); });
    $("#themeBtn").addEventListener("click", () => {
      const cur = store.get("tdd-theme") || "auto";
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      store.set("tdd-theme", next); applyTheme(next); toast(`Theme: ${next}`);
    });
    window.addEventListener("hashchange", () => { readHash(); render(); });
    setInterval(renderUpdated, 60_000);
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    applyTheme(store.get("tdd-theme") || "auto");
    if (matchMedia("(max-width: 520px)").matches) $("#q").placeholder = "Search bands, films, shows…";
    (store.get("tdd-off") || "").split(",").filter(Boolean).forEach((s) => state.off.add(s));
    readHash();
    wire();
    try {
      const r = await fetch("deals.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.data = data;
      state.deals = data.deals || [];
      state.cats = data.categories && data.categories.length ? data.categories : CAT_FALLBACK;
      state.sources = data.sources || [];
      renderSources(); renderUpdated(); render();
    } catch (err) {
      $("#grid").innerHTML = `<div class="empty">Couldn't load today's deals (${esc(err.message)}). Please try again in a minute.</div>`;
    }
  }

  boot();
})();
