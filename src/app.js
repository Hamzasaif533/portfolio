// All interactivity. Deferred and small; every page renders fully without it.
(() => {
  "use strict";
  const body = document.body, d = body.dataset, root = d.root || "";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const go = url => { if (!url) return; if (/^https?:/.test(url)) window.open(url, "_blank", "noopener"); else location.href = url; };

  /* ---------- dialogs ---------- */
  const pal = $(".palette"), help = $(".help"), viewer = $(".viewer");
  const openDialog = dlg => { if (dlg && !dlg.open) { $$("dialog[open]").forEach(x => x.close()); dlg.showModal(); } };
  $$("dialog:not(.viewer)").forEach(dl => dl.addEventListener("click", e => { if (e.target === dl) dl.close(); })); // click outside closes

  /* ---------- shelf: tabs, sorting ---------- */
  function openTab(id, push) {
    const tab = document.getElementById("tab-" + id);
    if (!tab) return;
    $$("[role=tab]").forEach(t => t.setAttribute("aria-selected", t === tab));
    $$("[role=tabpanel]").forEach(p => (p.hidden = p.id !== id));
    // on phones the tab row scrolls sideways: keep the chosen tab in view
    const row = tab.parentElement;
    if (row.scrollWidth > row.clientWidth) row.scrollTo({ left: row.scrollLeft + tab.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - tab.offsetWidth) / 2, behavior: reduce ? "auto" : "smooth" });
    if (push) history.replaceState(null, "", "#" + id);
  }
  // a link to something inside a hidden tab shows that tab first
  function reveal(el) {
    const panel = el.matches("[role=tabpanel]") ? el : el.closest("[role=tabpanel]");
    if (panel) openTab(panel.id);
  }
  $$("[data-tab]").forEach(t => t.addEventListener("click", () => openTab(t.dataset.tab, true)));
  const SORTS = {
    recent: (a, b) => a.dataset.i - b.dataset.i,
    year: (a, b) => b.dataset.year - a.dataset.year || b.dataset.score - a.dataset.score,
    score: (a, b) => b.dataset.score - a.dataset.score || b.dataset.liked - a.dataset.liked || a.dataset.i - b.dataset.i,
    liked: (a, b) => b.dataset.liked - a.dataset.liked || b.dataset.score - a.dataset.score || a.dataset.i - b.dataset.i,
  };
  $$("[data-sort]").forEach(btn => btn.addEventListener("click", () => {
    const list = btn.closest("[role=tabpanel]").querySelector(".list");
    // pressing the active sort again flips the order
    const flip = btn.getAttribute("aria-pressed") === "true" && btn.dataset.arrow === "↓";
    $$("[data-sort]", btn.parentElement).forEach(b => { b.setAttribute("aria-pressed", b === btn); b.dataset.arrow = "↓"; });
    btn.dataset.arrow = flip ? "↑" : "↓";
    const rows = $$("li", list).sort(SORTS[btn.dataset.sort]);
    if (flip) rows.reverse();
    rows.forEach(li => list.appendChild(li));
  }));

  /* ---------- stats: view switches + "which films?" lists ---------- */
  $$(".seg button").forEach(b => b.addEventListener("click", () => {
    const fig = b.closest("figure");
    $$(".seg button", fig).forEach(x => x.setAttribute("aria-pressed", x === b));
    $$(".seg-view", fig).forEach((v, i) => (v.hidden = String(i) !== b.dataset.seg));
  }));
  const filmData = (() => { try { return JSON.parse(($("#statfilms") || {}).textContent || "[]"); } catch (_) { return []; } })();
  const flist = $(".filmlist");
  if (flist) {
    flist.addEventListener("click", e => { if (e.target === flist) flist.close(); });
    $(".fl-close", flist).addEventListener("click", () => flist.close());
    $$("[data-films]").forEach(el => el.addEventListener("click", () => {
      const films = el.dataset.films.split(",").filter(Boolean).map(Number).map(i => filmData[i]).filter(Boolean);
      $(".fl-title", flist).textContent = `${el.dataset.ftitle} · ${films.length} ${films.length === 1 ? "film" : "films"}`;
      const ul = $(".fl-list", flist);
      ul.textContent = "";
      films.forEach(f => {
        const li = document.createElement("li"), a = document.createElement("a");
        a.href = "#" + f.id;
        a.innerHTML = "<span class=t></span><span class=y></span><span class=r></span>";
        a.children[0].textContent = f.t; a.children[1].textContent = f.y; a.children[2].textContent = f.r;
        // jump to the film on the Movies tab
        a.addEventListener("click", e => {
          e.preventDefault(); flist.close();
          if (location.hash === a.hash) focusHash(); else location.hash = a.hash;
          const row = document.getElementById(f.id); // a short highlight so you can see where you landed
          if (row) { row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1600); }
        });
        li.appendChild(a); ul.appendChild(li);
      });
      openDialog(flist);
      const first = $("a", ul);
      if (first) first.focus({ preventScroll: true });
    }));
  }

  /* ---------- deep links (#id) land focus on that item ---------- */
  const focusHash = () => {
    if (!location.hash) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!el) return;
    reveal(el);
    if (el.tagName === "DETAILS") el.open = true;
    const t = el.matches("[data-item]") ? el : el.querySelector("[data-item]") || el;
    if (!t.matches("a,button,summary,[tabindex]")) t.tabIndex = -1;
    t.focus({ preventScroll: true });
    t.scrollIntoView({ block: "center" });
  };
  focusHash();
  addEventListener("hashchange", focusHash);

  /* ---------- moving between items: arrows / WASD go in that direction on screen ---------- */
  const visibleItems = () => $$("[data-item]").filter(el => { const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.width > 0 && r.height > 0; });
  const currentItem = () => { const a = document.activeElement; return a && a.closest ? a.closest("[data-item]") : null; };
  const focusItem = el => { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest", inline: "nearest" }); };

  // returns true if focus moved
  function move(dir) {
    const all = visibleItems();
    if (!all.length) return false;
    const cur = currentItem();
    if (!cur || !all.includes(cur)) {
      // writing: up/down keep scrolling the article until you step into the post list
      if ($(".post") && (dir === "up" || dir === "down")) return false;
      const start = $(".post-list a[aria-current]") || all.find(el => { const r = el.getBoundingClientRect(); return r.bottom > 60 && r.top < innerHeight - 60; }) || all[0];
      focusItem(start);
      return true;
    }
    // stepping right out of the post list goes back to reading
    if (dir === "right" && cur.closest(".post-list")) { cur.blur(); return true; }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const h = dir === "left" || dir === "right";
      const main = dir === "right" ? bx - ax : dir === "left" ? ax - bx : dir === "down" ? by - ay : ay - by;
      if (main <= 4) continue;
      // prefer things that line up with the current item (same row / same column)
      const overlap = h ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const cross = h ? Math.abs(by - ay) : Math.abs(bx - ax);
      const score = main + cross * (overlap > 0 ? 0.5 : 3);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return false;
    focusItem(best);
    return true;
  }

  /* ---------- writing sidebar ---------- */
  const toggleList = () => {
    const hidden = body.classList.toggle("hide-list");
    try { sessionStorage.setItem("hideList", hidden ? "1" : ""); } catch (_) {}
  };
  if ($(".post-list")) {
    try {
      if (sessionStorage.getItem("hideList")) {
        body.classList.add("no-anim", "hide-list");
        requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("no-anim")));
      }
    } catch (_) {}
    const current = $(".post-list a[aria-current]");
    if (current) current.scrollIntoView({ block: "center" });
    const toggle = $(".list-toggle");
    if (toggle) toggle.addEventListener("click", () => body.classList.toggle("show-list"));
  }

  /* ---------- search ---------- */
  let index = null, results = [], sel = 0;
  const input = pal && $("input", pal), list = pal && $(".pal-list", pal);
  const ORDER = { page: 0, post: 1, code: 2, design: 3, frame: 4, movie: 5, game: 5, book: 5, "q&a": 6, link: 7 };
  async function openPalette() {
    openDialog(pal);
    input.value = "";
    if (!index) { try { index = await (await fetch(root + "search.json")).json(); } catch (_) { index = []; } }
    render();
    input.focus();
  }
  function score(it, q) {
    if (!q) return 1;
    const t = it.t.toLowerCase(), hay = `${t} ${it.k} ${it.d || ""}`.toLowerCase();
    if (t.startsWith(q)) return 4;
    if (t.includes(q)) return 3;
    if (hay.includes(q)) return 2;
    let j = 0;
    for (const c of hay) if (c === q[j]) j++;
    return j === q.length ? 1 : 0;
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    results = (index || []).map(it => [it, score(it, q)]).filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || (ORDER[a[0].k] ?? 9) - (ORDER[b[0].k] ?? 9)).map(([it]) => it).slice(0, 50);
    sel = 0;
    list.textContent = "";
    if (!results.length) { list.innerHTML = '<li class="empty">No results</li>'; return; }
    results.forEach((it, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = "opt-" + i;
      li.setAttribute("aria-selected", i === 0);
      li.innerHTML = "<span dir=auto></span><span></span>";
      li.firstChild.textContent = it.t;
      li.lastChild.textContent = it.k;
      li.addEventListener("click", () => choose(i));
      list.appendChild(li);
    });
    input.setAttribute("aria-activedescendant", "opt-0");
  }
  function mark(i) {
    const opts = $$("li[role=option]", list);
    if (!opts.length) return;
    sel = (i + opts.length) % opts.length;
    opts.forEach((li, k) => li.setAttribute("aria-selected", k === sel));
    opts[sel].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", "opt-" + sel);
  }
  function choose(i) {
    const it = results[i];
    if (!it) return;
    pal.close();
    const url = /^(https?:|mailto:)/.test(it.u) ? it.u : root + it.u;
    const target = new URL(url, location.href);
    const here = location.pathname.replace(/\/$/, "/index.html");
    if (target.pathname === here && target.hash) { location.hash = target.hash; focusHash(); } else go(url);
  }
  if (input) {
    input.addEventListener("input", render);
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); mark(sel + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); mark(sel - 1); }
      else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
    });
  }

  /* ---------- viewer: film frames & design images ---------- */
  let group = [], cur = 0, opener = null;
  function show(i) {
    cur = (i + group.length) % group.length;
    const s = group[cur].dataset, img = $(".vw-fig img", viewer);
    img.src = s.src; img.alt = s.title;
    $(".vw-title", viewer).textContent = s.title;
    $(".vw-meta", viewer).textContent = s.meta || "";
    $(".vw-note", viewer).textContent = s.desc || "";
    $(".vw-n", viewer).textContent = `${String(cur + 1).padStart(2, "0")} / ${String(group.length).padStart(2, "0")}`;
    viewer.style.setProperty("--p", (cur + 1) / group.length);
    // warm up the neighbours so browsing is instant
    [cur + 1, cur - 1].forEach(k => { const n = group[(k + group.length) % group.length]; if (n) new Image().src = n.dataset.src; });
  }
  if (viewer) {
    $$("[data-view]").forEach(el => el.addEventListener("click", () => {
      group = $$(`[data-view="${el.dataset.view}"]`);
      viewer.classList.toggle("bare", el.dataset.view === "design"); // posters show on their own, no caption
      opener = el;
      show(group.indexOf(el));
      openDialog(viewer);
    }));
    $(".vw-close", viewer).addEventListener("click", () => viewer.close());
    $(".vw-prev", viewer).addEventListener("click", () => show(cur - 1));
    $(".vw-next", viewer).addEventListener("click", () => show(cur + 1));
    // like stories: tap the left third to go back, anywhere else to go forward
    viewer.addEventListener("click", e => {
      if (e.target.closest("button, .vw-bar")) return;
      show(cur + (e.clientX < innerWidth / 3 ? -1 : 1));
    });
    // after the browser restores focus to the opener, move it to the frame that was last on screen
    viewer.addEventListener("close", () => setTimeout(() => { const el = group[cur] || opener; if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); } }));
  }

  /* ---------- keyboard (no on-screen hints; press ? for the list) ---------- */
  const DIRS = { ArrowUp: "up", w: "up", ArrowDown: "down", s: "down", ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right" };

  addEventListener("keydown", e => {
    const k = e.key, dir = DIRS[k.length === 1 ? k.toLowerCase() : k];
    if (viewer && viewer.open) {
      if (dir === "right" || dir === "down" || k === " ") { e.preventDefault(); show(cur + 1); }
      else if (dir === "left" || dir === "up") { e.preventDefault(); show(cur - 1); }
      else if (k === "Enter" || k === "Backspace") { e.preventDefault(); viewer.close(); }
      return;
    }
    if ($("dialog[open]")) return; // search / help handle their own keys; Esc closes natively
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;

    if (k === "/" || (e.code === "Slash" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "k")) { e.preventDefault(); openPalette(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // arrows / WASD: with nothing selected, ← → change page and ↑ ↓ pick the first item;
    // once something is selected they only move the selection (never leave the page by accident)
    if (dir && !(e.shiftKey && k.length === 1)) {
      const selected = currentItem() && !currentItem().closest(".post-list");
      if (!selected && !currentItem() && (dir === "left" || dir === "right")) { e.preventDefault(); go(dir === "left" ? d.prev : d.next); return; }
      if (move(dir)) { e.preventDefault(); return; }
      if (currentItem()) { e.preventDefault(); return; } // at the edge: stay put
      if (k.length === 1) { e.preventDefault(); scrollBy({ top: dir === "up" ? -160 : 160, behavior: "smooth" }); }
      return; // ↑ ↓ fall through to normal scrolling
    }

    const item = currentItem();
    const tabs = $$(".tabs a");
    if (k === " " && item) { e.preventDefault(); item.click(); } // space opens the selected item (enter works natively)
    else if (k === "Enter" && item && !item.matches("a,button,summary")) { e.preventDefault(); item.click(); }
    else if (k === "?" || (e.code === "Slash" && e.shiftKey)) { e.preventDefault(); openDialog(help); }
    else if (/^[1-9]$/.test(k) && tabs[k - 1]) { e.preventDefault(); location.href = tabs[k - 1].href; }
    else if (k === "q" || k === "Q") { e.preventDefault(); go(d.prev); }
    else if (k === "e" || k === "E") { e.preventDefault(); go(d.next); }
    else if (k === "g") { e.preventDefault(); scrollTo({ top: 0 }); }
    else if (k === "G") { e.preventDefault(); scrollTo({ top: document.documentElement.scrollHeight }); }
    else if (k === "[" && d.prevpost) { e.preventDefault(); go(d.prevpost); }
    else if (k === "]" && d.nextpost) { e.preventDefault(); go(d.nextpost); }
    else if (k === "b" && $(".post-list")) { e.preventDefault(); toggleList(); }
    else if (k === "Escape") { if (item) item.blur(); else if ($(".post-list")) toggleList(); }
  });

  /* ---------- swipe: pages, or frames when the viewer is open ---------- */
  let sx = 0, sy = 0, st = 0;
  addEventListener("touchstart", e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  addEventListener("touchend", e => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (viewer && viewer.open && dy > 90 && dy > Math.abs(dx) * 1.5 && Date.now() - st < 600) { viewer.close(); return; } // swipe down closes
    if (Date.now() - st > 600 || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (viewer && viewer.open) { show(cur + (dx < 0 ? 1 : -1)); return; }
    if ($("dialog[open]") || e.target.closest("pre, .gallery, .shelf-tabs, .sort, .tabs")) return;
    location.href = dx < 0 ? d.next : d.prev;
  }, { passive: true });

  /* ---------- scrambling words (home) ---------- */
  const words = $$(".w");
  const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*#%&?";
  const rand = n => { let s = ""; for (let i = 0; i < n; i++) s += GLYPHS[(Math.random() * GLYPHS.length) | 0]; return s; };
  function scramble(el, dur = 800, delay = 0) {
    if (reduce || el._busy) return;
    const final = el.dataset.w || (el.dataset.w = el.textContent);
    const n = final.length;
    const lock = Array.from({ length: n }, () => delay + dur * (0.35 + Math.random() * 0.65));
    el._busy = true;
    el.classList.add("scr");
    const start = performance.now();
    // timer-driven so the word always resolves, even in a background tab
    const id = setInterval(() => {
      const t = performance.now() - start;
      if (t >= delay + dur) { clearInterval(id); el.textContent = final; el.classList.remove("scr"); el._busy = false; return; }
      let s = "";
      for (let i = 0; i < n; i++) s += t >= lock[i] ? final[i] : rand(1);
      el.textContent = s;
    }, 55);
    if (delay) el.textContent = rand(n);
  }
  if (words.length) {
    words.forEach((w, i) => scramble(w, 700 + Math.random() * 700, i * 90 + Math.random() * 300));
    if (!reduce) setInterval(() => { if (!document.hidden) scramble(words[(Math.random() * words.length) | 0], 650); }, 2200);
    let rects = [];
    const measure = () => (rects = words.map(w => w.getBoundingClientRect()));
    measure();
    addEventListener("resize", measure, { passive: true });
    addEventListener("pointermove", e => {
      rects.forEach((r, i) => {
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        if (dx * dx + dy * dy < 50 * 50) scramble(words[i], 500);
      });
    }, { passive: true });
  }

  /* ---------- "+" cursor (home) ---------- */
  const cursor = $(".cursor");
  if (cursor && finePointer) {
    addEventListener("pointermove", e => { cursor.classList.add("on"); cursor.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`; }, { passive: true });
    document.addEventListener("pointerleave", () => cursor.classList.remove("on"));
  }

  /* ---------- tiles fade in as they enter the viewport ---------- */
  const tiles = $$(".tile");
  if (tiles.length) {
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      const t = en.target, v = t.querySelector("video");
      if (en.isIntersecting) {
        if (!t.classList.contains("seen")) { t.style.setProperty("--d", (Math.random() * 0.3).toFixed(2) + "s"); t.classList.add("seen"); }
        if (v) v.play().catch(() => {});
      } else if (v) v.pause();
    }), { rootMargin: "0px 0px -40px 0px" });
    tiles.forEach(t => io.observe(t));
    setTimeout(() => tiles.forEach(t => { if (t.getBoundingClientRect().top < innerHeight) t.classList.add("seen"); }), 900);
  }

  /* ---------- caption card pinned to the mouse ---------- */
  const cap = $(".cap");
  if (cap && finePointer) {
    let active = null;
    const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    document.addEventListener("pointermove", e => {
      const t = e.target.closest("[data-title]");
      if (t !== active) {
        if (t) {
          const { title, desc, meta } = t.dataset;
          cap.innerHTML = `<b dir="auto">${esc(title)}</b>${desc ? `<p dir="auto">${esc(desc)}</p>` : ""}${meta ? `<p class="m">${esc(meta)}</p>` : ""}`;
        }
        active = t;
        cap.classList.toggle("on", !!t);
      }
      if (t) {
        const w = cap.offsetWidth, h = cap.offsetHeight;
        const x = e.clientX + 18 + w > innerWidth - 8 ? e.clientX - w - 18 : e.clientX + 18;
        const y = Math.min(e.clientY + 18, innerHeight - h - 70);
        cap.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
    }, { passive: true });
    document.addEventListener("pointerleave", () => { active = null; cap.classList.remove("on"); });
  }
})();
