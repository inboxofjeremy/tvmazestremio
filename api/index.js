// api/index.js
export const config = { runtime: "edge" };

// ==========================
// CONFIG
// ==========================
const TMDB_API_KEY = "944017b839d3c040bdd324083e4c1bc";
const MAX_TMDB_PAGES = 2;
const TMDB_CONCURRENCY = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

// ==========================
// UTILS
// ==========================
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function cleanHTML(str) {
  return str ? str.replace(/<[^>]+>/g, "").trim() : "";
}

function pickDate(ep) {
  if (ep?.airdate && ep.airdate !== "0000-00-00") return ep.airdate;
  if (ep?.airstamp) return ep.airstamp.slice(0, 10);
  return null;
}

// ==========================
// FILTERS
// ==========================
function isForeign(show) {
  const lang = (show.language || "english").toLowerCase();
  const name = show.name || "";

  if (lang !== "english") return true;

  if (/[\u4E00-\u9FFF\u3040-\u30FF\u31F0-\u31FF]/.test(name)) return true;
  if (/[\u0400-\u04FF]/.test(name)) return true;
  if (/[\u0E00-\u0E7F]/.test(name)) return true;
  if (/[\u0600-\u06FF]/.test(name)) return true;
  if (/[\u0900-\u097F]/.test(name)) return true;
  if (/[\uAC00-\uD7AF]/.test(name)) return true;

  return false;
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isSportsShow(show) {
  return (show.type || "").trim().toLowerCase() === "sports";
}

function looksLikeSports(show) {
  const name = (show.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();
  const sportsKeywords = ["football", "basketball", "soccer", "nhl", "mlb", "nfl"];
  const sportsNetworks = ["espn", "nbc sports", "fox sports", "abc"];
  return (
    sportsKeywords.some((kw) => name.includes(kw)) ||
    sportsNetworks.some((n) => network.includes(n))
  );
}

// ==========================
// HYBRID FUZZY MATCH
// ==========================
function levenshtein(a, b) {
  if (!a || !b) return 9999;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokenOverlapScore(a, b) {
  const ta = new Set(a.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/));
  const tb = new Set(b.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/));

  const intersection = [...ta].filter((t) => tb.has(t));
  const union = new Set([...ta, ...tb]);

  return union.size === 0 ? 0 : intersection.length / union.size;
}

function hybridSimilarity(a, b) {
  const t = tokenOverlapScore(a, b);
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length) || 1;
  const editSim = 1 - dist / maxLen;

  return (t + editSim) / 2;
}

// ==========================
// pMap
// ==========================
async function pMap(list, fn, concurrency) {
  const out = [];
  let i = 0;

  const workers = Array(concurrency)
    .fill(0)
    .map(async () => {
      while (i < list.length) {
        const idx = i++;
        try {
          out[idx] = await fn(list[idx], idx);
        } catch {
          out[idx] = null;
        }
      }
    });

  await Promise.all(workers);
  return out;
}

// ==========================
// TMDB → TVMaze MAP
// ==========================
async function tmdbToTvmazeShow(tmItem) {
  if (!tmItem?.id) return null;

  // --- 1) TRY IMDB LOOKUP ---
  const ext = await fetchJSON(
    `https://api.themoviedb.org/3/tv/${tmItem.id}/external_ids?api_key=${TMDB_API_KEY}`
  );

  if (ext?.imdb_id) {
    const show = await fetchJSON(
      `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(ext.imdb_id)}`
    );
    if (show?.id) return show;
  }

  // --- 2) FALLBACK: TVMaze fuzzy search ---
  const search = await fetchJSON(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(tmItem.name)}`
  );
  if (!Array.isArray(search) || search.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const entry of search) {
    const s = entry.show;
    if (!s) continue;
    if (isForeign(s)) continue;
    if (isNews(s)) continue;
    if (isSportsShow(s) || looksLikeSports(s)) continue;

    const score = hybridSimilarity(tmItem.name, s.name);
    if (score >= 0.55 && score > bestScore) {
      best = s;
      bestScore = score;
    }
  }

  return best;
}

async function tmdbDiscoverFallback() {
  const list = [];
  for (let page = 1; page <= MAX_TMDB_PAGES; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&sort_by=first_air_date.desc&language=en-US&page=${page}`;
    const json = await fetchJSON(url);
    if (!json?.results?.length) break;
    list.push(...json.results);
    if (page >= json.total_pages) break;
  }

  return pMap(
    list,
    async (item) => {
      const show = await tmdbToTvmazeShow(item);
      return show ? { tvmaze: show, tmdb: item } : null;
    },
    TMDB_CONCURRENCY
  ).then((x) => x.filter(Boolean));
}

// ==========================
// FILTER LAST 10 DAYS
// ==========================
function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));

  return episodes.filter((ep) => {
    const ds = pickDate(ep);
    if (!ds) return false;
    if (ds > todayStr) return false;
    const d = new Date(ds);
    return d >= start && d <= today;
  });
}

// ==========================
// BUILD SHOWS
// ==========================
async function buildShows() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const showMap = new Map();
  const excludedSportsIds = new Set();

  // -----------------------------------------
  // 1) TVMaze Schedule Collection
  // -----------------------------------------
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${dateStr}`);
    const c = await fetchJSON(`https://api.tvmaze.com/schedule/full?date=${dateStr}`);

    for (const list of [a, b, c]) {
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        if (isSportsShow(show)) {
          excludedSportsIds.add(show.id);
          continue;
        }

        if (isForeign(show)) continue;
        if (isNews(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }
  // -----------------------------------------
  // 2) TMDB FALLBACK (HYBRID MATCH)
  // -----------------------------------------
  const tmdbFallback = await tmdbDiscoverFallback();

  for (const item of tmdbFallback) {
    const s = item?.tvmaze;
    if (!s?.id) continue;

    if (!showMap.has(s.id)) {
      showMap.set(s.id, { show: s, episodes: [] });
    }
  }

  // -----------------------------------------
  // 3) For ALL shows: Fetch embedded episodes and apply LAST-10-DAYS LOGIC
  // -----------------------------------------
  const finalMap = new Map();

  for (const [id, entry] of showMap) {
    if (excludedSportsIds.has(id)) continue;

    const show = entry.show;
    const collected = entry.episodes || [];

    const embeddedURL = `https://api.tvmaze.com/shows/${id}?embed=episodes`;
    const emb = await fetchJSON(embeddedURL);
    const embeddedEpisodes = emb?._embedded?.episodes || [];

    const recentCollected = filterLastNDays(collected, 10, todayStr);
    const recentEmbedded = filterLastNDays(embeddedEpisodes, 10, todayStr);

    const allRecent = [...recentCollected, ...recentEmbedded];
    const unique = new Map();
    for (const ep of allRecent) {
      if (ep?.id && !unique.has(ep.id)) unique.set(ep.id, ep);
    }

    if (unique.size > 0) {
      finalMap.set(id, {
        show,
        episodes: [...unique.values()],
      });
    }
  }

  // -----------------------------------------
  // 4) Convert to Stremio Catalog
  // -----------------------------------------
  const stremioCatalog = {
    metas: [...finalMap.values()].map((x) => ({
      id: String(x.show.id),
      type: "series",
      name: x.show.name,
      poster: x.show.image?.medium || x.show.image?.original || null,
      description: cleanHTML(x.show.summary),
      releaseInfo: x.show.premiered || "",
    })),
  };

  return stremioCatalog;
}

// ==========================
// HTTP HANDLER
// ==========================
export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname.endsWith("/catalog")) {
    try {
      const json = await buildShows();
      return new Response(JSON.stringify(json, null, 2), { status: 200, headers: CORS });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: true, message: "Catalog failed", detail: String(err) }),
        { status: 500, headers: CORS }
      );
    }
  }

  return new Response(
    JSON.stringify({ error: "Not found" }),
    { status: 404, headers: CORS }
  );
}
