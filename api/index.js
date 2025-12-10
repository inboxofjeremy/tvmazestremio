// api/index.js
export const config = { runtime: "edge" };

// -------------------------------------------------------
// CORS
// -------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

// -------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------
const TMDB_API_KEY = "944017b839d3c040bdd324083e4c1bc";
const MAX_TMDB_PAGES = 2;
const TMDB_CONCURRENCY = 5;

// News removal (very aggressive)
const NEWS_PATTERNS = [
  "news",
  "abc news",
  "nbc news",
  "cbc news",
  "today",
  "the today show",
  "good morning america",
  "politicsnation",
  "700 club",
  "700 club interactive",
  "dateline",
  "this week",
  "meet the press",
  "gma",
  "sec now",
  "morning joe",
  "the five",
  "fox news",
  "msnbc",
  "cnn",
];

function isNewsShow(show) {
  const name = show?.name?.toLowerCase() || "";
  const genre = (show?.genres || []).map(g => g.toLowerCase());

  if (genre.includes("news")) return true;
  if (genre.includes("talk show")) return true;
  if (genre.includes("politics")) return true;

  for (const n of NEWS_PATTERNS) {
    if (name.includes(n)) return true;
  }

  return false;
}

// -------------------------------------------------------
// UTILITIES
// -------------------------------------------------------
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function cleanHTML(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "").trim();
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

function pickStamp(ep) {
  if (ep?.airstamp) return ep.airstamp;
  if (ep?.airdate) return ep.airdate + "T00:00:00Z";
  return null;
}

// -------------------------------------------------------
// REMOVE FOREIGN LANGUAGE / FOREIGN SCRIPT SHOWS
// -------------------------------------------------------
function isForeign(show) {
  const lang = (show?.language || "").toLowerCase();
  const name = show?.name || "";

  if (lang && lang !== "english") return true;

  // block CJK, Cyrillic, Thai, Arabic, Hindi
  if (/[\u4E00-\u9FFF]/.test(name)) return true;  // Chinese
  if (/[\u3040-\u30FF]/.test(name)) return true;  // Japanese
  if (/[\uAC00-\uD7AF]/.test(name)) return true;  // Korean
  if (/[\u0400-\u04FF]/.test(name)) return true;  // Cyrillic
  if (/[\u0E00-\u0E7F]/.test(name)) return true;  // Thai
  if (/[\u0600-\u06FF]/.test(name)) return true;  // Arabic
  if (/[\u0900-\u097F]/.test(name)) return true;  // Hindi

  return false;
}

// -------------------------------------------------------
// TINY CONCURRENCY MAP
// -------------------------------------------------------
async function pMap(list, mapper, concurrency = 5) {
  const out = [];
  let i = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (i < list.length) {
      const index = i++;
      try {
        out[index] = await mapper(list[index], index);
      } catch {
        out[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

// -------------------------------------------------------
// TMDB DISCOVER
// -------------------------------------------------------
async function fetchTMDBDiscover(start, end) {
  const shows = [];
  for (let page = 1; page <= MAX_TMDB_PAGES; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&air_date.gte=${start}&air_date.lte=${end}` +
      `&language=en-US&page=${page}`;
    const json = await fetchJSON(url);
    if (!json?.results?.length) break;
    shows.push(...json.results);
    if (page >= json.total_pages) break;
  }
  return shows;
}

// Convert TMDB -> TVMaze via IMDb lookup
async function tmdbToTvmaze(tmdbList) {
  return pMap(
    tmdbList,
    async (item) => {
      if (!item?.id) return null;

      const ext = await fetchJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${TMDB_API_KEY}`
      );
      if (!ext?.imdb_id) return null;

      const maze = await fetchJSON(
        `https://api.tvmaze.com/lookup/shows?imdb=${ext.imdb_id}`
      );
      if (!maze?.id) return null;

      return maze;
    },
    TMDB_CONCURRENCY
  );
}

// -------------------------------------------------------
// BUILD SHOW LIST
// -------------------------------------------------------
async function buildShows() {
  const dates = last7Dates();
  const start = dates[dates.length - 1];
  const end = dates[0];

  const episodeList = [];

  // Pull US schedule + web
  for (const d of dates) {
    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${d}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${d}`);
    if (Array.isArray(a)) episodeList.push(...a);
    if (Array.isArray(b)) episodeList.push(...b);
  }

  // Collect shows
  const map = new Map();
  for (const ep of episodeList) {
    const show = ep.show || ep._embedded?.show;
    if (!show?.id) continue;

    if (isForeign(show)) continue;
    if (isNewsShow(show)) continue;

    const stamp = pickStamp(ep);
    if (!stamp) continue;

    const existing = map.get(show.id);
    if (!existing || stamp > existing.airstamp) {
      map.set(show.id, { show, airstamp: stamp });
    }
  }

  // TMDB fallback
  const tmdbRaw = await fetchTMDBDiscover(start, end);
  const tmdbMapped = await tmdbToTvmaze(tmdbRaw);

  for (const tm of tmdbMapped) {
    if (map.has(tm.id)) continue;
    if (isForeign(tm)) continue;
    if (isNewsShow(tm)) continue;

    const detail = await fetchJSON(
      `https://api.tvmaze.com/shows/${tm.id}?embed=episodes`
    );
    if (!detail?._embedded?.episodes) continue;

    const ep = detail._embedded.episodes.find(
      (e) => e.airdate >= start && e.airdate <= end
    );
    if (!ep) continue;

    const stamp = pickStamp(ep);
    if (!stamp) continue;

    map.set(tm.id, { show: detail, airstamp: stamp });
  }

  // Build final list
  const final = [];
  for (const { show, airstamp } of map.values()) {
    final.push({
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.medium || show.image?.original || null,
      background: show.image?.original || null,
      airstamp,
    });
  }

  final.sort((a, b) => new Date(b.airstamp) - new Date(a.airstamp));

  return final;
}

// -------------------------------------------------------
// HANDLER
// -------------------------------------------------------
export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze – Last 7 Days",
          description:
            "English scripted shows aired in last 7 days (TVMaze + TMDB). Foreign + news removed.",
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
    const sid = id.replace("tvmaze:", "");
    const show = await fetchJSON(
      `https://api.tvmaze.com/shows/${sid}?embed=episodes`
    );

    if (!show) {
      return new Response(
        JSON.stringify({ meta: { id, type: "series", name: "Unknown", videos: [] } }),
        { headers: CORS }
      );
    }

    const videos = (show._embedded?.episodes || []).map((ep) => ({
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
            videos,
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