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

// ============================
// HYBRID FUZZY MATCH SYSTEM (NEW)
// ============================
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenOverlap(a, b) {
  const A = new Set(normalize(a).split(" "));
  const B = new Set(normalize(b).split(" "));
  let shared = 0;
  A.forEach((w) => {
    if (B.has(w)) shared++;
  });
  const total = new Set([...A, ...B]).size;
  return total === 0 ? 0 : shared / total;
}

function levenshtein(a, b) {
  if (!a || !b) return 1;
  a = normalize(a);
  b = normalize(b);

  const dp = Array(b.length + 1)
    .fill(0)
    .map(() => Array(a.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) dp[0][i] = i;
  for (let j = 0; j <= b.length; j++) dp[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j][i] = Math.min(
        dp[j - 1][i] + 1,
        dp[j][i - 1] + 1,
        dp[j - 1][i - 1] + cost
      );
    }
  }
  return dp[b.length][a.length] / Math.max(a.length, b.length);
}

function hybridSimilarity(a, b) {
  const tok = tokenOverlap(a, b); // higher better
  const lev = 1 - levenshtein(a, b); // higher better
  return (tok + lev) / 2;
}

// ============================
// TMDB → TVMaze WITH FUZZY FALLBACK (NEW)
// ============================
async function fuzzySearchTVMazeByName(name) {
  const q = encodeURIComponent(name);
  const results = await fetchJSON(`https://api.tvmaze.com/search/shows?q=${q}`);
  if (!Array.isArray(results)) return null;

  let best = null;
  let bestScore = 0;

  for (const r of results) {
    const show = r.show;
    if (!show?.id) continue;
    if (isForeign(show)) continue;
    if (isNews(show)) continue;
    if (isSportsShow(show)) continue;

    const score = hybridSimilarity(name, show.name);
    if (score > bestScore && score >= 0.55) {
      best = show;
      bestScore = score;
    }
  }

  return best;
}

// TMDB mapping function
async function tmdbToTvmazeShows(list) {
  return (
    await Promise.all(
      list.map(async (item) => {
        if (!item?.id) return null;

        // 1) Try IMDB mapping
        const ext = await fetchJSON(
          `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${TMDB_API_KEY}`
        );

        if (ext?.imdb_id) {
          const tm = await fetchJSON(
            `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(
              ext.imdb_id
            )}`
          );
          if (tm?.id) return { tvmaze: tm, tmdb: item };
        }

        // 2) Fuzzy fallback (NEW)
        const fuzzy = await fuzzySearchTVMazeByName(item.name);
        if (fuzzy?.id) {
          return { tvmaze: fuzzy, tmdb: item };
        }

        return null;
      })
    )
  ).filter(Boolean);
}

// ==========================
// FILTER LAST N DAYS
// ==========================
function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));

  return episodes.filter((ep) => {
    const dateStr = pickDate(ep);
    if (!dateStr) return false;
    if (dateStr > todayStr) return false;

    const d = new Date(dateStr);
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
  // 1) TVMaze SCHEDULE (Primary Source)
  // -----------------------------------------
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const urls = [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`,
    ];

    for (const url of urls) {
      const list = await fetchJSON(url);
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
        if (!cur) {
          showMap.set(show.id, { show, episodes: [ep] });
        } else {
          cur.episodes.push(ep);
        }
      }
    }
  }

  // -----------------------------------------
  // 2) TMDB FALLBACK (Primary Lookup + Fuzzy Fallback)
  // -----------------------------------------
  const tmdbResults = [];

  // Fetch TMDB discover pages
  for (let page = 1; page <= MAX_TMDB_PAGES; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&sort_by=first_air_date.desc&language=en-US&page=${page}`;

    const json = await fetchJSON(url);
    if (!json?.results?.length) break;

    tmdbResults.push(...json.results);
    if (page >= json.total_pages) break;
  }

  const mappedTMDB = await tmdbToTvmazeShows(tmdbResults);

  for (const entry of mappedTMDB) {
    const show = entry.tvmaze;
    if (!show?.id) continue;

    if (excludedSportsIds.has(show.id)) continue;
    if (isForeign(show)) continue;
    if (isNews(show)) continue;
    if (isSportsShow(show)) continue;

    // Fetch embedded episodes for fallback
    const detail = await fetchJSON(
      `https://api.tvmaze.com/shows/${show.id}?embed=episodes`
    );
    const eps = detail?._embedded?.episodes || [];

    if (!showMap.has(show.id)) {
      showMap.set(show.id, { show: detail, episodes: eps });
    } else {
      showMap.get(show.id).episodes.push(...eps);
    }
  }

  // -----------------------------------------
  // 3) FINAL PASS — CHECK EPISODES IN LAST 10 DAYS
  // -----------------------------------------
  const output = [];

  for (const { show, episodes } of showMap.values()) {
    const recent = filterLastNDays(episodes, 10, todayStr);
    if (!recent.length) continue;

    const latestDate = recent
      .map((e) => pickDate(e))
      .filter(Boolean)
      .sort()
      .reverse()[0];

    output.push({
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      poster: show.image?.medium || show.image?.original || null,
      background: show.image?.original || null,
      description: cleanHTML(show.summary),
      latestDate,
    });
  }

  // Sort newest first
  output.sort((a, b) => b.latestDate.localeCompare(a.latestDate));

  return output;
}

// ==========================
// HTTP HANDLER
// ==========================
export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // --------------------------
  // MANIFEST
  // --------------------------
  if (path === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-weekly-schedule",
          version: "2.0.0",
          name: "Weekly Schedule (10-Day, Fuzzy TMDB Fallback)",
          description:
            "English shows aired in the last 10 days. Includes TMDB fuzzy fallback for shows missing IMDB IDs.",
          catalogs: [
            {
              type: "series",
              id: "tvmaze_weekly_schedule",
              name: "Weekly Schedule",
            },
          ],
          resources: ["catalog", "meta"],
          types: ["series"],
          idPrefixes: ["tvmaze"],
        },
        null,
        2
      ),
      { status: 200, headers: CORS }
    );
  }

  // --------------------------
  // CATALOG
  // --------------------------
  if (path === "/catalog/series/tvmaze_weekly_schedule.json") {
    const shows = await buildShows();
    return new Response(
      JSON.stringify({ metas: shows, ts: Date.now() }, null, 2),
      { status: 200, headers: CORS }
    );
  }

  // --------------------------
  // META
  // --------------------------
  if (path.startsWith("/meta/series/")) {
    const id = path.split("/").pop().replace(".json", "");
    const showId = id.replace("tvmaze:", "");

    const show = await fetchJSON(
      `https://api.tvmaze.com/shows/${showId}?embed=episodes`
    );

    if (!show) {
      return new Response(
        JSON.stringify({
          meta: { id, type: "series", name: "Unknown", videos: [] },
        }),
        { status: 200, headers: CORS }
      );
    }

    const eps = (show._embedded?.episodes || []).map((ep) => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary),
    }));

    return new Response(
      JSON.stringify(
        {
          meta: {
            id: `tvmaze:${show.id}`,
            type: "series",
            name: show.name,
            poster: show.image?.original || show.image?.medium || null,
            background: show.image?.original || null,
            description: cleanHTML(show.summary),
            videos: eps,
          },
        },
        null,
        2
      ),
      { status: 200, headers: CORS }
    );
  }

  // --------------------------
  // 404 FALLBACK
  // --------------------------
  return new Response("Not found", {
    status: 404,
    headers: CORS,
  });
}
