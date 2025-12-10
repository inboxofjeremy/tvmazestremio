export const config = { runtime: "edge" };

/*
  Strategy:
  - Pull TVMaze schedule (US) and schedule/web for last 7 days.
  - Pull TMDB discover/tv for same date range (limited pages).
  - For TMDB results, get external_ids -> imdb_id -> TVMaze lookup to get TVMaze show object.
  - Merge shows, dedupe, sort by latest airstamp.
  - NOW with ONLY ONE FILTER: remove News.
*/

const TMDB_API_KEY = "944017b839d3c040bdd324083e4c1bc"; // user provided v3 key
const MAX_TMDB_PAGES = 2;
const TMDB_CONCURRENCY = 5;

const TVMAZE_SHOW_LOOKUP_BY_IMDB = (imdb) =>
  `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdb)}`;

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
  } catch (e) {
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

// ONLY ONE FILTER: Remove News
function isNews(show) {
  if (!show?.genres) return false;
  return show.genres.some((g) => g.toLowerCase() === "news");
}

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
    if (!json || !Array.isArray(json.results) || json.results.length === 0) break;
    results.push(...json.results);
    if (page >= json.total_pages) break;
  }
  return results;
}

async function tmdbToTvmazeShows(tmdbList) {
  const lookup = async (item) => {
    try {
      if (!item || !item.id) return null;
      const ext = await fetchJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${TMDB_API_KEY}`
      );
      if (!ext || !ext.imdb_id) return null;
      const tm = await fetchJSON(TVMAZE_SHOW_LOOKUP_BY_IMDB(ext.imdb_id));
      if (!tm || !tm.id) return null;
      return { tvmaze: tm, tmdb: item, imdb: ext.imdb_id };
    } catch {
      return null;
    }
  };

  const mapped = await pMap(tmdbList, lookup, TMDB_CONCURRENCY);
  return mapped.filter(Boolean);
}

async function buildShows() {
  const dates = last7Dates();
  const startDate = dates[dates.length - 1];
  const endDate = dates[0];

  const scheduleEpisodes = [];
  for (const d of dates) {
    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${d}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${d}`);
    if (Array.isArray(a)) scheduleEpisodes.push(...a);
    if (Array.isArray(b)) scheduleEpisodes.push(...b);
  }

  const showMap = new Map();

  for (const ep of scheduleEpisodes) {
    const show = ep?.show || ep?._embedded?.show;
    if (!show?.id) continue;

    // ONLY FILTER: News
    if (isNews(show)) continue;

    const stamp = pickStamp(ep);
    if (!stamp) continue;

    const cur = showMap.get(show.id);
    if (!cur || stamp > cur.latestAirstamp) {
      showMap.set(show.id, { show, latestAirstamp: stamp });
    }
  }

  const tmdbList = await fetchTMDBDiscover(startDate, endDate);
  const tmdbMapped = await tmdbToTvmazeShows(tmdbList);

  for (const mapped of tmdbMapped) {
    const s = mapped.tvmaze;
    if (!s || !s.id) continue;

    if (isNews(s)) continue; // remove news

    if (showMap.has(s.id)) continue;

    const showDetail = await fetchJSON(`https://api.tvmaze.com/shows/${s.id}?embed=episodes`);
    if (!showDetail?._embedded?.episodes) continue;

    const eps = showDetail._embedded.episodes;
    const epRecent = eps.find((e) => {
      return e.airdate && e.airdate >= startDate && e.airdate <= endDate;
    });

    if (epRecent) {
      const stamp = pickStamp(epRecent);
      if (stamp) {
        showMap.set(s.id, { show: showDetail, latestAirstamp: stamp });
      }
    }
  }

  const final = [];
  for (const [id, v] of showMap.entries()) {
    const show = v.show;
    final.push({
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.medium || show.image?.original || null,
      background: show.image?.original || null,
      airstamp: v.latestAirstamp,
    });
  }

  final.sort((a, b) => new Date(b.airstamp) - new Date(a.airstamp));
  return final;
}

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
          description: "Last 7 days of shows from TVMaze + TMDB (News removed).",
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

  if (p.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await buildShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (p.startsWith("/meta/series/")) {
    const id = p.split("/").pop().replace(".json", "");
    const sid = id.replace("tvmaze:", "");
    const show = await fetchJSON(`https://api.tvmaze.com/shows/${sid}?embed=episodes`);

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
