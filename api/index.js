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

function last7Dates() {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function cleanHTML(str) {
  return str ? str.replace(/<[^>]+>/g, "").trim() : "";
}

// pickStamp: use airdate first, fallback to airstamp
function pickStamp(ep) {
  if (ep?.airdate && ep.airdate !== "0000-00-00") return ep.airdate;
  if (ep?.airstamp) return ep.airstamp.slice(0, 10);
  return null;
}

// Treat missing language as English
function isForeign(show) {
  const lang = (show.language || "english").toLowerCase();
  const name = show.name || "";

  if (lang && lang !== "english") return true;

  if (/[\u4E00-\u9FFF\u3040-\u30FF\u31F0-\u31FF]/.test(name)) return true; // CJK
  if (/[\u0400-\u04FF]/.test(name)) return true; // Cyrillic
  if (/[\u0E00-\u0E7F]/.test(name)) return true; // Thai
  if (/[\u0600-\u06FF]/.test(name)) return true; // Arabic
  if (/[\u0900-\u097F]/.test(name)) return true; // Hindi/Devanagari
  if (/[\uAC00-\uD7AF]/.test(name)) return true; // Hangul

  return false;
}

// Only exclude actual news shows
function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news";
}

async function pMap(list, fn, concurrency) {
  const out = [];
  let i = 0;

  const workers = Array(concurrency).fill(0).map(async () => {
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
// TMDB → IMDB → TVMaze
// ==========================
async function fetchTMDBDiscover(startDate, endDate) {
  const results = [];
  for (let page = 1; page <= MAX_TMDB_PAGES; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&air_date.gte=${startDate}&air_date.lte=${endDate}` +
      `&sort_by=first_air_date.desc&language=en-US&page=${page}`;

    const json = await fetchJSON(url);
    if (!json?.results?.length) break;

    results.push(...json.results);
    if (page >= json.total_pages) break;
  }
  return results;
}

async function tmdbToTvmazeShows(list) {
  return (await pMap(
    list,
    async (item) => {
      if (!item?.id) return null;

      const ext = await fetchJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${TMDB_API_KEY}`
      );
      if (!ext?.imdb_id) return null;

      const tm = await fetchJSON(
        `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(ext.imdb_id)}`
      );
      if (!tm?.id) return null;

      return { tvmaze: tm, tmdb: item };
    },
    TMDB_CONCURRENCY
  )).filter(Boolean);
}

// ==========================
// BUILD SHOWS (MAIN FUNCTION)
// ==========================
async function buildShows() {
  const dates = last7Dates();
  const startDate = dates[dates.length - 1];
  const endDate = dates[0];

  const showMap = new Map();

  // -------- 1) TVMAZE SCHEDULES --------
  for (const d of dates) {
    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${d}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${d}`);
    const c = await fetchJSON(`https://api.tvmaze.com/schedule/full?date=${d}`);

    for (const list of [a, b, c]) {
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        if (isForeign(show)) continue;
        if (isNews(show)) continue;

        const stamp = pickStamp(ep);
        if (!stamp) continue;

        const cur = showMap.get(show.id);
        if (!cur) {
          showMap.set(show.id, { show, episodes: [stamp] });
        } else {
          cur.episodes.push(stamp);
        }
      }
    }
  }

  // -------- 2) TMDB → TVMaze fallback --------
  const tmdbList = await fetchTMDBDiscover(startDate, endDate);
  const tmdbMapped = await tmdbToTvmazeShows(tmdbList);

  for (const entry of tmdbMapped) {
    const show = entry.tvmaze;
    if (!show?.id) continue;

    if (isForeign(show)) continue;
    if (isNews(show)) continue;

    if (!showMap.has(show.id)) {
      const detail = await fetchJSON(
        `https://api.tvmaze.com/shows/${show.id}?embed=episodes`
      );
      const eps = detail?._embedded?.episodes || [];
      const stamps = eps.map(pickStamp).filter(Boolean);
      if (stamps.length > 0) {
        showMap.set(show.id, { show: detail, episodes: stamps });
      }
    }
  }

  // -------- 3) FINAL LIST WITH LAST 7 DAYS FILTER (AIRDATE PRIORITY) --------
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const startDateStr = sevenDaysAgo.toLocaleDateString('en-CA');

  const list = [...showMap.values()]
    .map((v) => {
      // Keep show if any episode is in the last 7 days
      const recentEpisodes = v.episodes.filter((d) => d >= startDateStr && d <= todayStr);
      if (recentEpisodes.length === 0) return null;

      const latest = recentEpisodes.sort().reverse()[0]; // latest episode date
      return {
        id: `tvmaze:${v.show.id}`,
        type: "series",
        name: v.show.name,
        description: cleanHTML(v.show.summary),
        poster: v.show.image?.medium || v.show.image?.original || null,
        background: v.show.image?.original || null,
        latestDate: latest,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.latestDate.localeCompare(a.latestDate));

  return list;
}

// ==========================
// HANDLER
// ==========================
export default async function handler(req) {
  const u = new URL(req.url);
  const p = u.pathname;

  if (p === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze – Last 7 Days",
          description: "English shows aired in last 7 days. No true news. Game/reality included.",
          catalogs: [
            { type: "series", id: "tvmaze_last7", name: "TVMaze Last 7 Days" },
          ],
          resources: ["catalog", "meta"],
          types: ["series"],
          idPrefixes: ["tvmaze"],
        },
        null,
        2
      ),
      { headers: CORS }
    );
  }

  if (p.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await buildShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (p.startsWith("/meta/series/")) {
    const id = p.split("/").pop().replace(".json", "");
    const showId = id.replace("tvmaze:", "");

    const show = await fetchJSON(
      `https://api.tvmaze.com/shows/${showId}?embed=episodes`
    );

    if (!show) {
      return new Response(
        JSON.stringify({ meta: { id, type: "series", name: "Unknown", videos: [] } }),
        { headers: CORS }
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
            description: cleanHTML(show.summary),
            poster: show.image?.original || show.image?.medium || null,
            background: show.image?.original || null,
            videos: eps,
          },
        },
        null,
        2
      ),
      { headers: CORS }
    );
  }

  return new Response("Not found", { status: 404, headers: CORS });
}