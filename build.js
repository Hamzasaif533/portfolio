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
    } else if (b.toString("ascii", 4, 8) === "ftyp") { // mp4 / mov: the video track's size from its tkhd box
      for (let i = b.indexOf("tkhd"); i > 0 && !out; i = b.indexOf("tkhd", i + 4)) {
        const at = i + 4 + (b[i + 4] === 1 ? 88 : 76), w = b.readUInt32BE(at) >>> 16, h = b.readUInt32BE(at + 4) >>> 16;
        if (w && h) out = [w, h];
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
  ["Shelf", "shelf.html", "shelf"],
  ["Code", "code.html", "code"],
  ["Design", "design.html", "design"],
  ["Writing", "writing/index.html", "writing"],
  ["About", "about.html", "about"],
];


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

/* the logo: an H whose right leg is a 7 (the crossbar runs into the 7's stroke) */
const LOGO_PATH = `<path pathLength="1" d="M7 6v20M7 16h14M13 6h12l-8 20"/>`;
const logo = () => `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">${LOGO_PATH}</svg>`;

function layout({ site, css, title, description, root, active, body, bodyClass = "", data = {}, viewer = false }) {
  const i = TABS.findIndex(t => t[2] === active);
  const prev = TABS[(i - 1 + TABS.length) % TABS.length], next = TABS[(i + 1) % TABS.length];
  const attrs = { root, prev: root + prev[1], next: root + next[1], ...data };
  const spec = { prefetch: [{ urls: [cleanUrl(attrs.prev), cleanUrl(attrs.next)], eagerness: "eager" }, { where: { href_matches: "/*" }, eagerness: "moderate" }] };
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
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(16 16) scale(.78) translate(-16 -16)">${LOGO_PATH}</g></svg>`)}">
<link rel="preload" href="${root}assets/fonts/geist-mono-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}${css}">
${hasArabic(body + title) ? `<link rel="preload" href="${root}assets/fonts/rubik-arabic.woff2" as="font" type="font/woff2" crossorigin>` : ""}
<noscript><style>.tile .media{opacity:1!important;transform:none!important}</style></noscript>
<script>try{if(!sessionStorage.getItem("booted")){document.documentElement.classList.add("booting");setTimeout(()=>document.documentElement.classList.remove("booting"),15000)}}catch(e){}</script>
<script type="speculationrules">${JSON.stringify(spec)}</script>
<script>for(const t of["pageswap","pagereveal"])addEventListener(t,e=>{const v=e.viewTransition;if(v)for(const p of["ready","finished","updateCallbackDone"])v[p]&&v[p].catch(()=>{})})</script>
</head>
<body class="${bodyClass}"${Object.entries(attrs).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}>
<div id="boot" aria-hidden="true"><div class="boot-in">${logo()}<div class="boot-bar"><i></i></div><div class="boot-row"><span class="boot-pct">0%</span><button type="button" class="boot-skip" tabindex="-1">skip</button></div></div></div>
<header class="top">
  <a class="chip logo" href="${root}index.html" aria-label="${esc(site.name)}, home" title="${esc(site.name)}">${logo()}</a>
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
<div class="cursor" aria-hidden="true"></div>
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
    .map(([k, list, ic, href]) => [k, (list || []).find(x => x.now) || (k === "Building" && site.repos && site.repos[0] && { title: site.repos[0].name, status: site.repos[0].language }), ic, href])
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
</main>`;
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

/* Code page: one picture tile per GitHub repo (hover shows the details, click opens GitHub).
   Picture: drop assets/code/<repo-name>.mp4 / .webm / .webp / .jpg / .png to use your own (video loops);
   otherwise GitHub's preview card for the repo is used. Projects added in the editor come after the repos. */
const CODE_MEDIA = ["mp4", "webm", "webp", "jpg", "jpeg", "png", "gif", "svg"];
function repoMedia(site, r) {
  for (const ext of CODE_MEDIA) {
    const rel = `assets/code/${r.name}.${ext}`;
    if (fs.existsSync(path.join(ROOT, rel))) return { image: rel };
  }
  return { image: `https://opengraph.githubassets.com/1/${site.github}/${r.name}`, width: 1200, height: 600 };
}

function codePage(site) {
  const repos = (site.repos || []).map(r => ({
    name: r.name,
    description: r.description,
    tags: [r.language, r.stars ? `★ ${r.stars}` : ""].filter(Boolean),
    status: r.pushed ? `updated ${r.pushed.slice(0, 10).replace(/-/g, ".")}` : "",
    repo: r.url,
    ...repoMedia(site, r),
  }));
  // a project in the editor with the same name as a repo fills in / overrides that repo's details
  const own = new Map((site.projects || []).map(p => [String(p.name).toLowerCase(), p]));
  const merged = repos.map(r => {
    const p = own.get(r.name.toLowerCase());
    if (!p) return r;
    own.delete(r.name.toLowerCase());
    return { ...r, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length))) };
  });
  const all = merged.concat([...own.values()]);
  const tiles = all.map((p, i) => {
    const link = p.repo || p.live || "";
    const meta = [p.tags && p.tags.join(" · "), p.status || p.year].filter(Boolean).join(" / ");
    const tag = link ? "a" : "div";
    return `<${tag} class="tile" id="p-${slug(p.name)}" data-item${link ? ` href="${esc(link)}"${linkAttrs(link)}` : ' tabindex="-1"'} data-title="${esc(p.name)}" data-desc="${esc(p.description)}" data-meta="${esc([meta, prettyUrl(link)].filter(Boolean).join("\n"))}">
      ${tileImg(p.image, p.name, p.width, p.height, i < 3)}
      <span class="tile-cap"><b>${esc(p.name)}</b>${esc(p.description)}</span>
    </${tag}>`;
  }).join("");
  return `<main class="grid-page" id="main">${pageHead("Code", `${all.length} projects`)}<div class="masonry">${tiles}</div></main><div class="fade" aria-hidden="true"></div><div class="cap" aria-hidden="true"></div>`;
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
/* Newest watched first. Films without a watched date keep your list order, after the dated ones. */
const byWatched = movies => movies.map((m, i) => [m, i])
  .sort((a, b) => (b[0].watched ? 1 : 0) - (a[0].watched ? 1 : 0) || String(b[0].watched || "").localeCompare(String(a[0].watched || "")) || a[1] - b[1])
  .map(([m]) => m);

function filmDiary(movies = []) {
  const withFrames = byWatched(movies).filter(m => m.frame); // newest watched first, one continuous wall
  if (!withFrames.length) return "";
  // TMDB's terms ask for a credit wherever their images are shown
  const credit = withFrames.some(m => /.jpe?g$/i.test(m.frame || "")) ? `<p class="credit">Stills via TMDB</p>` : "";
  return `<section class="diary" aria-label="Film diary">
    <div class="frames">${withFrames.map(m => {
      const meta = [m.year, m.by, ratingText(m), m.watched ? `watched ${m.watched.replace(/-/g, ".")}` : ""].filter(Boolean).join(" · ");
      return `<button type="button" class="tile frame" id="f-${slug(m.title)}" data-item${viewAttrs("frames", m.frame, m.title, meta, m.note)}>
        ${tileImg(webp(smallFrame(m.frame)), `Frame from ${m.title}`, m.frameWidth, m.frameHeight, false)}
      </button>`;
    }).join("")}</div>
  </section>${credit}`;
}

/* ---------- shelf: watchlist + stats ---------- */
function watchlistPanel(site) {
  const wl = site.watchlist || [];
  if (!wl.length) return `<p class="empty-note">Your Letterboxd watchlist shows here after the next build.</p>`;
  const note = wl.some(f => f.lbRating) ? `<p class="wl-note">Ratings are Letterboxd averages</p>` : "";
  return `<div class="wl-bar"><button type="button" class="wl-pick" data-item><span>Pick one for me</span></button>${note}</div><ul class="list pl wl">${wl.map(f => {
    const url = `https://letterboxd.com/film/${f.slug}/`, p = coverPath("film", f);
    const poster = `<span class="p" aria-hidden="true">${localFile(p) ? `<img src="${esc(webp(p))}" alt="" width="300" height="450" loading="lazy" decoding="async">` : `<span>${esc(f.title)}</span>`}</span>`;
    return `<li id="w-${slug(f.title)}"><a href="${esc(url)}"${linkAttrs(url)} data-item>${poster}<span class="t">${esc(f.title)}</span><span class="y">${esc(f.year || "")}</span><span class="r"${f.lbRating ? ` title="Letterboxd average" aria-label="Letterboxd average ${f.lbRating.toFixed(2)} out of 5"` : ""}>${f.lbRating ? `${f.lbRating.toFixed(1)}<i>★</i>` : ""}</span></a></li>`;
  }).join("")}</ul>`;
}

/* ---------- stats (in the spirit of Letterboxd's Pro stats page) ----------
   Everything that counts films is a button: clicking it lists those films (from the JSON
   embedded in the page, "statfilms"), and each film in that list jumps to its row. */
const fmtN = n => Number(n).toLocaleString("en-US");
const plural = (n, w) => `${fmtN(n)} ${n === 1 ? w : w + "s"}`;
const avgOf = list => { const r = list.filter(m => m.rating != null); return r.length ? r.reduce((n, m) => n + Number(m.rating), 0) / r.length : null; };
// attributes that make an element open the list of these films
const pick = (ids, title) => ` type="button" data-item data-films="${ids.join(",")}" data-ftitle="${esc(title)}"`;

/* one-hue bar chart; each bar is a button that lists its films */
function barChart(rows, { unit = "film", value = r => r.ids.length, fmt = v => plural(v, unit), max } = {}) {
  const top = max || Math.max(1, ...rows.map(value));
  return `<div class="bars" role="group">${rows.map(r => {
    const v = value(r), tip = `${r.tip || r.label}: ${fmt(v)}`;
    return `<button class="cb${v ? "" : " zero"}"${r.ids.length ? pick(r.ids, r.tip || r.label) : ' type="button" disabled'} style="--v:${(v / top).toFixed(3)}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><i></i></button>`;
  }).join("")}</div>
    <div class="axis" aria-hidden="true">${rows.map(r => `<span>${esc(r.short ?? "")}</span>`).join("")}</div>`;
}

/* genre icons from Lucide (lucide.dev), ISC licence: Copyright (c) Lucide Contributors 2022, portions (c) Cole Bemis 2013-2022 (Feather, MIT) */
const GENRE_ICONS = {
  "Romance": "<path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\"/>",
  "Drama": "<path d=\"M10 11h.01\"/><path d=\"M14 6h.01\"/><path d=\"M18 6h.01\"/><path d=\"M6.5 13.1h.01\"/><path d=\"M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3\"/><path d=\"M17.4 9.9c-.8.8-2 .8-2.8 0\"/><path d=\"M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7\"/><path d=\"M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4\"/>",
  "Comedy": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z\"/><line x1=\"9\" x2=\"9.01\" y1=\"9\" y2=\"9\"/><line x1=\"15\" x2=\"15.01\" y1=\"9\" y2=\"9\"/>",
  "Thriller": "<path d=\"M7 18v-6a5 5 0 1 1 10 0v6\"/><path d=\"M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z\"/><path d=\"M21 12h1\"/><path d=\"M18.5 4.5 18 5\"/><path d=\"M2 12h1\"/><path d=\"M12 2v1\"/><path d=\"m4.929 4.929.707.707\"/><path d=\"M12 12v6\"/>",
  "Horror": "<path d=\"M9 10h.01\"/><path d=\"M15 10h.01\"/><path d=\"M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z\"/>",
  "Science Fiction": "<path d=\"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z\"/><path d=\"m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z\"/><path d=\"M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0\"/><path d=\"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5\"/>",
  "Mystery": "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
  "Crime": "<path d=\"M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4\"/><path d=\"M14 13.12c0 2.38 0 6.38-1 8.88\"/><path d=\"M17.29 21.02c.12-.6.43-2.3.5-3.02\"/><path d=\"M2 12a10 10 0 0 1 18-6\"/><path d=\"M2 16h.01\"/><path d=\"M21.8 16c.2-2 .131-5.354 0-6\"/><path d=\"M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2\"/><path d=\"M8.65 22c.21-.66.45-1.32.57-2\"/><path d=\"M9 6.8a6 6 0 0 1 9 5.2v2\"/>",
  "History": "<line x1=\"3\" x2=\"21\" y1=\"22\" y2=\"22\"/><line x1=\"6\" x2=\"6\" y1=\"18\" y2=\"11\"/><line x1=\"10\" x2=\"10\" y1=\"18\" y2=\"11\"/><line x1=\"14\" x2=\"14\" y1=\"18\" y2=\"11\"/><line x1=\"18\" x2=\"18\" y1=\"18\" y2=\"11\"/><polygon points=\"12 2 20 7 4 7\"/>",
  "Action": "<polyline points=\"14.5 17.5 3 6 3 3 6 3 17.5 14.5\"/><line x1=\"13\" x2=\"19\" y1=\"19\" y2=\"13\"/><line x1=\"16\" x2=\"20\" y1=\"16\" y2=\"20\"/><line x1=\"19\" x2=\"21\" y1=\"21\" y2=\"19\"/><polyline points=\"14.5 6.5 18 3 21 3 21 6 17.5 9.5\"/><line x1=\"5\" x2=\"9\" y1=\"14\" y2=\"18\"/><line x1=\"7\" x2=\"4\" y1=\"17\" y2=\"20\"/><line x1=\"3\" x2=\"5\" y1=\"19\" y2=\"21\"/>",
  "Adventure": "<path d=\"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "War": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/>",
  "Family": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
  "Animation": "<circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\"/><path d=\"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z\"/>",
  "Fantasy": "<path d=\"m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72\"/><path d=\"m14 7 3 3\"/><path d=\"M5 6v4\"/><path d=\"M19 14v4\"/><path d=\"M10 2v2\"/><path d=\"M7 8H3\"/><path d=\"M21 16h-4\"/><path d=\"M11 3H9\"/>",
  "Music": "<path d=\"M9 18V5l12-2v13\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>",
  "Documentary": "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\"/><rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"/>",
  "Western": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>",
  "TV Movie": "<rect width=\"20\" height=\"15\" x=\"2\" y=\"7\" rx=\"2\" ry=\"2\"/><polyline points=\"17 2 12 7 7 2\"/>",
  "_film": "<path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z\"/><path d=\"m6.2 5.3 3.1 3.9\"/><path d=\"m12.4 3.4 3.1 4\"/><path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/>",
  "_silent": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/><line x1=\"22\" x2=\"16\" y1=\"9\" y2=\"15\"/><line x1=\"16\" x2=\"22\" y1=\"9\" y2=\"15\"/>",
};
const LANG_CODES = { English: "EN", Korean: "KO", Spanish: "ES", Danish: "DA", French: "FR", German: "DE", Italian: "IT", Japanese: "JA", Chinese: "ZH", Mandarin: "ZH", Cantonese: "YUE", Hindi: "HI", Arabic: "AR", Russian: "RU", Swedish: "SV", Norwegian: "NO", Dutch: "NL", Portuguese: "PT", Greek: "EL", Turkish: "TR", Polish: "PL", Persian: "FA", Hebrew: "HE", Thai: "TH", Tamil: "TA", Telugu: "TE", Serbian: "SR", Irish: "GA", Latin: "LA" };

/* a ranked list with thin bars: [name, ids, extra] */
function rankList(rows, { max, extra = () => "", icon } = {}) {
  if (!rows.length) return `<p class="empty-note">Not enough films yet.</p>`;
  const top = max || Math.max(...rows.map(r => r[1].length));
  return `<ol class="hbars${icon ? " with-ic" : ""}">${rows.map(([name, ids, x]) => `<li><button${pick(ids, name)}><span class="nm">${icon ? icon(name) : ""}<span>${esc(name)}</span></span><span class="hb"><i style="--v:${(ids.length / top).toFixed(3)}"></i></span><span class="ct">${ids.length}</span><span class="av">${x != null ? esc(x) : extra(ids)}</span></button></li>`).join("")}</ol>`;
}

/* a figure with Most watched / Highest rated (or other) views */
function switchable(title, note, views) {
  return `<figure class="chart wide sw">
    <figcaption><span>${esc(title)}</span><span class="seg" role="group">${views.map(([name], i) => `<button type="button" data-seg="${i}" aria-pressed="${i === 0}">${esc(name)}</button>`).join("")}</span></figcaption>
    ${views.map(([, body], i) => `<div class="seg-view"${i ? " hidden" : ""}>${body}</div>`).join("")}
    ${note ? `<p class="chart-note">${esc(note)}</p>` : ""}
  </figure>`;
}

function statsPanel(site) {
  const movies = byWatched(site.movies || []);
  if (!movies.length) return `<p class="empty-note">Add some films to see your stats.</p>`;
  const meta = m => (site.meta || {})[m.title + "|" + (m.year || "")] || {};
  const ids = list => list.map(m => movies.indexOf(m));
  const dated = movies.filter(m => /^\d{4}-\d{2}-\d{2}$/.test(m.watched || ""));
  const rated = movies.filter(m => m.rating != null);
  const stars1 = v => (v == null ? "" : `${v.toFixed(1)}★`);
  const avgStr = list => stars1(avgOf(list));

  // group films by a key (or several keys per film)
  const groupBy = (keyFn) => {
    const map = new Map();
    for (const m of movies) for (const k of [].concat(keyFn(m) || [])) { if (k == null || k === "") continue; if (!map.has(k)) map.set(k, []); map.get(k).push(m); }
    return map;
  };
  const mostWatched = (map, n = 8, min = 1) => [...map.entries()].filter(([, l]) => l.length >= min).sort((a, b) => b[1].length - a[1].length || (avgOf(b[1]) || 0) - (avgOf(a[1]) || 0) || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
  const highestRated = (map, n = 8, min = 2) => [...map.entries()].filter(([, l]) => l.filter(m => m.rating != null).length >= min).sort((a, b) => avgOf(b[1]) - avgOf(a[1]) || b[1].length - a[1].length).slice(0, n);
  const asRows = list => list.map(([k, l]) => [k, ids(l), avgStr(l)]);

  // small pictures beside names; the names asked for here are the ones the build fetches pictures for
  const pics = readPics(), want = statsPanel.wanted = { country: new Set(), person: new Set(), studio: new Set(), role: {} };
  // a photo or logo you chose in the editor (Photos) wins over the one found on Wikimedia
  const chosen = { person: site.photos || {}, studio: site.logos || {} };
  const initials = n => esc(String(n).split(/\s+/).filter(w => /^\p{L}/u.test(w)).slice(0, 2).map(w => w[0]).join("").toUpperCase());
  const picIcon = (kind, role) => name => {
    want[kind].add(name); want.role[name] = want.role[name] || role;
    const own = chosen[kind][name];
    if (localFile(own)) return `<img class="ic ${kind}" src="${esc(own)}" alt="" loading="lazy" decoding="async" width="26" height="26">`;
    const e = (pics[kind] || {})[name];
    return e && e.img && localFile(e.img)
      ? `<img class="ic ${kind}" src="${esc(e.img)}" title="${esc(name)} · picture: ${esc(e.file)}, Wikimedia Commons" alt="" loading="lazy" decoding="async" width="26" height="26">`
      : `<span class="ic ${kind} none" aria-hidden="true">${initials(name)}</span>`;
  };
  const shapeIcon = name => {
    want.country.add(name);
    const d = (pics.shapes || {})[name];
    return `<svg class="ic shape" viewBox="0 0 24 24" aria-hidden="true">${d ? `<path d="${d}"/>` : `<circle cx="12" cy="12" r="2.5"/>`}</svg>`;
  };
  const genreIcon = name => `<svg class="ic genre" viewBox="0 0 24 24" aria-hidden="true">${GENRE_ICONS[name] || GENRE_ICONS._film}</svg>`;
  const langIcon = name => GENRE_ICONS._silent && /no spoken/i.test(name)
    ? `<svg class="ic genre" viewBox="0 0 24 24" aria-hidden="true">${GENRE_ICONS._silent}</svg>`
    : `<span class="ic lang" aria-hidden="true">${esc(LANG_CODES[name] || String(name).slice(0, 2).toUpperCase())}</span>`;
  const posterOf = m => webp(localFile(m.poster) ? m.poster : localFile(coverPath("film", m)) ? coverPath("film", m) : "");
  const listOf = (map, rated, icon, n = 8, min = 2) => rankList(asRows(rated ? highestRated(map, n, min) : mostWatched(map, n, min)), { icon });

  /* ---- Top 4 ---- */
  const favs = (site.favourites || []).slice(0, 4);
  const top4 = favs.length ? `<section class="top4-wrap" aria-label="Top 4">
    <p class="st-label"><span>Top 4</span></p>
    <ol class="top4">${favs.map(f => { const url = `https://letterboxd.com/film/${f.slug}/`; return `<li><a href="${esc(url)}"${linkAttrs(url)}>${f.poster ? `<img src="${esc(webp(f.poster))}" alt="${esc(f.title)}" width="230" height="345" decoding="async">` : `<span class="ph">${esc(f.title)}</span>`}<span class="cap4">${esc(f.title)}${f.year ? ` <i>${f.year}</i>` : ""}</span></a></li>`; }).join("")}</ol>
  </section>` : "";

  /* ---- headline numbers ---- */
  const minutes = movies.reduce((n, m) => n + (meta(m).runtime || 0), 0);
  const directors = groupBy(m => m.by);
  const countries = groupBy(m => mainCountry(meta(m).countries, meta(m).language)); // one country per film
  // longest streak: consecutive weeks (Mon–Sun) with at least one film
  const weekNo = d => Math.floor((Date.parse(d + "T00:00:00Z") / 864e5 + 3) / 7);
  const weeks = [...new Set(dated.map(m => weekNo(m.watched)))].sort((a, b) => a - b);
  let streak = weeks.length ? 1 : 0, run = 1, runEnd = weeks[0], bestEnd = weeks[0];
  for (let i = 1; i < weeks.length; i++) { run = weeks[i] === weeks[i - 1] + 1 ? run + 1 : 1; if (run > streak) { streak = run; bestEnd = weeks[i]; } }
  const streakFilms = dated.filter(m => { const w = weekNo(m.watched); return w > bestEnd - streak && w <= bestEnd; });
  const tiles = [
    [fmtN(movies.length), "Films", ids(movies)],
    [fmtN(Math.round(minutes / 60)), "Hours", null],
    [fmtN(directors.size), "Directors", null, "#st-directors"],
    [fmtN(countries.size), "Countries", null, "#st-gcl"],
    [`${streak}w`, "Longest streak", ids(streakFilms)],
  ].map(([n, k, list, href]) => list && list.length
    ? `<button class="tile-stat"${pick(list, k)}><b>${esc(n)}</b><span>${esc(k)}</span></button>`
    : href ? `<a class="tile-stat" href="${href}" data-item><b>${esc(n)}</b><span>${esc(k)}</span></a>`
    : `<div class="tile-stat"><b>${esc(n)}</b><span>${esc(k)}</span></div>`).join("");

  /* ---- by year: films / ratings (by release year) and diary (by month) ---- */
  const years = movies.filter(m => m.year).map(m => +m.year);
  const y0 = Math.min(...years), y1 = Math.max(...years);
  const perYear = groupBy(m => (m.year ? +m.year : null));
  const yearRows = [];
  for (let y = y0; y <= y1; y++) yearRows.push({ label: String(y), short: y % 10 === 0 || y === y0 || y === y1 ? `’${String(y).slice(2)}` : "", ids: ids(perYear.get(y) || []), list: perYear.get(y) || [] });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const latest = dated.map(m => m.watched).sort().pop() || new Date().toISOString().slice(0, 10);
  const perMonth = groupBy(m => (dated.includes(m) ? m.watched.slice(0, 7) : null));
  const monthRows = [];
  for (let i = 11, y = +latest.slice(0, 4), mo = +latest.slice(5, 7); i >= 0; i--) {
    const d = new Date(Date.UTC(y, mo - 1 - i, 1)), key = d.toISOString().slice(0, 7), name = MONTHS[d.getUTCMonth()];
    monthRows.push({ label: `${name} ${d.getUTCFullYear()}`, short: name[0], ids: ids(perMonth.get(key) || []) });
  }
  const byYear = `<div id="st-year">` + switchable("By year", "", [
    ["Films", barChart(yearRows)],
    ["Ratings", barChart(yearRows.map(r => ({ ...r, ids: ids(r.list.filter(m => m.rating != null)) })), { value: r => avgOf(r.list) || 0, fmt: v => (v ? `${v.toFixed(2)}★ average` : "no ratings"), max: 5 })],
    ["Diary", barChart(monthRows)],
  ]) + `</div>`;

  /* ---- ratings spread ---- */
  const perRating = groupBy(m => (m.rating != null ? Number(m.rating) : null));
  const ratingRows = Array.from({ length: 10 }, (_, i) => (i + 1) / 2).map((r, i) => ({ label: stars(r), short: i === 0 ? "½" : i === 9 ? "★★★★★" : "", ids: ids(perRating.get(r) || []) }));
  const ratings = `<figure class="chart"><figcaption><span>Ratings</span><span>${rated.length} rated · ${avgStr(rated)} average</span></figcaption>${barChart(ratingRows)}</figure>`;

  /* ---- highest rated decades (with a frame from each) ---- */
  const decadesMap = groupBy(m => (m.year ? Math.floor(m.year / 10) * 10 : null));
  const bestDecades = highestRated(decadesMap, 3, 2);
  const decadesBest = bestDecades.length ? `<figure class="chart wide"><figcaption><span>Highest rated decades</span><span>2+ rated films</span></figcaption>
    <ol class="decades">${bestDecades.map(([d, l]) => {
      const tops = l.filter(m => m.rating != null).sort((a, b) => b.rating - a.rating).slice(0, 4);
      return `<li><button${pick(ids(l), `${d}s`)}><span class="dh"><b>${d}s</b><span>${avgStr(l)} · ${plural(l.length, "film")}</span></span><span class="thumbs">${tops.map(m => m.frame ? `<img src="${esc(webp(smallFrame(m.frame)))}" alt="" loading="lazy" decoding="async">` : `<span class="ph">${esc(m.title)}</span>`).join("")}</span></button></li>`;
    }).join("")}</ol></figure>` : "";

  /* ---- genres, countries & languages ---- */
  const genres = groupBy(m => meta(m).genres), languages = groupBy(m => meta(m).language);
  const gclCol = (title, map, mode) => `<div class="gcl-col"><p class="col-h">${esc(title)}</p>${listOf(map, mode === "rated", map === countries ? shapeIcon : map === genres ? genreIcon : langIcon, 6, mode === "rated" ? 2 : 1)}</div>`;
  const gcl = `<div id="st-gcl">${switchable("Genres, countries & languages", "", [
    ["Most watched", `<div class="gcl">${gclCol("Genres", genres)}${gclCol("Countries", countries)}${gclCol("Languages", languages)}</div>`],
    ["Highest rated", `<div class="gcl">${gclCol("Genres", genres, "rated")}${gclCol("Countries", countries, "rated")}${gclCol("Languages", languages, "rated")}</div>`],
  ])}</div>`;

  /* ---- rated higher / lower than the Letterboxd average ---- */
  const diffs = rated.filter(m => meta(m).rating).map(m => ({ m, d: m.rating - meta(m).rating }));
  const diffList = list => list.length ? `<ol class="difflist with-ic">${list.map(({ m, d }) => `<li><button${pick(ids([m]), m.title)}><span class="nm"><span class="ic poster" aria-hidden="true">${posterOf(m) ? `<img src="${esc(posterOf(m))}" alt="" loading="lazy" decoding="async" width="20" height="30">` : ""}</span><span>${esc(m.title)}</span></span><span class="ct">${esc(m.year || "")}</span><span class="av">${stars(m.rating)}</span><span class="df">${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}</span></button></li>`).join("")}</ol>` : `<p class="empty-note">Nothing yet.</p>`;
  const vsAvg = diffs.length ? switchable("Compared with Letterboxd", "Your rating minus the Letterboxd average", [
    ["Rated higher", diffList(diffs.filter(x => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 6))],
    ["Rated lower", diffList(diffs.filter(x => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 6))],
  ]) : "";

  /* ---- people ---- */
  const cast = groupBy(m => meta(m).cast);
  const studios = groupBy(m => meta(m).studios);
  const castBox = cast.size ? switchable("Cast", "", [
    ["Most watched", listOf(cast, false, picIcon("person", "cast"))],
    ["Highest rated", listOf(cast, true, picIcon("person", "cast"))],
  ]) : "";
  const dirBox = `<div id="st-directors">${switchable("Directors", "", [
    ["Most watched", listOf(directors, false, picIcon("person", "director"))],
    ["Highest rated", listOf(directors, true, picIcon("person", "director"))],
  ])}</div>`;
  const studioBox = studios.size ? switchable("Studios", "", [
    ["Most watched", listOf(studios, false, picIcon("studio", "studio"))],
    ["Highest rated", listOf(studios, true, picIcon("studio", "studio"))],
  ]) : "";

  /* ---- when you watch ---- */
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const perDay = groupBy(m => (dated.includes(m) ? (new Date(m.watched + "T12:00:00Z").getUTCDay() + 6) % 7 : null));
  const days = `<figure class="chart"><figcaption><span>Day of the week</span><span>${dated.length} dated</span></figcaption>${barChart(DAYS.map((d, i) => ({ label: d, tip: `${d}s`, short: d[0], ids: ids(perDay.get(i) || []) })))}</figure>`;

  // the films every button above can list
  const data = movies.map(m => ({ t: m.title, y: m.year || "", r: ratingText(m), id: `s-${slug(m.title)}`, f: m.frame ? webp(smallFrame(m.frame)) : "", p: posterOf(m) }));
  return `<div class="stats">
    ${top4}
    <div class="tiles-stat">${tiles}</div>
    <div class="charts">
      ${byYear}
      ${ratings}
      ${days}
      ${decadesBest}
      ${vsAvg}
      ${gcl}
      ${dirBox}
      ${castBox}
      ${studioBox}
    </div>
    <dialog class="filmlist" aria-label="Films"><div class="fl-head"><p class="fl-title"></p><button class="fl-close" type="button" aria-label="Close">×</button></div><ul class="fl-list"></ul></dialog>
    <script type="application/json" id="statfilms">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
  </div>`;
}

const LAZY_TABS = new Set(["diary", "watchlist", "games", "books", "stats"]);
function shelfPage(site) {
  shelfPage.parts = {};
  const movies = byWatched(site.movies || []), books = site.books || [], games = site.games || [];
  // rows are plain (frames open from the Movie frames tab only)
  const frameView = () => "";
  // every movie, game and book is a poster card: the poster you chose in the editor, else the one found for it
  const thumb = (it, kind) => {
    const own = localFile(it.poster), p = own ? it.poster : localFile(coverPath(kind, it)) ? coverPath(kind, it) : "";
    return `<span class="p" aria-hidden="true">${p ? `<img src="${esc(webp(p))}" alt="" width="300" height="450" loading="lazy" decoding="async">` : `<span>${esc(it.title)}</span>`}</span>`;
  };
  const row = (it, i, posters) => `<li${it.now ? ' class="now"' : ""} id="s-${coverSlug(it.title)}" tabindex="-1" data-item data-i="${i}" data-year="${Number(it.year) || 0}" data-score="${Number(it.rating) || 0}" data-liked="${it.liked ? 1 : 0}"${frameView(it)}>
      ${posters ? thumb(it, posters) : ""}<span class="t">${esc(it.title)}</span>
      <span class="y">${esc(it.year || "")}</span>
      <span class="b">${esc(it.by || "")}</span>
      <span class="r"${it.rating != null ? ` aria-label="${it.rating} out of 5${it.liked ? ", liked" : ""}"` : ""}>${ratingText(it)}</span>
      ${it.note ? `<span class="n" dir="auto">${esc(it.note)}</span>` : ""}
    </li>`;
  const list = (items, posters) => `<ul class="list${posters ? " pl" : ""}">${items.map((it, i) => row(it, i, posters)).join("")}</ul>`;
  const sortBar = `<div class="sort" role="group" aria-label="Sort movies"><span>sort</span>${[["recent", "recent"], ["year", "year"], ["score", "score"], ["liked", "♥"]]
    .map(([k, t]) => `<button type="button" data-item data-sort="${k}" aria-pressed="${k === "recent"}" data-arrow="↓">${t}</button>`).join("")}</div>`;
  const frames = movies.filter(m => m.frame).length;
  // tabs: Movies (with Movies / Frames / Watchlist inside), Games, Books, Stats
  const tabs = (cls, label, list) => `${cls === "shelf-tabs" ? `<div class="shelf-head">` : ""}<div class="${cls}" role="tablist" aria-label="${label}">${list.map(([id, t, n], i) =>
      `<button type="button" role="tab" id="tab-${id}" aria-controls="${id}" aria-selected="${i === 0}" data-item data-tab="${id}">${t}${n == null ? "" : `<span>${pad2(n)}</span>`}</button>`).join("")}</div>${cls === "shelf-tabs" ? `</div>` : ""}
    ${list.map(([id, , , body], i) => {
      if (!LAZY_TABS.has(id)) return `<section class="panel" id="${id}" role="tabpanel" aria-labelledby="tab-${id}"${i ? " hidden" : ""}>${body}</section>`;
      shelfPage.parts[id] = body;
      return `<section class="panel" id="${id}" role="tabpanel" aria-labelledby="tab-${id}" data-src="parts/shelf-${id}"${i ? " hidden" : ""}><p class="empty-note">Loading…</p><noscript><p class="empty-note">This tab needs JavaScript.</p></noscript></section>`;
    }).join("")}`;
  const MOVIE_TABS = [
    ["films", "Movies", movies.length, sortBar + list(movies, "film")],
    ["diary", "Frames", frames, filmDiary(movies) || `<p class="empty-note">Add a <code>frame</code> to a movie to start your film diary.</p>`],
    ["watchlist", "Watchlist", (site.watchlist || []).length, watchlistPanel(site)],
  ];
  const TABS_ = [
    ["movies", "Movies", movies.length, tabs("sub-tabs", "Movies", MOVIE_TABS)],
    ["games", "Games", games.length, list(games, "game")],
    ["books", "Books", books.length, list(books, "book")],
    ["stats", "Stats", null, statsPanel(site)],
  ];
  return `<main class="shelf" id="main">${pageHead("Shelf")}
    ${tabs("shelf-tabs", "Shelf", TABS_)}
  </main>`;
}

/* everything the film popup shows, by the film's row id (s-<title>) */
function filmCards(site) {
  const pics = readPics();
  const meta = m => (site.meta || {})[m.title + "|" + (m.year || "")] || {};
  const icons = {}, films = {}, shapes = {};
  for (const m of site.movies || []) {
    const x = meta(m), poster = localFile(m.poster) ? m.poster : localFile(coverPath("film", m)) ? coverPath("film", m) : "";
    const genres = [].concat(x.genres || []);
    genres.forEach(g => { icons[g] = GENRE_ICONS[g] || GENRE_ICONS._film; });
    films[`s-${slug(m.title)}`] = {
      t: m.title, y: m.year || "", r: m.rating != null ? stars(m.rating) : "", l: !!m.liked, note: m.note || "", w: m.watched || "",
      p: webp(poster), f: m.frame ? webp(smallFrame(m.frame)) : "", ff: m.frame || "",
      d: String(m.by || "").split(/\s*&\s*/).filter(Boolean), c: [].concat(x.cast || []).slice(0, 3), // names only, no photos
      co: [mainCountry(x.countries, x.language)].filter(Boolean).map(n => { shapes[n] = (pics.shapes || {})[n] || ""; return n; }), g: genres,
      rt: x.runtime || 0, avg: x.rating ? x.rating.toFixed(1) : "", lb: x.slug ? `https://letterboxd.com/film/${x.slug}/` : "",
    };
  }
  return { icons, shapes, films };
}

function aboutPage(site) {
  const a = site.about || {};
  const avatar = a.avatar
    ? `<img class="avatar" src="${esc(a.avatar)}" alt="${esc(site.name)}" ${dims(a.avatar, 140, 140)}>`
    : `<div class="avatar ph" aria-hidden="true">${logo()}</div>`;
  return `<main class="about" id="main">
  <h1 class="sr-only">About</h1>
  <section class="row">
    <div class="side">${avatar}</div>
    <div class="body bio">${[].concat(a.bio || []).map(p => `<p dir="auto">${inline(p)}</p>`).join("")}${a.signoff ? `<p class="dim">${esc(a.signoff)}</p>` : ""}</div>
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
  (site.repos || []).forEach(r => out.push({ t: r.name, k: "code", u: `code.html#p-${slug(r.name)}`, d: [r.description, r.language].join(" ") }));
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
/* Clean addresses: "shelf.html#x" -> "shelf#x", "writing/index.html" -> "writing/".
   Hosts like Cloudflare serve pages without ".html", so this saves a redirect on every click. */
function cleanUrl(u) {
  if (/^(https?:|mailto:|#|data:)/.test(u)) return u;
  return u.replace(/^((?:\.\.\/|\/)*)(.*?)(index)?\.html(?=$|#|\?)/, (_, up, p, idx) => up + p + (idx && !p && !up ? "./" : ""));
}
function cleanUrls(html) {
  return html.replace(/(\s(?:href|data-(?:prev|next|prevpost|nextpost)))="([^"]*)"/g, (_, attr, u) => `${attr}="${cleanUrl(u)}"`);
}

// Arabic words in the page get lang="ar", so they're set in Rubik with its own spaces (the monospace space is far too wide between Arabic words)
function markArabic(html) {
  if (!hasArabic(html)) return html;
  let skip = 0; // inside <title>, <script>, <style>, <textarea>, <svg>, <option>: leave the text alone
  return html.replace(/(<\/?([a-zA-Z][\w-]*)[^>]*>)|([^<]+)/g, (m, tag, name, text) => {
    if (tag) { if (/^(title|script|style|textarea|svg|option)$/i.test(name)) if (!tag.endsWith("/>")) skip += tag[1] === "/" ? -1 : 1; return m; }
    return !skip && hasArabic(text) ? text.replace(/^(\s*)([\s\S]*?)(\s*)$/, '$1<span lang="ar" dir="auto">$2</span>$3') : m;
  });
}
function write(rel, content) {
  if (/\.html$/.test(rel) && !rel.startsWith("admin/") && rel !== "rank.html") content = markArabic(content);
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const SITE_JSON = path.join(ROOT, "content/site.json");
function loadSite(draft) {
  let site;
  if (draft) site = JSON.parse(JSON.stringify(draft)); // unsaved content from the editor (local preview)
  else if (fs.existsSync(SITE_JSON)) site = JSON.parse(fs.readFileSync(SITE_JSON, "utf8"));
  else {
    const p = require.resolve("./content/site.js"); // older format still works
    delete require.cache[p];
    site = require(p);
  }
  try { site.repos = JSON.parse(fs.readFileSync(REPOS_JSON, "utf8")).repos || []; } catch (_) { site.repos = []; }
  const lbRead = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return {}; } };
  const wl = lbRead(WATCHLIST_JSON), meta = lbRead(FILM_META_JSON), mf = meta.films || {}, mt = meta.titles || {};
  site.watchlist = (wl.films || []).map(f => ({ ...f, lbRating: (mf[f.slug] || {}).rating }));
  site.favourites = topFour(site, mt).map(f => {
    // a poster you chose for the Top 4, else the one you chose for that movie, else Letterboxd's
    const mv = (site.movies || []).find(m => filmKey(m.title, m.year) === filmKey(f.title, f.year)) || {};
    const own = localFile(f.poster) ? f.poster : localFile(mv.poster) ? mv.poster : "";
    const lb = `assets/posters/${f.slug}.jpg`;
    return { ...f, lbRating: (mf[f.slug] || {}).rating, own: !!own, poster: own || (fs.existsSync(path.join(ROOT, lb)) ? lb : "") };
  });
  site.meta = {}; // film title|year -> Letterboxd details (countries, genres, cast…), for the stats
  for (const m of site.movies || []) { const slug = mt[`${String(m.title).toLowerCase()}|${m.year || ""}`]; if (slug && mf[slug]) site.meta[m.title + "|" + (m.year || "")] = { ...mf[slug], slug }; }
  return site;
}

/* Pull your public GitHub repos (not forks) into content/repos.json before building.
   If GitHub can't be reached, the last saved copy is used, so the build never fails because of it. */
const REPOS_JSON = path.join(ROOT, "content/repos.json");
/* Letterboxd, read from your public pages before each build:
   - content/watchlist.json   your watchlist (your top 4 is the "top4" list in content/site.json)
   - content/film-meta.json   per film: countries, Letterboxd average rating, poster (a cache, so
                              only new films are fetched and old ratings refreshed a few at a time)
   If Letterboxd can't be reached, the saved copies are used, so the build never fails because of it. */
const WATCHLIST_JSON = path.join(ROOT, "content/watchlist.json");
const FILM_META_JSON = path.join(ROOT, "content/film-meta.json");
const LB = "https://letterboxd.com";
const LB_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "text/html" };
const unent = s => String(s).replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const nameYear = n => { const m = unent(n).match(/^(.*) \((\d{4})\)$/); return m ? { title: m[1], year: +m[2] } : { title: unent(n) }; };
const lbItems = html => [...html.matchAll(/data-item-name="([^"]+)"[^>]*?data-item-slug="([^"]+)"/g)].map(([, n, slug]) => ({ ...nameYear(n), slug }));
const lbSlug = t => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const filmKey = (title, year) => `${String(title).toLowerCase()}|${year || ""}`;
// posters and covers live in assets/posters/<film|game|book>/<title>-<year>.jpg (the editor uses the same names)
// a title with non-Latin letters (e.g. Arabic) keeps them, so it still gets a name of its own (same rule in admin.html)
const coverSlug = t => !/[^\p{sc=Latin}\P{L}]/u.test(t) && slug(t) || String(t).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
const coverPath = (kind, it) => `assets/posters/${kind}/${[coverSlug(it.title), it.year].filter(Boolean).join("-")}.jpg`;
// the .webp copy of a picture when there is one (tools/webp.py makes them), else the picture itself
const webp = p => { if (!p || !/[.](jpe?g|png)$/i.test(p)) return p; const w = p.replace(/[.][a-z]+$/i, ".webp"); return localFile(w) ? w : p; };
// a film frame's small copy (assets/frames-sm, made by the editor), for grids; the full frame is for the viewer
const smallFrame = p => { const s = String(p || "").replace(/^assets\/frames\//, "assets/frames-sm/").replace(/\.\w+$/, ".jpg"); return s !== p && localFile(s) ? s : p; };
const localFile = p => p && !/^(https?:)?\/\//i.test(p) && fs.existsSync(path.join(ROOT, p)); // a file in this repo
// your top 4 from content/site.json; films picked in the editor have no Letterboxd slug yet, so find it
const topFour = (site, titles = {}) => (site.top4 || []).filter(f => f && (f.slug || f.title)).slice(0, 4)
  .map(f => ({ ...f, slug: f.slug || titles[filmKey(f.title, f.year)] || lbSlug(f.title) }));

async function lbGet(url) {
  const res = await fetch(url, { headers: LB_HEADERS, redirect: "follow", signal: AbortSignal.timeout(12000) });
  return res.ok ? { url: res.url, html: await res.text() } : { status: res.status };
}

/* one film page -> slug, year, countries, average rating, poster url */
function parseFilm(url, html) {
  const og = (html.match(/og:title" content="([^"]*)"/) || [])[1] || "";
  const avg = parseFloat((html.match(/twitter:data2" content="([\d.]+) out of 5"/) || [])[1]);
  return {
    slug: (url.match(/\/film\/([^/]+)\//) || [])[1],
    year: nameYear(og).year,
    countries: [...new Set([...html.matchAll(/<a href="\/films\/country\/[^"]+"[^>]*>\s*([^<]+?)\s*<\/a>/g)].map(m => unent(m[1])))],
    rating: Number.isFinite(avg) ? avg : undefined,
    poster: ((html.match(/"image":"(https:\/\/a\.ltrbxd\.com\/resized\/[^"]+)"/) || [])[1] || "").replace(/\\\//g, "/") || undefined,
    // for the stats page (FILM_META_V marks entries that have these)
    runtime: +(((html.match(/([\d,]+)&nbsp;mins/) || [])[1] || "").replace(/,/g, "")) || undefined,
    genres: links(html, "films/genre"),
    themes: links(html, "films/(?:theme|mini-theme)"),
    language: (links(html.slice(html.indexOf("Primary Language")), "films/language")[0]) || links(html, "films/language")[0],
    cast: [...new Set([...html.matchAll(/href="\/actor\/[^"]+"[^>]*>([^<]+)</g)].map(m => unent(m[1]).trim()))].slice(0, 10),
    studios: links(html, "studio"),
    v: FILM_META_V,
  };
}
const FILM_META_V = 2;
const links = (html, kind) => [...new Set([...html.matchAll(new RegExp(`<a href="/${kind}/[^"]+"[^>]*>\\s*([^<]+?)\\s*</a>`, "g"))].map(m => unent(m[1])))];

async function refreshLetterboxd() {
  let site;
  try { site = loadSite(); } catch (_) { return; }
  const user = site.letterboxd;
  if (!user || typeof fetch !== "function") return;
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
  const save = (f, data) => { const next = JSON.stringify(data, null, 2) + "\n"; if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== next) fs.writeFileSync(f, next); };
  const saved = read(WATCHLIST_JSON, {});
  let films = saved.films || [];
  const favourites = topFour(site, read(FILM_META_JSON, {}).titles);

  // watchlist pages + favourites from the profile
  try {
    const list = [];
    for (let page = 1; page <= 40; page++) {
      const r = await lbGet(`${LB}/${encodeURIComponent(user)}/watchlist/${page > 1 ? `page/${page}/` : ""}`);
      if (!r.html) throw new Error("Letterboxd answered " + r.status);
      const found = lbItems(r.html);
      list.push(...found);
      if (!found.length || !r.html.includes(`/watchlist/page/${page + 1}/`)) break;
    }
    if (list.length) films = list;
    save(WATCHLIST_JSON, { user, films });
    console.log(`letterboxd: ${films.length} on watchlist`);
  } catch (e) {
    console.warn(`letterboxd: using saved watchlist (${e.message})`);
  }

  // film details: diary films (for countries), watchlist + favourites (for ratings / posters)
  const meta = read(FILM_META_JSON, { films: {}, titles: {} });
  meta.films = meta.films || {}; meta.titles = meta.titles || {};
  const DAY = 864e5, now = Date.now();
  const age = m => now - new Date(m.fetched || 0);
  const jobs = [];
  for (const m of site.movies || []) {
    const key = filmKey(m.title, m.year), slug = meta.titles[key];
    const known = slug && meta.films[slug];
    if (slug === null && age({ fetched: meta.missing && meta.missing[key] }) < 30 * DAY) continue; // not found recently
    if (!known || known.v !== FILM_META_V) jobs.push(known ? { key, slug } : { key, title: m.title, year: m.year, tmdb: m.tmdb });
  }
  for (const f of films.concat(favourites)) {
    const known = meta.films[f.slug];
    if (!known) jobs.push({ slug: f.slug });
  }
  // refresh the oldest ratings, a few per build
  const stale = Object.entries(meta.films).filter(([, m]) => age(m) > 14 * DAY).sort((a, b) => age(b[1]) - age(a[1])).slice(0, 25).map(([slug]) => ({ slug, refresh: true }));
  const queue = jobs.concat(stale.filter(s => !jobs.some(j => j.slug === s.slug)));
  if (queue.length) await fetchFilms(queue, meta);
  save(FILM_META_JSON, meta);

  // favourite posters are kept in assets/posters so the page never loads images from Letterboxd
  for (const f of favourites) {
    const m = meta.films[f.slug], file = path.join(ROOT, "assets/posters", `${f.slug}.jpg`);
    if (!m || !m.poster || fs.existsSync(file)) continue;
    try {
      const res = await fetch(m.poster, { headers: LB_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (_) {}
  }

  // a poster for every movie on the shelf and the watchlist, named after the film so the editor can find them
  const smallJobs = (site.movies || []).map(mv => [mv, meta.films[meta.titles[filmKey(mv.title, mv.year)]]])
    .concat(films.map(f => [f, meta.films[f.slug]]))
    .map(([it, m]) => {
      const file = path.join(ROOT, coverPath("film", it));
      return m && m.poster && !fs.existsSync(file) ? { url: m.poster.replace(/-0-\d+-0-\d+-crop/, "-0-460-0-690-crop"), file } : null;
    }).filter(Boolean);
  let got = 0;
  const grab = async () => {
    for (let j; (j = smallJobs.shift());) {
      try {
        const res = await fetch(j.url, { headers: LB_HEADERS, signal: AbortSignal.timeout(12000) });
        if (!res.ok) continue;
        fs.mkdirSync(path.dirname(j.file), { recursive: true });
        fs.writeFileSync(j.file, Buffer.from(await res.arrayBuffer())); got++;
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, grab));
  if (got) console.log(`letterboxd: ${got} new posters`);
}

async function fetchFilms(queue, meta) {
  let done = 0, failed = 0;
  const resolve = async j => {
    if (j.slug) { const r = await lbGet(`${LB}/film/${j.slug}/`); return r.html ? parseFilm(r.url, r.html) : null; }
    if (j.tmdb) { const r = await lbGet(`${LB}/tmdb/${j.tmdb}/`); if (r.html) return parseFilm(r.url, r.html); }
    const base = lbSlug(j.title);
    for (const s of [base, j.year && `${base}-${j.year}`].filter(Boolean)) {
      const r = await lbGet(`${LB}/film/${s}/`);
      if (!r.html) continue;
      const f = parseFilm(r.url, r.html);
      if (!j.year || !f.year || Math.abs(f.year - j.year) <= 1) return f;
    }
    return null;
  };
  const worker = async () => {
    for (let j; (j = queue.shift());) {
      try {
        const f = await resolve(j);
        if (f && f.slug) {
          meta.films[f.slug] = { ...meta.films[f.slug], ...Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== "slug" && v !== undefined)), fetched: new Date().toISOString().slice(0, 10) };
          if (j.key) meta.titles[j.key] = f.slug;
          done++;
        } else if (j.key) {
          meta.titles[j.key] = null;
          (meta.missing = meta.missing || {})[j.key] = new Date().toISOString().slice(0, 10);
          failed++;
        }
      } catch (_) { failed++; }
      await new Promise(r => setTimeout(r, 150)); // be gentle
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`letterboxd: film details ${done} updated${failed ? `, ${failed} not found` : ""}`);
}

async function refreshRepos() {
  let user;
  try { user = loadSite().github; } catch (_) {}
  if (!user || typeof fetch !== "function") return;
  try {
    const headers = { "User-Agent": "static-site-build", Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("GitHub answered " + res.status);
    const repos = (await res.json())
      .filter(r => !r.fork && !r.private && !r.archived)
      .sort((a, b) => (a.pushed_at < b.pushed_at ? 1 : -1))
      .map(r => ({ name: r.name, description: r.description || "", language: r.language || "", stars: r.stargazers_count || 0, pushed: r.pushed_at, url: r.html_url, homepage: r.homepage || "" }));
    const next = JSON.stringify({ user, repos }, null, 2) + "\n";
    if (!fs.existsSync(REPOS_JSON) || fs.readFileSync(REPOS_JSON, "utf8") !== next) fs.writeFileSync(REPOS_JSON, next);
    console.log(`repos: ${repos.length} from github.com/${user}`);
  } catch (e) {
    console.warn(`repos: using saved copy (${e.message})`);
  }
}

function build(draft) {
  const t0 = Date.now();
  sizeCache.clear();
  const site = loadSite(draft);
  { // a project ticked "Hide from the site" in the editor hides itself and the GitHub repo with the same name
    const hidden = new Set((site.projects || []).filter(p => p.hidden).map(p => String(p.name).toLowerCase()));
    site.projects = (site.projects || []).filter(p => !p.hidden);
    site.repos = (site.repos || []).filter(r => !hidden.has(r.name.toLowerCase()));
  }
  const cssText = minifyCSS(fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8"));
  const css = `styles.${require("crypto").createHash("sha1").update(cssText).digest("hex").slice(0, 10)}.css`;

  const postDir = path.join(ROOT, "content/posts");
  const posts = (fs.existsSync(postDir) ? fs.readdirSync(postDir) : [])
    .filter(f => f.endsWith(".md"))
    .map(f => readPost(path.join(postDir, f)))
    .filter(p => !p.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const page = (rel, o) => write(rel, cleanUrls(layout({ site, css, ...o })));
  const desc = site.description;

  page("index.html", { title: site.name, description: desc, root: "", active: "hey", bodyClass: "is-home", body: homePage(site, posts) });
  page("code.html", { title: `Code — ${site.name}`, description: desc, root: "", active: "code", body: codePage(site) });
  page("design.html", { title: `Design — ${site.name}`, description: desc, root: "", active: "design", body: designPage(site), viewer: true });
  page("shelf.html", { title: `Shelf — ${site.name}`, description: desc, root: "", active: "shelf", body: shelfPage(site), viewer: true });
  for (const [id, html] of Object.entries(shelfPage.parts || {})) write(`parts/shelf-${id}.html`, cleanUrls(html));
  write("parts/films.json", JSON.stringify(filmCards(site)));
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
    body: `<main class="home" id="main"><section class="status"><h1 class="sr-only">Page not found</h1><p class="s-lead">${words("This page is:")}</p><p class="s-big">${words("NOT HERE")}</p><p class="s-tail">${words("or anywhere, really")}</p><a class="s-note" href="/index.html">Go back home →</a></section></main>`,
  });

  write("search.json", JSON.stringify(searchIndex(site, posts).map(it => ({ ...it, u: cleanUrl(it.u) }))));
  write(css, cssText);
  write("app.js", minifyJS(fs.readFileSync(path.join(ROOT, "src/app.js"), "utf8")));
  // the editor on the live site: works only with your GitHub token (see README → Edit from anywhere)
  const adminHtml = fs.readFileSync(path.join(ROOT, "src/admin.html"), "utf8");
  // stop the build (so a broken editor is never published) if its script has a syntax error
  try { new Function(adminHtml.match(/<script>([\s\S]*?)<\/script>/)[1]); }
  catch (e) { throw new Error("src/admin.html has a script error: " + e.message); }
  write("admin/index.html", adminHtml);
  { // a page of its own, not linked from the site: pick the better of two films, then compare with your ratings (/rank)
    const rankHtml = fs.readFileSync(path.join(ROOT, "src/rank.html"), "utf8");
    try { new Function(rankHtml.match(/<script>([\s\S]*?)<\/script>/)[1]); }
    catch (e) { throw new Error("src/rank.html has a script error: " + e.message); }
    write("rank.html", rankHtml);
  }
  { // for the editor's Photos page: who Stats shows, and the picture found for each (your own choices are in site.json)
    const w = statsPanel.wanted || { person: new Set(), studio: new Set(), role: {} }, pics = readPics();
    const entry = kind => name => { const e = (pics[kind] || {})[name] || {}; return { name, role: w.role[name], found: e.img && localFile(e.img) ? e.img : "", file: e.file || "" }; };
    write("admin/people.json", JSON.stringify({ person: [...w.person].map(entry("person")), studio: [...w.studio].map(entry("studio")) }));
    // for the editor's warnings: shelf items whose picture the build couldn't find
    const noCover = (kind, list) => (list || []).filter(it => it.title && !(/^https?:/i.test(it.poster || "") || localFile(it.poster) || localFile(coverPath(kind, it)))).map(it => it.title + "|" + (it.year || ""));
    write("admin/status.json", JSON.stringify({
      cover: { movies: noCover("film", site.movies), books: noCover("book", site.books), games: noCover("game", site.games) },
      photo: [...w.person].filter(n => { const own = (site.photos || {})[n], e = (pics.person || {})[n] || {}; return !localFile(own) && !(e.img && localFile(e.img)); }),
      logo: [...w.studio].filter(n => { const own = (site.logos || {})[n], e = (pics.studio || {})[n] || {}; return !localFile(own) && !(e.img && localFile(e.img)); }),
    }));
  }
  // a Cloudflare build of any branch but main (e.g. the editor's preview) is hidden from search engines
  const draftCopy = !!process.env.CF_PAGES_BRANCH && process.env.CF_PAGES_BRANCH !== "main";
  write("robots.txt", draftCopy ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nDisallow: /admin/\nDisallow: /parts/\nDisallow: /rank\n");
  // host settings (Netlify + Cloudflare Pages both read this file)
  write("_headers", [
    "/admin/*", "  X-Robots-Tag: noindex, nofollow", "  Cache-Control: no-store", "  Referrer-Policy: no-referrer", "  X-Frame-Options: DENY", "",
    "/assets/*", "  Cache-Control: public, max-age=604800", "",
    "/assets/fonts/*", "  Cache-Control: public, max-age=31536000, immutable", "",
    "/styles.*", "  Cache-Control: public, max-age=31536000, immutable", "",
    "/parts/*", "  X-Robots-Tag: noindex", "",
    "/rank", "  X-Robots-Tag: noindex, nofollow", "", "/rank.html", "  X-Robots-Tag: noindex, nofollow", "",
    "/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", ...(draftCopy ? ["  X-Robots-Tag: noindex, nofollow"] : []), "",
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
  const FOLDERS = ["frames", "frames-sm", "people", "studios", "code", "designs", "posts", "me", "posters"];
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
    if (p === "/api/site" && m === "GET") { const s = loadSite(); delete s.repos; delete s.watchlist; delete s.favourites; delete s.meta; return send(res, 200, s); } // repos live in their own file
    if (p === "/api/site" && m === "PUT") {
      const data = await readJSON(req);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.name) return send(res, 400, { error: "invalid content" });
      backupSite();
      fs.writeFileSync(SITE_JSON, JSON.stringify(data, null, 2) + "\n");
      const err = rebuild();
      return send(res, err ? 500 : 200, err ? { error: err } : { ok: true });
    }
    // preview: rebuild the local site from unsaved content (site.json is not touched); DELETE goes back to the saved content
    if (p === "/api/preview" && m === "PUT") {
      const data = await readJSON(req);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.name) return send(res, 400, { error: "invalid content" });
      try { build(data); return send(res, 200, { ok: true }); } catch (e) { rebuild(); return send(res, 500, { error: e.message }); }
    }
    if (p === "/api/preview" && m === "DELETE") { const err = rebuild(); return send(res, err ? 500 : 200, err ? { error: err } : { ok: true }); }
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
    if (p === "/api/letterboxd" && m === "GET") { // same code as the live Cloudflare function
      const mod = await import(require("url").pathToFileURL(path.join(ROOT, "functions/api/letterboxd.js")).href);
      const r = await mod.onRequestGet();
      return send(res, r.status, await r.text());
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
    else if (!path.extname(p)) p += ".html"; // clean addresses: /shelf -> shelf.html
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

/* Covers for games and books, found before each build and kept in assets/posters/<game|book>/.
   Games: Steam's portrait art, else the Microsoft Store poster, else the box art on Wikipedia, else Steam's wide header.
   Books: Open Library. Anything nothing was found for is retried after 30 days (content/covers.json).
   A cover you choose in the editor (the item's "poster") always wins. */
const COVERS_JSON = path.join(ROOT, "content/covers.json");
const COVER_UA = { "User-Agent": "static-site-builder/1.0" };
const coverNorm = s => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
async function getJSON(u) { const r = await fetch(u, { headers: COVER_UA, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function getImage(u) { const r = await fetch(u, { headers: COVER_UA, signal: AbortSignal.timeout(15000) }); return r.ok && /^image\//.test(r.headers.get("content-type") || "") ? Buffer.from(await r.arrayBuffer()) : null; }
async function gameCover(g) {
  let id = g.steam || null; // saved by the editor's game search
  if (!id) try {
    const r = await getJSON(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(g.title)}&cc=us&l=en`);
    const hit = (r.items || []).find(i => coverNorm(i.name) === coverNorm(g.title));
    if (hit) id = hit.id;
  } catch (_) {}
  if (id) for (const f of ["library_600x900_2x.jpg", "library_600x900.jpg"]) { const b = await getImage(`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/${f}`).catch(() => null); if (b) return b; }
  try { // Microsoft Store posters (Minecraft, Xbox and PC games)
    const MS = "https://displaycatalog.mp.microsoft.com/v7.0";
    const r = await getJSON(`${MS}/productFamilies/autosuggest?market=US&languages=en-US&productFamilyNames=Games&query=${encodeURIComponent(g.title)}`);
    const base = t => coverNorm(String(t).split(/:| - /)[0].replace(/\b(for (windows( 10)?|pc|xbox.*)|(deluxe|standard|ultimate|gold|complete) edition)\b/gi, ""));
    const hit = (r.Results || []).flatMap(f => f.Products || []).find(p => base(p.Title) === coverNorm(g.title));
    if (hit) {
      const d = await getJSON(`${MS}/products?bigIds=${hit.ProductId}&market=US&languages=en-US`);
      const img = ((((d.Products || [])[0] || {}).LocalizedProperties || [])[0] || {}).Images || [];
      const poster = img.find(i => i.ImagePurpose === "Poster");
      if (poster) { const b = await getImage("https:" + poster.Uri.replace(/^https?:/, "")); if (b) return b; }
    }
  } catch (_) {}
  try {
    const r = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(`${g.title} ${g.year || ""} video game`)}&prop=pageimages&piprop=original&pilicense=any`);
    const p = Object.values((r.query || {}).pages || {})[0];
    if (p && p.original && coverNorm(p.title).includes(coverNorm(g.title).split(" ").slice(0, 2).join(" "))) { const b = await getImage(p.original.source); if (b) return b; }
  } catch (_) {}
  if (id) try {
    const d = await getJSON(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`);
    const h = d[id] && d[id].data && d[id].data.header_image;
    if (h) return await getImage(h);
  } catch (_) {}
  return null;
}
async function bookCover(b) {
  try {
    if (b.olCover) { const img = await getImage(`https://covers.openlibrary.org/b/id/${b.olCover}-L.jpg`); if (img) return img; } // saved by the editor's book search
    const author = String(b.by || "").split(/&| and /)[0].trim();
    const r = await getJSON(`https://openlibrary.org/search.json?title=${encodeURIComponent(b.title)}${author ? `&author=${encodeURIComponent(author)}` : ""}&limit=5&fields=cover_i`);
    const d = (r.docs || []).find(d => d.cover_i);
    return d ? await getImage(`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`) : null;
  } catch (_) { return null; }
}
async function refreshCovers() {
  let site; try { site = loadSite(); } catch (_) { return; }
  if (typeof fetch !== "function") return;
  let misses = {}; try { misses = JSON.parse(fs.readFileSync(COVERS_JSON, "utf8")).missing || {}; } catch (_) {}
  const now = Date.now(), jobs = [];
  for (const [kind, items, find] of [["game", site.games || [], gameCover], ["book", site.books || [], bookCover]])
    for (const it of items) {
      const file = coverPath(kind, it);
      if (!it.title || localFile(it.poster) || fs.existsSync(path.join(ROOT, file))) continue;
      if (misses[file] && now - new Date(misses[file]) < 30 * 864e5) continue;
      jobs.push({ file, it, find });
    }
  let got = 0, changed = false;
  const total = jobs.length;
  const work = async () => { // two at a time: Wikipedia and Steam turn away bursts
    for (let j; (j = jobs.shift());) {
      const buf = await j.find(j.it).catch(() => null);
      if (buf) { fs.mkdirSync(path.dirname(path.join(ROOT, j.file)), { recursive: true }); fs.writeFileSync(path.join(ROOT, j.file), buf); got++; if (misses[j.file]) { delete misses[j.file]; changed = true; } }
      else { misses[j.file] = new Date().toISOString().slice(0, 10); changed = true; }
    }
  };
  await Promise.all([work(), work()]);
  if (changed) fs.writeFileSync(COVERS_JSON, JSON.stringify({ missing: misses }, null, 2) + "\n");
  if (total) console.log(`covers: ${got} of ${total} found`);
}

/* Small pictures for Stats: a country's outline, a director's or actor's photo, a studio's logo.
   Shapes come from Natural Earth (world-atlas), photos and logos from Wikidata / Wikimedia Commons.
   Only the names Stats shows are fetched, once; content/pics.json remembers what was found (and misses, retried after 30 days). */
const PICS_JSON = path.join(ROOT, "content/pics.json");
const readPics = () => { try { return JSON.parse(fs.readFileSync(PICS_JSON, "utf8")); } catch (_) { return {}; } };
const COUNTRY_ALIAS = { USA: "United States of America", UK: "United Kingdom", "State of Palestine": "Palestine", Czechia: "Czechia", "Czech Republic": "Czechia", "Republic of Ireland": "Ireland", "Bosnia and Herzegovina": "Bosnia and Herz.", "Dominican Republic": "Dominican Rep.", "Democratic Republic of Congo": "Dem. Rep. Congo", "Ivory Coast": "Côte d'Ivoire", "North Macedonia": "Macedonia" };
/* a film made in several countries counts for one: the country of its language (Korean → South Korea),
   else for English films the USA, then the UK, then the first one listed */
const LANG_HOME = { Korean: ["South Korea"], Danish: ["Denmark"], French: ["France", "Belgium", "Canada"], German: ["Germany", "Austria"], Italian: ["Italy"], Japanese: ["Japan"],
  Spanish: ["Spain", "Mexico", "Argentina"], Swedish: ["Sweden"], Norwegian: ["Norway"], Dutch: ["Netherlands", "Belgium"], Portuguese: ["Brazil", "Portugal"], Greek: ["Greece"],
  Russian: ["Russia"], Hindi: ["India"], Arabic: ["Egypt", "Tunisia", "Lebanon", "State of Palestine", "Palestine", "Saudi Arabia", "Jordan"], Persian: ["Iran"], Turkish: ["Turkey"],
  Chinese: ["China", "Hong Kong", "Taiwan"], Mandarin: ["China", "Taiwan", "Hong Kong"], Cantonese: ["Hong Kong"], Polish: ["Poland"], English: ["USA", "UK", "Ireland", "Canada", "Australia", "New Zealand"] };
function mainCountry(countries, language) {
  const list = [].concat(countries || []);
  if (list.length < 2) return list[0];
  const homes = LANG_HOME[language] || (language ? [] : ["USA", "UK"]);
  return homes.find(c => list.includes(c)) || list[0];
}

function countryShape(topo, name) {
  const g = topo.objects.countries.geometries.find(x => x.properties.name === (COUNTRY_ALIAS[name] || name));
  if (!g) return "";
  const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
  const arc = i => { let x = 0, y = 0; const pts = topo.arcs[i < 0 ? ~i : i].map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]); return i < 0 ? pts.reverse() : pts; };
  const ring = r => r.flatMap((i, k) => (k ? arc(i).slice(1) : arc(i)));
  const polys = (g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : []).map(p => ring(p[0]));
  if (!polys.length) return "";
  const box = pts => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const area = pts => { const c = Math.cos(pts[0][1] * Math.PI / 180); let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]); return Math.abs(a / 2) * c; };
  // the mainland, plus islands close to it (no Alaska, Hawaii or overseas territories)
  const sized = polys.map(p => ({ p, a: area(p), b: box(p) })).sort((a, b) => b.a - a.a);
  const L = sized[0].b, pad = Math.max(L[2] - L[0], L[3] - L[1]) * .3;
  const keep = sized.filter(s => s.a >= sized[0].a * .004 && s.b[0] >= L[0] - pad && s.b[2] <= L[2] + pad && s.b[1] >= L[1] - pad && s.b[3] <= L[3] + pad);
  const all = box(keep.flatMap(s => s.p)), k = Math.cos((all[1] + all[3]) / 2 * Math.PI / 180);
  const w = (all[2] - all[0]) * k, hgt = all[3] - all[1], f = 21 / Math.max(w, hgt);
  const ox = (24 - w * f) / 2, oy = (24 - hgt * f) / 2;
  return keep.map(({ p }) => {
    let out = "", last = null;
    for (const [lon, lat] of p) {
      const pt = [+(ox + (lon - all[0]) * k * f).toFixed(1), +(oy + (all[3] - lat) * f).toFixed(1)];
      if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < .45) continue;
      out += (last ? "L" : "M") + pt[0] + " " + pt[1]; last = pt;
    }
    return out.split("L").length > 3 ? out + "Z" : "";
  }).join("");
}
const WD = "https://www.wikidata.org/w/api.php?format=json&origin=*";
const PERSON_RE = /\b(actor|actress|director|film|screenwriter|comedian|performer|voice|singer|rapper|musician|model|producer|cinematographer|animator|writer|television|presenter|artist|dancer|stunt|youtuber|athlete|wrestler|player)/i;
const STUDIO_RE = /\b(company|compan|studio|production|distribut|film|television|entertainment|pictures|subsidiary|label|broadcast|network|division|enterprise|animation|media|cinema|channel|streaming|service)/i;
// Wikimedia asks clients to slow down with 429 + Retry-After: wait and try again
async function wikiFetch(u) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(u, { headers: COVER_UA, signal: AbortSignal.timeout(15000) });
    if (r.status !== 429 || tries >= 4) return r;
    await new Promise(ok => setTimeout(ok, (Number(r.headers.get("retry-after")) || 3) * 1000 + 300));
  }
}
const wikiJSON = async u => { const r = await wikiFetch(u); if (!r.ok) throw new Error(r.status); return r.json(); };
async function wikiPic(name, kind) {
  const r = await wikiJSON(`${WD}&action=wbsearchentities&language=en&type=item&limit=10&search=${encodeURIComponent(name)}`);
  const re = kind === "person" ? PERSON_RE : STUDIO_RE;
  const hits = (r.search || []).filter(h => coverNorm((h.match || {}).text || h.label) === coverNorm(name) && re.test(h.description || "")).slice(0, 3);
  if (!hits.length) return null;
  const d = await wikiJSON(`${WD}&action=wbgetentities&props=claims&ids=${hits.map(h => h.id).join("|")}`);
  for (const h of hits) {
    const c = ((d.entities || {})[h.id] || {}).claims || {};
    const file = (((c[kind === "person" ? "P18" : "P154"] || [])[0] || {}).mainsnak || {}).datavalue;
    if (!file || typeof file.value !== "string") continue;
    const res = await wikiFetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.value)}?width=${kind === "person" ? 96 : 120}`);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) continue;
    return { buf: Buffer.from(await res.arrayBuffer()), ext: type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg", file: file.value, id: h.id };
  }
  return null;
}
async function refreshPics() {
  let site; try { site = loadSite(); } catch (_) { return; }
  if (typeof fetch !== "function") return;
  statsPanel(site); // fills statsPanel.wanted with the names Stats shows
  const want = statsPanel.wanted || {};
  const pics = readPics(); pics.shapes = pics.shapes || {}; pics.person = pics.person || {}; pics.studio = pics.studio || {};
  let changed = false;
  const needShapes = [...(want.country || [])].filter(c => !(c in pics.shapes));
  if (needShapes.length) try {
    const topo = await getJSON("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json");
    for (const c of needShapes) { pics.shapes[c] = countryShape(topo, c); changed = true; }
  } catch (_) {}
  const now = Date.now(), jobs = [];
  const own = { person: site.photos || {}, studio: site.logos || {} };
  for (const kind of ["person", "studio"]) for (const name of want[kind] || []) {
    if (localFile(own[kind][name])) continue; // you chose one in the editor
    const e = pics[kind][name];
    if (e && (e.img ? localFile(e.img) : now - new Date(e.miss) < 30 * 864e5)) continue;
    jobs.push({ kind, name });
  }
  let got = 0; const total = jobs.length;
  const work = async () => {
    for (let j; (j = jobs.shift());) {
      const p = await wikiPic(j.name, j.kind).catch(() => null);
      if (p) {
        const img = `assets/${j.kind === "person" ? "people" : "studios"}/${slug(j.name)}.${p.ext}`;
        fs.mkdirSync(path.dirname(path.join(ROOT, img)), { recursive: true });
        fs.writeFileSync(path.join(ROOT, img), p.buf);
        pics[j.kind][j.name] = { img, file: p.file, wd: p.id }; got++;
      } else pics[j.kind][j.name] = { miss: new Date().toISOString().slice(0, 10) };
      changed = true;
    }
  };
  await work(); // one at a time: Wikimedia is strict about bursts
  if (changed) fs.writeFileSync(PICS_JSON, JSON.stringify(pics, null, 2) + "\n");
  if (total) console.log(`pictures: ${got} of ${total} found`);
}

// --offline: build from what's already here (no GitHub, Letterboxd or Wikimedia requests)
Promise.all(process.argv.includes("--offline") ? [] : [refreshRepos(), refreshLetterboxd().then(refreshPics), refreshCovers()]).then(() => {
  build();
  if (process.argv.includes("--dev")) dev();
});
