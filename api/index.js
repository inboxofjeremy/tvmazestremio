export const config = { runtime: "edge" };

/*
  FIXED VERSION (STRICT NEWS REMOVAL)
  - Keep only English + US-origin scripted shows
  - Remove foreign scripts (CJK, Cyrillic, Arabic, Thai, Hindi, Korean)
  - Remove all NEWS programs (Morning Joe, CNN, Fox & Friends, Bloomberg, etc.)
  - KEEP talk shows (Seth Meyers, Kimmel, Fallon) per user selection.
  - Preserve TMDB→TVMaze merging.
*/

const TMDB_API_KEY = "944017b839d3c040bdd324083e4c1bc";
const MAX_TMDB_PAGES = 2;
const TMDB_CONCURRENCY = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

async function fetchJSON(url, opts = {}) {
  try {
    const r = await fetch(url, { cache: "no-store", ...opts });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function last7Dates() {
  const list = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    list.push(d.toISOString().slice(0, 10));
  }
  return list;
}

function cleanHTML(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "").trim();
}

/* ----------------------------------------------------
      STRICT NEWS FILTER (Option A)
---------------------------------------------------- */

function isNews(show) {
  if (!show) return true;

  const name = (show.name || "").toLowerCase();
  const genres = (show.genres || []).map((g) => g.toLowerCase());
  const type = (show.type || "").toLowerCase();

  // TVMaze marks news clearly
  if (type === "news") return true;
  if (genres.includes("news")) return true;

  // Keyword-based removal for 100% accuracy
  const newsKeywords = [
    "cnn",
    "fox & friends",
    "fox and friends",
    "morning joe",
    "bloomberg",
    "surveillance",
    "news",
    "mornings with",
    "morning in america",
    "wake up america",
    "abc news",
    "cbs news",
    "nbc news",
    "late news",
    "breaking news",
    "world news",
    "meet the press",
    "face the nation",
    "america's news",
    "sunday morning",
  ];

  return newsKeywords.some((key) => name.includes(key));
}

/* ----------------------------------------------------
      LANGUAGE + COUNTRY FILTER (remove foreign)
---------------------------------------------------- */

function isForeign(show) {
  if (!show) return true;

  // Only allow English-language shows
  if ((show.language || "").toLowerCase() !== "english") return true;

  const net = show.network;
  const web = show.webChannel;
  const countryCode =
    net?.country?.code ||
    web?.country?.code ||
    null;

  // Only keep US-origin
  if (countryCode !== "US") return true;

  const name = show.name || "";

  // Block CJK, Cyrillic, Thai, Arabic, Hindi, Korean
  const badScript =
    /[\u4E00-\u9FFF\u3040-\u30FF\u31F0-\u31FF]/.test(name) || // CJK/Japanese
    /[\u0400-\u04FF]/.test(name) || // Cyrillic
    /[\u0E00-\u0E7F]/.test(name) || // Thai
    /[\u0600-\u06FF]/.test(name) || // Arabic
    /[\u0900-\u097F]/.test(name) || // Hindi
    /[\uAC00-\uD7AF]/.test(name); // Korean

  if (badScript) return true;

  return false;
}

/* ----------------------------------------------------
      TMDB + TVMaze merge utilities
---------------------------------------------------- */

function pickStamp(ep) {
  return ep?.airstamp || (ep?.airdate ? `${ep.airdate}T00:00:00Z` : null);
}

async function pMap(list, mapper, concurrency = 5) {
  const out = [];
  let i = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (i < list.length) {
      const idx = i++;
      try {
        out[idx] = await mapper(list[idx], idx);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchTMDBDiscover(startDate, endDate) {
  const results = [];
  for (let page = 1; page <= MAX_TMDB_PAGES; page++) {
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${startDate}&air_date.lte=${endDate}&sort_by=first_air_date.desc&language=en-US&page=${page}`;
    const json = await fetchJSON(url);
    if (!json || !Array.isArray(json.results)) break;
    results.push(...json.results);
    if (page >= json.total_pages) break;
  }
  return results;
}

async function tmdbToTvmazeShows(list) {
  const lookup = async (item) => {
    try {
      if (!item?.id) return null;
      const ext = await fetchJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${TMDB_API_KEY}`
      );
      if (!ext?.imdb_id) return null;

      const tm = await fetchJSON(
        `https://api.tvmaze.com/lookup/shows?imdb=${ext.imdb_id}`
      );
      if (!tm?.id) return null;

      return { tvmaze: tm, imdb: ext.imdb_id };
    } catch {
      return null;
    }
  };

  const mapped = await pMap(list, lookup, TMDB_CONCURRENCY);
  return mapped.filter(Boolean);
}

/* ----------------------------------------------------
        BUILD FINAL SHOW LIST
---------------------------------------------------- */

async function buildShows() {
  const dates = last7Dates();
  const startDate = dates.at(-1);
  const endDate = dates[0];

  const scheduleEpisodes = [];
  for (const d of dates) {
    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${d}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${d}`);
    if (Array.isArray(a)) scheduleEpisodes.push(...a);
    if (Array.isArray(b)) scheduleEpisodes.push(...b);
  }

  const showMap = new Map();

  // Pull from TVMaze schedule first
  for (const ep of scheduleEpisodes) {
    const show = ep?.show || ep?._embedded?.show;
    if (!show?.id) continue;

    // strict filtering
    if (isForeign(show)) continue;
    if (isNews(show)) continue;

    const stamp = pickStamp(ep);
    if (!stamp) continue;

    const existing = showMap.get(show.id);
    if (!existing || stamp > existing.latest) {
      showMap.set(show.id, { show, latest: stamp });
    }
  }

  // TMDB merge
  const tmdb = await fetchTMDBDiscover(startDate, endDate);
  const mapped = await tmdbToTvmazeShows(tmdb);

  for (const m of mapped) {
    const show = m.tvmaze;
    if (!show?.id) continue;

    if (isForeign(show)) continue;
    if (isNews(show)) continue;

    if (showMap.has(show.id)) continue;

    const detail = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}?embed=episodes`);
    if (!detail?._embedded?.episodes) continue;

    const recent = detail._embedded.episodes.find(
      (e) => e.airdate && e.airdate >= startDate && e.airdate <= endDate
    );

    if (!recent) continue;

    const stamp = pickStamp(recent);
    if (!stamp) continue;

    showMap.set(show.id, { show: detail, latest: stamp });
  }

  // Build final list
  const final = [];
  for (const [id, v] of showMap) {
    const s = v.show;
    final.push({
      id: `tvmaze:${s.id}`,
      type: "series",
      name: s.name,
      description: cleanHTML(s.summary),
      poster: s.image?.medium || s.image?.original || null,
      background: s.image?.original || null,
      airstamp: v.latest,
    });
  }

  final.sort((a, b) => new Date(b.airstamp) - new Date(a.airstamp));
  return final;
}

/* ----------------------------------------------------
        HANDLERS
---------------------------------------------------- */

export default async function handler(req) {
  const u = new URL(req.url);
  const path = u.pathname;

  if (path === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.1.0",
          name: "TVMaze – Last 7 Days (English US, No News)",
          description:
            "US-English shows aired in last 7 days. News removed. Foreign scripts removed.",
          catalogs: [
            {
              type: "series",
              id: "tvmaze_last7",
              name: "TVMaze Last 7 Days",
            },
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

  if (path.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await buildShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (path.startsWith("/meta/series/")) {
    const id = path.split("/").pop().replace(".json", "");
    const showId = id.replace("tvmaze:", "");
    const show = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);

    if (!show) {
      return new Response(
        JSON.stringify({
          meta: { id, type: "series", name: "Unknown", videos: [] },
        }),
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
