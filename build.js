#!/usr/bin/env node
/*
  Zero-dependency static site builder.

    node build.js         -> builds everything into ./dist
    node build.js --dev   -> builds, serves http://localhost:5500 (or next free port), rebuilds on save

  Content:
    content/site.js        status text, about, shelf (movies/games/books + film frames), code, designs
    content/posts/*.md     writing in English and/or Arabic (front matter + markdown)
    assets/                images & videos (copied as-is)
*/
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");
const PORT = 5500;

/* ==========================================================
   Helpers
   ========================================================== */
function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const ext = url => /^https?:/.test(url || "");
const linkAttrs = url => (ext(url) ? ' target="_blank" rel="noopener"' : "");
const prettyUrl = url => String(url || "").replace(/^(https?:\/\/(www\.)?|mailto:)/, "").replace(/\/$/, "");
const pad2 = n => String(n).padStart(2, "0");
const slug = s => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
/* 3.5 -> ★★★½ ; liked adds ♥ */
const stars = r => { const n = Math.max(0, Math.min(5, Number(r) || 0)); return "★".repeat(Math.floor(n)) + (n % 1 >= 0.5 ? "½" : ""); };
const ratingText = it => (it.rating != null ? stars(it.rating) : "") + (it.liked ? " ♥" : "");
const isVideo = src => /\.(mp4|webm|mov)$/i.test(src || "");

/* Arabic detection: share of letters that are Arabic */
const AR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const arabicRatio = text => {
  const letters = (String(text).match(/\p{L}/gu) || []).length;
  return letters ? (String(text).match(AR) || []).length / letters : 0;
};
const hasArabic = text => /[؀-ۿ]/.test(text);

/* read width/height from local images (png, jpg, gif, webp, svg) so pages never jump while loading */
const sizeCache = new Map();
function imageSize(src) {
  if (!src || /^(https?:|data:)/.test(src)) return null;
  const rel = src.replace(/^(\.\.\/)+|^\//, "");
  if (sizeCache.has(rel)) return sizeCache.get(rel);
  let out = null;
  try {
    const b = fs.readFileSync(path.join(ROOT, rel));
    if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") out = [b.readUInt32BE(16), b.readUInt32BE(20)];
    else if (b.toString("ascii", 0, 3) === "GIF") out = [b.readUInt16LE(6), b.readUInt16LE(8)];
    else if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const t = b.toString("ascii", 12, 16);
      if (t === "VP8 ") out = [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
      else if (t === "VP8L") { const n = b.readUInt32LE(21); out = [(n & 0x3fff) + 1, ((n >> 14) & 0x3fff) + 1]; }
      else if (t === "VP8X") out = [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    } else if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length - 8) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) { out = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; break; }
        i += 2 + len;
      }
    } else {
      const tag = (b.toString("utf8", 0, 3000).match(/<svg[^>]*>/) || [])[0];
      if (tag) {
        const w = tag.match(/\bwidth="([\d.]+)"/), h = tag.match(/\bheight="([\d.]+)"/), vb = tag.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
        out = w && h ? [+w[1], +h[1]] : vb ? [+vb[1], +vb[2]] : null;
      }
    }
  } catch (_) {}
  sizeCache.set(rel, out);
  return out;
}
const dims = (src, w, h) => { const s = w && h ? [w, h] : imageSize(src) || [1600, 900]; return `width="${s[0]}" height="${s[1]}"`; };

/* ==========================================================
   Markdown -> HTML  (bilingual: every block gets the right direction)
   ========================================================== */
let MD = { root: "", ar: false }; // set per post while rendering

const mediaUrl = src => (/^(https?:|data:|\/|\.\.\/)/.test(src) ? src : MD.root + src);

/* a block of text gets lang/dir only when it differs from the article around it */
function dirAttr(text) {
  const r = arabicRatio(text.replace(/<[^>]+>/g, ""));
  if (r > 0.5) return MD.ar ? "" : ' lang="ar" dir="rtl"';
  if (r > 0) return ' dir="auto"';
  return MD.ar && /\p{L}/u.test(text) ? ' lang="en" dir="ltr"' : "";
}

function figure(alt, src) {
  const url = mediaUrl(src), cap = alt ? `<figcaption${dirAttr(alt)}>${esc(alt)}</figcaption>` : "";
  if (isVideo(src)) return `<figure class="media"><video src="${esc(url)}" controls playsinline preload="metadata"${alt ? ` aria-label="${esc(alt)}"` : ""}></video>${cap}</figure>`;
  return `<figure class="media"><img src="${esc(url)}" alt="${esc(alt)}" ${dims(src)} loading="lazy" decoding="async">${cap}</figure>`;
}

function inline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img src="${esc(mediaUrl(u))}" alt="${a}" loading="lazy" decoding="async">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${linkAttrs(u)}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const MEDIA_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

function markdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*(\w*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre dir="ltr" tabindex="0"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { const n = Math.min(4, Math.max(2, h[1].length)); out.push(`<h${n}${dirAttr(h[2])}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote${dirAttr(buf.join(" "))}>${markdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const re = ul.test(line) ? ul : ol, tag = re === ul ? "ul" : "ol", items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      out.push(`<${tag}${dirAttr(items.join(" "))}>${items.map(t => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    // images / videos on their own lines: one = figure, several in a row = gallery
    if (MEDIA_LINE.test(line)) {
      const media = [];
      while (i < lines.length && MEDIA_LINE.test(lines[i])) { const [, a, u] = lines[i++].match(MEDIA_LINE); media.push(figure(a, u)); }
      out.push(media.length > 1 ? `<div class="gallery g${Math.min(media.length, 3)}">${media.join("")}</div>` : media[0]);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*[-*+]\s|\s*\d+[.)]\s|-{3,}\s*$)/.test(lines[i]) && !MEDIA_LINE.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p${dirAttr(buf.join(" "))}>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function readPost(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  if (m) m[1].split(/\r?\n/).forEach(l => {
    const kv = l.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  });
  const body = m ? m[2] : raw;
  const text = body.replace(/```[\s\S]*?```/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  const lang = meta.lang || (arabicRatio(text) > 0.5 ? "ar" : "en");
  const words = text.split(/\s+/).filter(w => /\p{L}|\d/u.test(w)).length;
  MD = { root: "../", ar: lang === "ar" };
  const html = markdown(body);
  MD = { root: "", ar: false };
  return {
    slug: path.basename(file, ".md"),
    title: meta.title || path.basename(file, ".md"),
    date: meta.date || "",
    year: (meta.date || "").slice(0, 4),
    summary: meta.summary || "",
    draft: meta.draft === "true",
    lang,
    words,
    minutes: Math.max(1, Math.round(words / (lang === "ar" ? 180 : 220))),
    html,
  };
}

/* ==========================================================
   Icons (thin line icons, currentColor)
   ========================================================== */
const ICONS = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  github: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  game: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="15.5" cy="11.3" r=".7"/><circle cx="17.7" cy="13.5" r=".7"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.7-.5-1 .2-2.3 1.6-2.3H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r=".6"/>',
  x: '<path d="M4 4l16 16M20 4 4 20"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5V17M8 7.3v.01M12 17v-6.5M12 13.5a3 3 0 0 1 6 0V17"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
};
const icon = (name, size = 17) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.link}</svg>`;

/* every word becomes a span so it can scramble on its own */
const words = text => String(text || "").trim().split(/\s+/).filter(Boolean).map(w => `<span class="w">${esc(w)}</span>`).join(" ");

/* ==========================================================
   Layout
   ========================================================== */
const TABS = [
  ["Hey", "index.html", "hey"],
  ["Code", "code.html", "code"],
  ["Design", "design.html", "design"],
  ["Shelf", "shelf.html", "shelf"],
  ["About", "about.html", "about"],
  ["Writing", "writing/index.html", "writing"],
];

const fontsUrl = arabic =>
  `https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500${arabic ? "&family=Firjar:wght@400;600" : ""}&display=swap`;

/* shared dialogs: search, shortcut list (opened with ?), media viewer */
const DIALOGS = `
<dialog class="palette" aria-label="Search">
  <input type="text" placeholder="Search…" aria-label="Search" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="palList">
  <ul class="pal-list" id="palList" role="listbox"></ul>
</dialog>
<dialog class="help" aria-label="Keyboard shortcuts">
  <p class="help-title">Keyboard</p>
  <dl>
    <div><dt><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></dt><dd>Move between items</dd></div>
    <div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Move between items</dd></div>
    <div><dt><kbd>Enter</kbd> <kbd>Space</kbd></dt><dd>Open selected item</dd></div>
    <div><dt><kbd>Q</kbd> <kbd>E</kbd></dt><dd>Previous / next page</dd></div>
    <div><dt><kbd>1</kbd>–<kbd>6</kbd></dt><dd>Go to page</dd></div>
    <div><dt><kbd>/</kbd> <kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Search everything</dd></div>
    <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next post</dd></div>
    <div><dt><kbd>b</kbd></dt><dd>Show / hide post list</dd></div>
    <div><dt><kbd>g</kbd> <kbd>G</kbd></dt><dd>Top / bottom</dd></div>
    <div><dt><kbd>Esc</kbd></dt><dd>Deselect / close</dd></div>
  </dl>
</dialog>`;

const VIEWER = `
<dialog class="viewer" aria-label="Viewer">
  <button class="vw-close" type="button" aria-label="Close">×</button>
  <button class="vw-nav vw-prev" type="button" aria-label="Previous">‹</button>
  <button class="vw-nav vw-next" type="button" aria-label="Next">›</button>
  <figure class="vw-fig"><img alt=""></figure>
  <div class="vw-bar">
    <div class="vw-text"><p class="vw-title"></p><p class="vw-meta"></p><p class="vw-note"></p></div>
    <span class="vw-n"></span>
  </div>
</dialog>`;

function layout({ site, css, title, description, root, active, body, bodyClass = "", data = {}, viewer = false }) {
  const i = TABS.findIndex(t => t[2] === active);
  const prev = TABS[(i - 1 + TABS.length) % TABS.length], next = TABS[(i + 1) % TABS.length];
  const attrs = { root, prev: root + prev[1], next: root + next[1], ...data };
  const spec = { prefetch: [{ urls: [attrs.prev, attrs.next], eagerness: "eager" }, { where: { href_matches: "/*" }, eagerness: "moderate" }] };
  const socials = (site.socials || [])
    .map(s => `<li><a href="${esc(s.url)}"${linkAttrs(s.url)} aria-label="${esc(s.label)}" title="${esc(s.label)}">${icon(s.icon)}</a></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><text x="16" y="22" font-size="17" text-anchor="middle" font-family="monospace" fill="#fff">*${esc(site.initial || site.name[0])}</text></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontsUrl(hasArabic(body + title))}">
<noscript><style>.tile .media{opacity:1!important;transform:none!important}</style></noscript>
<style>${css}</style>
<script type="speculationrules">${JSON.stringify(spec)}</script>
<script>for(const t of["pageswap","pagereveal"])addEventListener(t,e=>{const v=e.viewTransition;if(v)for(const p of["ready","finished","updateCallbackDone"])v[p]&&v[p].catch(()=>{})})</script>
</head>
<body class="${bodyClass}"${Object.entries(attrs).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}>
<header class="top">
  <a class="chip" href="${root}index.html">*${esc(site.name)}*</a>
</header>
${body}
<footer class="bar">
  <ul class="socials">${socials}</ul>
  <nav class="tabs" aria-label="Main">${TABS.map(([t, h, k]) =>
    `<a href="${root}${h}"${k === active ? ' aria-current="page"' : ""}>${k === active ? '<i class="mk" aria-hidden="true">▸</i>' : ""}${t}</a>`).join("")}</nav>
  <div class="dots" aria-hidden="true">${TABS.map(([, h, k]) => `<a href="${root}${h}" tabindex="-1"${k === active ? ' class="on"' : ""}></a>`).join("")}</div>
  <span></span>
</footer>
${DIALOGS}${viewer ? VIEWER : ""}
<script src="${root}app.js" defer></script>
</body>
</html>`;
}

/* ==========================================================
   Pages
   ========================================================== */
function homePage(site, posts) {
  const st = site.status || {};
  const latest = posts[0];
  const noteHref = st.noteUrl || (latest ? `writing/${latest.slug}.html` : "writing/index.html");
  const note = st.note || (latest ? `Latest post: ${latest.title} →` : "");

  const rows = [
    ["Watching", site.movies, "film", "shelf.html#movies"],
    ["Playing", site.games, "game", "shelf.html#games"],
    ["Reading", site.books, "book", "shelf.html#books"],
    ["Building", site.projects, "code", "code.html"],
  ]
    .map(([k, list, ic, href]) => [k, (list || []).find(x => x.now), ic, href])
    .filter(([, x]) => x)
    .map(([k, x, ic, href]) => `<li><a href="${href}" data-item>
      <span class="k">${k}</span>
      <span class="v">${esc(x.title || x.name)}</span>
      <span class="i">${icon(ic, 20)}</span>
      <span class="r">${x.rating != null ? ratingText(x) : esc(x.status || x.year || "")}</span>
    </a></li>`)
    .join("");

  return `<main class="home" id="main">
  <section class="status">
    <h1 class="sr-only">${esc(site.name)}</h1>
    <p class="s-lead">${words(st.lead || "Today I am:")}</p>
    <p class="s-big">${words(st.big || "MAKING THINGS")}</p>
    <p class="s-tail">${words(st.tail || "as usual")}</p>
    ${note ? `<a class="s-note" href="${esc(noteHref)}"${linkAttrs(noteHref)} data-item><bdi>${esc(note)}</bdi></a>` : ""}
  </section>
  ${rows ? `<ul class="today" aria-label="Right now">${rows}</ul>` : ""}
</main>
<div class="cursor" aria-hidden="true"></div>`;
}

/* image or looping video; class "ld" is set on the tile once the media has loaded */
function tileImg(src, alt, w, h, eager) {
  if (isVideo(src))
    return `<video class="media" src="${esc(src)}" ${dims(src, w, h)} muted loop playsinline preload="metadata" aria-label="${esc(alt)}" onloadeddata="this.closest('.tile').classList.add('ld')"></video>`;
  return `<img class="media" src="${esc(src)}" alt="${esc(alt)}" ${dims(src, w, h)}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async" onload="this.closest('.tile').classList.add('ld')">`;
}

const pageHead = (title, note) => `<header class="page-head"><h1>${esc(title)}</h1>${note ? `<p>${esc(note)}</p>` : ""}</header>`;

/* attributes that let an element open in the viewer */
const viewAttrs = (group, src, title, meta, note) =>
  ` data-view="${group}" data-src="${esc(src)}" data-title="${esc(title)}" data-meta="${esc(meta || "")}" data-desc="${esc(note || "")}"`;

function codePage(site) {
  const tiles = (site.projects || []).map((p, i) => {
    const link = p.live || p.repo || "";
    const meta = [p.tags && p.tags.join(" · "), p.status || p.year].filter(Boolean).join(" / ");
    const tag = link ? "a" : "div";
    return `<${tag} class="tile" id="p-${slug(p.name)}" data-item${link ? ` href="${esc(link)}"${linkAttrs(link)}` : ' tabindex="-1"'} data-title="${esc(p.name)}" data-desc="${esc(p.description)}" data-meta="${esc([meta, prettyUrl(link)].filter(Boolean).join("\n"))}">
      ${tileImg(p.image, p.name, p.width, p.height, i < 3)}
      <span class="tile-cap"><b>${esc(p.name)}</b>${esc(p.description)}</span>
    </${tag}>`;
  }).join("");
  return `<main class="grid-page" id="main">${pageHead("Code", `${(site.projects || []).length} projects`)}<div class="masonry">${tiles}</div></main><div class="fade" aria-hidden="true"></div><div class="cap" aria-hidden="true"></div>`;
}

function designPage(site) {
  const tiles = (site.designs || []).map((d, i) => {
    const meta = [d.tools, d.year].filter(Boolean).join(" / ");
    return `<button type="button" class="tile art" id="d-${i + 1}" data-item${viewAttrs("design", d.image, d.title, meta, d.note)}>
      ${tileImg(d.image, d.alt || d.title, d.width, d.height, i < 2)}
      <span class="tile-cap"><b>${esc(d.title)}</b>${esc(meta)}</span>
    </button>`;
  }).join("");
  return `<main class="grid-page" id="main">${pageHead("Design", "Photoshop & visual work")}<div class="duo">${tiles}</div></main><div class="fade" aria-hidden="true"></div>`;
}

/* film diary: one frame per movie, grouped by the year you watched it */
function filmDiary(movies = []) {
  const withFrames = movies.filter(m => m.frame);
  if (!withFrames.length) return "";
  const groups = new Map();
  withFrames.forEach(m => {
    const y = (m.watched || "").slice(0, 4) ? `${m.watched.slice(0, 4)} film diary` : "Film diary";
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(m);
  });
  const order = [...groups.keys()].sort((a, b) => (a === "Film diary" ? 1 : b === "Film diary" ? -1 : b.localeCompare(a)));
  return order.map(y => {
    const list = groups.get(y).sort((a, b) => String(b.watched || "").localeCompare(String(a.watched || "")));
    return `<section class="diary" aria-label="${esc(y)}">
      <h2 class="diary-head"><span>${esc(y)}</span><span>${pad2(list.length)}</span></h2>
      <div class="frames">${list.map(m => {
        const meta = [m.year, m.by, ratingText(m), m.watched ? `watched ${m.watched.replace(/-/g, ".")}` : ""].filter(Boolean).join(" · ");
        return `<button type="button" class="tile frame" id="f-${slug(m.title)}" data-item${viewAttrs("frames", m.frame, m.title, meta, m.note)}>
          ${tileImg(m.frame, `Frame from ${m.title}`, m.frameWidth, m.frameHeight, false)}
        </button>`;
      }).join("")}</div>
    </section>`;
  }).join("");
}

const SHOW = 5; // items shown before "Show more"

function shelfPage(site) {
  const movies = site.movies || [], books = site.books || [], games = site.games || [];
  const row = (it, i) => `<li class="${[it.now && "now", i >= SHOW && "extra"].filter(Boolean).join(" ")}" id="s-${slug(it.title)}" tabindex="-1" data-item data-i="${i}" data-year="${Number(it.year) || 0}" data-score="${Number(it.rating) || 0}" data-liked="${it.liked ? 1 : 0}">
      <span class="t">${esc(it.title)}</span>
      <span class="y">${esc(it.year || "")}</span>
      <span class="b">${esc(it.by || "")}</span>
      <span class="r"${it.rating != null ? ` aria-label="${it.rating} out of 5${it.liked ? ", liked" : ""}"` : ""}>${ratingText(it)}</span>
      ${it.note ? `<span class="n" dir="auto">${esc(it.note)}</span>` : ""}
    </li>`;
  const list = items => `<ul class="list">${items.map(row).join("")}</ul>${items.length > SHOW ? `<button class="more-btn" type="button" data-item data-more="${items.length - SHOW}">Show more (${items.length - SHOW})</button>` : ""}`;
  const sortBar = `<div class="sort" role="group" aria-label="Sort movies"><span>sort</span>${[["recent", "recent"], ["year", "year"], ["score", "score"], ["liked", "♥"]]
    .map(([k, t]) => `<button type="button" data-item data-sort="${k}" aria-pressed="${k === "recent"}" data-arrow="↓">${t}</button>`).join("")}</div>`;
  const frames = movies.filter(m => m.frame).length;
  const TABS_ = [
    ["movies", "Movies", movies.length, sortBar + list(movies)],
    ["books", "Books", books.length, list(books)],
    ["games", "Games", games.length, list(games)],
    ["diary", "Film diary", frames, filmDiary(movies) || `<p class="empty-note">Add a <code>frame</code> to a movie in content/site.js to start your film diary.</p>`],
  ];
  const rated = movies.filter(m => m.rating != null);
  const avg = rated.length ? (rated.reduce((n, m) => n + Number(m.rating), 0) / rated.length).toFixed(1) : "";
  return `<main class="shelf" id="main">${pageHead("Shelf", `${movies.length} films${avg ? ` · avg ${avg}★` : ""} · ${movies.filter(m => m.liked).length} ♥`)}
    <div class="shelf-tabs" role="tablist" aria-label="Shelf">${TABS_.map(([id, t, n], i) =>
      `<button type="button" role="tab" id="tab-${id}" aria-controls="${id}" aria-selected="${i === 0}" data-item data-tab="${id}">${t}<span>${pad2(n)}</span></button>`).join("")}</div>
    ${TABS_.map(([id, , , body], i) => `<section class="panel" id="${id}" role="tabpanel" aria-labelledby="tab-${id}"${i ? " hidden" : ""}>${body}</section>`).join("")}
  </main>`;
}

function aboutPage(site) {
  const a = site.about || {};
  const avatar = a.avatar
    ? `<img class="avatar" src="${esc(a.avatar)}" alt="${esc(site.name)}" ${dims(a.avatar, 140, 140)}>`
    : `<div class="avatar ph" aria-hidden="true">*${esc(site.initial || site.name[0])}</div>`;
  return `<main class="about" id="main">
  <h1 class="sr-only">About</h1>
  <section class="row">
    <div class="side">${avatar}</div>
    <div class="body bio">${(a.bio || []).map(p => `<p dir="auto">${inline(p)}</p>`).join("")}${a.signoff ? `<p class="dim">${esc(a.signoff)}</p>` : ""}</div>
  </section>
  <section class="row">
    <h2 class="side">Q&amp;A</h2>
    <div class="body qa">${(a.qa || []).map((q, i) => `<details id="q-${i + 1}"><summary data-item dir="auto">${esc(q.q)}</summary><div>${(Array.isArray(q.a) ? q.a : [q.a]).map(p => `<p dir="auto">${inline(p)}</p>`).join("")}</div></details>`).join("")}</div>
  </section>
  <section class="row">
    <h2 class="side">Work</h2>
    <div class="body work">${(a.experience || []).map(x => (x.roles || []).map((r, k) => `<div class="job">
      <span class="org">${k === 0 ? (x.url ? `<a href="${esc(x.url)}"${linkAttrs(x.url)} data-item>${esc(x.org)}</a>` : esc(x.org)) : ""}</span>
      <span class="role">${esc(r.title)}</span>
      <time>${esc(r.dates)}</time>
    </div>`).join("")).join("")}</div>
  </section>
</main>`;
}

const langTag = lang => (lang === "ar" ? "عربي" : "EN");
/* Arabic number agreement: 1 دقيقة, 2 دقيقتان, 3–10 دقائق, 11+ دقيقة */
const arMinutes = n => (n === 1 ? "دقيقة قراءة" : n === 2 ? "دقيقتان قراءة" : n <= 10 ? `${n} دقائق قراءة` : `${n} دقيقة قراءة`);

function writingPage(post, posts) {
  const list = posts.map(p => `<li><a href="${p.slug}.html" data-item${p.slug === post.slug ? ' aria-current="page"' : ""}>
    <span class="t" dir="auto">${esc(p.title)}</span>
    <span class="m">${esc(p.year)} · ${p.minutes} min · <span class="lang">${langTag(p.lang)}</span></span>
  </a></li>`).join("");
  const rtl = post.lang === "ar";
  return `<div class="writing">
  <aside class="post-list" id="postList" aria-label="All posts">
    <ul>${list}</ul>
  </aside>
  <main class="post" id="main">
    <button class="list-toggle" type="button" aria-controls="postList">All writing (${posts.length}) ▾</button>
    <article lang="${post.lang}" dir="${rtl ? "rtl" : "ltr"}">
      <p class="post-meta">${esc(post.date.replace(/-/g, "."))} · ${rtl ? arMinutes(post.minutes) : `${post.minutes} min read`} · ${post.words} ${rtl ? "كلمة" : "words"}</p>
      <h1>${esc(post.title)}</h1>
      <div class="prose">${post.html}</div>
    </article>
  </main>
</div>`;
}

/* everything the search can jump to (urls relative to the site root) */
function searchIndex(site, posts) {
  const out = [];
  TABS.forEach(([t, h]) => out.push({ t, k: "page", u: h }));
  posts.forEach(p => out.push({ t: p.title, k: "post", u: `writing/${p.slug}.html`, d: p.summary }));
  (site.projects || []).forEach(p => out.push({ t: p.name, k: "code", u: `code.html#p-${slug(p.name)}`, d: (p.tags || []).join(" ") }));
  (site.designs || []).forEach((d, i) => out.push({ t: d.title, k: "design", u: `design.html#d-${i + 1}`, d: d.tools }));
  (site.movies || []).filter(m => m.frame).forEach(m => out.push({ t: m.title, k: "frame", u: `shelf.html#f-${slug(m.title)}`, d: m.by }));
  [["movie", site.movies], ["game", site.games], ["book", site.books]].forEach(([k, list]) =>
    (list || []).forEach(it => out.push({ t: it.title, k, u: `shelf.html#s-${slug(it.title)}`, d: it.by })));
  ((site.about || {}).qa || []).forEach((q, i) => out.push({ t: q.q, k: "q&a", u: `about.html#q-${i + 1}` }));
  (site.socials || []).forEach(s => out.push({ t: s.label, k: "link", u: s.url, d: prettyUrl(s.url) }));
  return out;
}

/* ==========================================================
   Build
   ========================================================== */
function minifyCSS(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").replace(/:\s+/g, ":").replace(/;}/g, "}").trim();
}
function minifyJS(js) {
  return js.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*/g, "\n").trim();
}
function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const SITE_JSON = path.join(ROOT, "content/site.json");
function loadSite() {
  if (fs.existsSync(SITE_JSON)) return JSON.parse(fs.readFileSync(SITE_JSON, "utf8"));
  const p = require.resolve("./content/site.js"); // older format still works
  delete require.cache[p];
  return require(p);
}

function build() {
  const t0 = Date.now();
  sizeCache.clear();
  const site = loadSite();
  const css = minifyCSS(fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8"));

  const postDir = path.join(ROOT, "content/posts");
  const posts = (fs.existsSync(postDir) ? fs.readdirSync(postDir) : [])
    .filter(f => f.endsWith(".md"))
    .map(f => readPost(path.join(postDir, f)))
    .filter(p => !p.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const page = (rel, o) => write(rel, layout({ site, css, ...o }));
  const desc = site.description;

  page("index.html", { title: site.name, description: desc, root: "", active: "hey", bodyClass: "is-home", body: homePage(site, posts) });
  page("code.html", { title: `Code — ${site.name}`, description: desc, root: "", active: "code", body: codePage(site) });
  page("design.html", { title: `Design — ${site.name}`, description: desc, root: "", active: "design", body: designPage(site), viewer: true });
  page("shelf.html", { title: `Shelf — ${site.name}`, description: desc, root: "", active: "shelf", body: shelfPage(site), viewer: true });
  page("about.html", { title: `About — ${site.name}`, description: desc, root: "", active: "about", body: aboutPage(site) });

  posts.forEach((p, i) => {
    const data = { prevpost: i > 0 ? posts[i - 1].slug + ".html" : "", nextpost: i < posts.length - 1 ? posts[i + 1].slug + ".html" : "" };
    const o = { title: `${p.title} — ${site.name}`, description: p.summary || desc, root: "../", active: "writing", bodyClass: "is-writing", data, body: writingPage(p, posts) };
    page(`writing/${p.slug}.html`, o);
    if (i === 0) page("writing/index.html", o);
  });
  if (!posts.length) page("writing/index.html", { title: `Writing — ${site.name}`, description: desc, root: "../", active: "writing", body: `<main class="post" id="main"><p>Nothing here yet.</p></main>` });

  page("404.html", {
    title: `Lost — ${site.name}`, description: desc, root: "/", active: "hey", bodyClass: "is-home",
    body: `<main class="home" id="main"><section class="status"><h1 class="sr-only">Page not found</h1><p class="s-lead">${words("This page is:")}</p><p class="s-big">${words("NOT HERE")}</p><p class="s-tail">${words("or anywhere, really")}</p><a class="s-note" href="/index.html">Go back home →</a></section></main><div class="cursor" aria-hidden="true"></div>`,
  });

  write("search.json", JSON.stringify(searchIndex(site, posts)));
  write("app.js", minifyJS(fs.readFileSync(path.join(ROOT, "src/app.js"), "utf8")));
  // the editor on the live site: works only with your GitHub token (see README → Edit from anywhere)
  write("admin/index.html", fs.readFileSync(path.join(ROOT, "src/admin.html"), "utf8"));
  write("robots.txt", "User-agent: *\nDisallow: /admin/\n");
  // host settings (Netlify + Cloudflare Pages both read this file)
  write("_headers", [
    "/admin/*", "  X-Robots-Tag: noindex, nofollow", "  Cache-Control: no-store", "  Referrer-Policy: no-referrer", "  X-Frame-Options: DENY", "",
    "/assets/*", "  Cache-Control: public, max-age=604800", "",
    "/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", "",
  ].join("\n"));
  if (fs.existsSync(path.join(ROOT, "assets"))) fs.cpSync(path.join(ROOT, "assets"), path.join(OUT, "assets"), { recursive: true });

  console.log(`built ${posts.length + 6} pages in ${Date.now() - t0} ms  (index.html ${(fs.statSync(path.join(OUT, "index.html")).size / 1024).toFixed(1)} KB)`);
}

/* ==========================================================
   Dev server + private editor (/admin)
   The editor exists only here: it is never written to dist/, the server only
   listens on this computer (127.0.0.1), and every API call needs a secret key
   that is created fresh each time the server starts.
   ========================================================== */
function dev() {
  const http = require("http");
  const crypto = require("crypto");
  const TOKEN = crypto.randomBytes(24).toString("hex");
  const TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
    ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ico": "image/x-icon",
  };
  const POSTS = path.join(ROOT, "content/posts");
  const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
  const FOLDERS = ["frames", "code", "designs", "posts", "me"];
  const MEDIA_EXT = /\.(jpe?g|png|webp|avif|gif|svg|mp4|webm|mov)$/i;

  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, limit = 300 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("file too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const readJSON = async req => JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString("utf8"));
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
  const rebuild = () => { try { build(); return null; } catch (e) { return e.message; } };

  function backupSite() {
    const dir = path.join(ROOT, "content/.backup");
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(SITE_JSON)) fs.copyFileSync(SITE_JSON, path.join(dir, `site-${stamp()}.json`));
    const old = fs.readdirSync(dir).filter(f => /^site-.*\.json$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - 30)).forEach(f => fs.unlinkSync(path.join(dir, f))); // keep the last 30
  }
  const postFile = s => path.join(POSTS, s + ".md");
  function readRaw(s) {
    const raw = fs.readFileSync(postFile(s), "utf8").replace(/^﻿/, "");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const meta = {};
    if (m) m[1].split(/\r?\n/).forEach(l => { const kv = l.match(/^(\w+)\s*:\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ""); });
    return { slug: s, meta, body: (m ? m[2] : raw).replace(/^\n+/, "") };
  }
  function writeRaw(s, meta, body) {
    const fm = ["title", "date", "summary", "lang", "draft"]
      .filter(k => meta[k] !== undefined && meta[k] !== "" && meta[k] !== false && meta[k] !== "false")
      .map(k => `${k}: ${String(meta[k]).replace(/\r?\n/g, " ")}`).join("\n");
    fs.mkdirSync(POSTS, { recursive: true });
    fs.writeFileSync(postFile(s), `---\n${fm}\n---\n\n${String(body || "").replace(/\r\n/g, "\n").trim()}\n`);
  }

  async function api(req, res, p, q) {
    const m = req.method;
    if (p === "/api/site" && m === "GET") return send(res, 200, loadSite());
    if (p === "/api/site" && m === "PUT") {
      const data = await readJSON(req);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.name) return send(res, 400, { error: "invalid content" });
      backupSite();
      fs.writeFileSync(SITE_JSON, JSON.stringify(data, null, 2) + "\n");
      const err = rebuild();
      return send(res, err ? 500 : 200, err ? { error: err } : { ok: true });
    }
    if (p === "/api/posts" && m === "GET") {
      const list = (fs.existsSync(POSTS) ? fs.readdirSync(POSTS) : []).filter(f => f.endsWith(".md")).map(f => {
        const { slug: s, meta } = readRaw(f.slice(0, -3));
        return { slug: s, title: meta.title || s, date: meta.date || "", lang: meta.lang || "", draft: meta.draft === "true" };
      }).sort((a, b) => (a.date < b.date ? 1 : -1));
      return send(res, 200, list);
    }
    if (p === "/api/post") {
      const s = q.get("slug") || "";
      if (!SLUG.test(s)) return send(res, 400, { error: "Slug can only use a-z, 0-9 and -" });
      if (m === "GET") return fs.existsSync(postFile(s)) ? send(res, 200, readRaw(s)) : send(res, 404, { error: "not found" });
      if (m === "PUT") {
        const { meta = {}, body = "", newSlug, isNew } = await readJSON(req);
        const target = newSlug || s;
        if (!SLUG.test(target)) return send(res, 400, { error: "Slug can only use a-z, 0-9 and -" });
        if ((isNew || target !== s) && fs.existsSync(postFile(target))) return send(res, 409, { error: "A post with that slug already exists" });
        writeRaw(target, meta, body);
        if (target !== s && fs.existsSync(postFile(s))) fs.unlinkSync(postFile(s));
        const err = rebuild();
        return send(res, err ? 500 : 200, err ? { error: err } : { ok: true, slug: target });
      }
      if (m === "DELETE") {
        if (!fs.existsSync(postFile(s))) return send(res, 404, { error: "not found" });
        const trash = path.join(ROOT, "content/.trash");
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(postFile(s), path.join(trash, `${s}-${stamp()}.md`)); // recoverable
        const err = rebuild();
        return send(res, err ? 500 : 200, err ? { error: err } : { ok: true });
      }
    }
    if (p === "/api/upload" && m === "POST") {
      const folder = q.get("folder") || "", name = q.get("name") || "";
      if (!FOLDERS.includes(folder) || !MEDIA_EXT.test(name)) return send(res, 400, { error: "Unsupported file type" });
      const ext = path.extname(name).toLowerCase();
      const base = slug(path.basename(name, path.extname(name))) || "file";
      const dir = path.join(ROOT, "assets", folder);
      fs.mkdirSync(dir, { recursive: true });
      let file = base + ext, n = 2;
      while (fs.existsSync(path.join(dir, file))) file = `${base}-${n++}${ext}`;
      fs.writeFileSync(path.join(dir, file), await readBody(req));
      return send(res, 200, { path: `assets/${folder}/${file}` });
    }
    return send(res, 404, { error: "unknown endpoint" });
  }

  let port = PORT;
  const server = http.createServer(async (req, res) => {
    // only answer requests addressed to this computer (blocks DNS-rebinding tricks)
    const host = req.headers.host || "";
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return send(res, 403, "forbidden", "text/plain");
    const url = new URL(req.url, "http://localhost");
    let p = decodeURIComponent(url.pathname);
    try {
      if (p === "/admin" || p === "/admin/") {
        const html = fs.readFileSync(path.join(ROOT, "src/admin.html"), "utf8").replace("__ADMIN_TOKEN__", TOKEN);
        return send(res, 200, html, TYPES[".html"]);
      }
      if (p.startsWith("/api/")) {
        if (req.headers["x-admin-token"] !== TOKEN) return send(res, 403, { error: "forbidden" });
        return await api(req, res, p, url.searchParams);
      }
    } catch (e) { return send(res, 500, { error: e.message }); }

    if (p.endsWith("/")) p += "index.html";
    const rel = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
    const fallback = p.startsWith("/assets/") ? path.join(ROOT, rel) : null; // fresh uploads, before the next build copies them
    const serve = f => fs.readFile(f, (err, data) => {
      if (err) {
        if (fallback && f !== fallback) return serve(fallback);
        res.writeHead(404, { "Content-Type": TYPES[".html"] });
        return fs.createReadStream(path.join(OUT, "404.html")).pipe(res);
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    });
    serve(path.join(OUT, rel));
  });
  server.on("error", e => {
    if (e.code !== "EADDRINUSE" || port > PORT + 20) throw e;
    console.log(`port ${port} is busy, trying ${port + 1}…`);
    server.listen(++port, "127.0.0.1");
  });
  server.on("listening", () => {
    console.log(`site:   http://localhost:${port}`);
    console.log(`editor: http://localhost:${port}/admin   (only on this computer · Ctrl+C to stop)`);
  });
  server.listen(port, "127.0.0.1");

  let timer;
  const watchRebuild = () => { clearTimeout(timer); timer = setTimeout(() => { const e = rebuild(); if (e) console.error(e); }, 120); };
  ["content", "src", "assets"].forEach(d => {
    const dir = path.join(ROOT, d);
    if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, (ev, f) => { if (!/^\.(backup|trash)|admin\.html$/.test(String(f || ""))) watchRebuild(); });
  });
}

build();
if (process.argv.includes("--dev")) dev();
