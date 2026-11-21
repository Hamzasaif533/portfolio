// Cloudflare Pages Function: GET /api/letterboxd
// Returns your recent Letterboxd diary as JSON, for the editor's "Sync Letterboxd" button.
// Browsers aren't allowed to read Letterboxd's feed directly, so this fetches it server-side.
// It only ever fetches ONE fixed public feed (below), so it can't be used as an open proxy.
const USER = "ham7a533";

const decode = s => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

export function parseFeed(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : "";
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const year = Number(tag(block, "letterboxd:filmYear"));
    const rating = parseFloat(tag(block, "letterboxd:memberRating"));
    const tmdb = Number(tag(block, "tmdb:movieId"));
    return {
      title: tag(block, "letterboxd:filmTitle"),
      year: year || undefined,
      watched: tag(block, "letterboxd:watchedDate"),
      rating: Number.isFinite(rating) ? rating : undefined,
      liked: tag(block, "letterboxd:memberLike") === "Yes",
      rewatch: tag(block, "letterboxd:rewatch") === "Yes",
      tmdb: tmdb || undefined,
    };
  }).filter(e => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.watched)); // lists and reviews without a film are skipped
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

export async function onRequestGet() {
  try {
    const res = await fetch(`https://letterboxd.com/${USER}/rss/`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-site-sync)" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return json({ error: `Letterboxd answered ${res.status}. Try again in a minute.` }, 502);
    return json({ user: USER, entries: parseFeed(await res.text()) }, 200, { "Cache-Control": "public, max-age=300" });
  } catch (e) {
    return json({ error: "Couldn't reach Letterboxd." }, 502);
  }
}
