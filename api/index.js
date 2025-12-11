export const config = { runtime: "edge" };

// ==========================
// CONFIG
// ==========================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const MAX_TMDB_PAGES = 2;
const TMDB_CONCURRENCY = 5;

const ALLOWED_COUNTRIES = new Set(["US", "GB", "CA", "AU", "IE", "NZ"]);

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
const language = show.language || "English";
if (language.toLowerCase() !== "english") return true;

const name = show.name || "";

// Block Russian / Chinese / Korean / Japanese / Thai / Arabic / Hindi
if (/[\u0400-\u04FF]/.test(name)) return true; // Cyrillic
if (/[\u4E00-\u9FFF]/.test(name)) return true; // CJK
if (/[\u3040-\u30FF]/.test(name)) return true; // Japanese Kana
if (/[\uAC00-\uD7AF]/.test(name)) return true; // Korean
if (/[\u0E00-\u0E7F]/.test(name)) return true; // Thai
if (/[\u0600-\u06FF]/.test(name)) return true; // Arabic
if (/[\u0900-\u097F]/.test(name)) return true; // Hindi

return false;
}

function isAllowedCountry(show) {
const c =
show.network?.country?.code ||
show.webChannel?.country?.code ||
null;

return c && ALLOWED_COUNTRIES.has(c);
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
sportsKeywords.some((k) => name.includes(k)) ||
sportsNetworks.some((n) => network.includes(n))
);
}

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
// TMDB LOOKUP
// ==========================
async function fetchTMDBDiscoverPages(pages = MAX_TMDB_PAGES) {
  const results = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&sort_by=first_air_date.desc&language=en-US&page=${page}`;

    const json = await fetchJSON(url);
    if (!json?.results?.length) break;

    results.push(...json.results);

    if (page >= json.total_pages) break;
  }

  return results;
}

async function tmdbToTvmazeShows(list) {
  return (
    await pMap(
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

        // Fetch with episodes
        const detail = await fetchJSON(
          `https://api.tvmaze.com/shows/${tm.id}?embed=episodes`
        );

        return detail?.id ? { tvmaze: detail, tmdb: item } : null;
      },
      TMDB_CONCURRENCY
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

```
if (dateStr > todayStr) return false;

const d = new Date(dateStr);
return d >= start && d <= today;
```

});
}
async function buildShows() {
const now = new Date();
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const dd = String(now.getUTCDate()).padStart(2, "0");
const todayStr = `${yyyy}-${mm}-${dd}`;

const showMap = new Map();

// ========================================
// 1) TVMAZE SCHEDULE — PRIMARY SOURCE
// ========================================
for (let i = 0; i < 10; i++) {
const d = new Date(todayStr);
d.setDate(d.getDate() - i);

```
const y = d.getUTCFullYear();
const m = String(d.getUTCMonth() + 1).padStart(2, "0");
const day = String(d.getUTCDate()).padStart(2, "0");

const dateStr = `${y}-${m}-${day}`;

const a = await fetchJSON(
  `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
);
const b = await fetchJSON(
  `https://api.tvmaze.com/schedule/web?date=${dateStr}`
);
const c = await fetchJSON(
  `https://api.tvmaze.com/schedule/full?date=${dateStr}`
);

for (const list of [a, b, c]) {
  if (!Array.isArray(list)) continue;

  for (const ep of list) {
    const show = ep?.show || ep?._embedded?.show;
    if (!show?.id) continue;

    if (!isAllowedCountry(show)) continue;
    if (isForeign(show)) continue;
    if (isNews(show)) continue;
    if (isSportsShow(show) || looksLikeSports(show)) continue;

    const cur = showMap.get(show.id);
    if (!cur) {
      showMap.set(show.id, { show, episodes: [ep] });
    } else {
      cur.episodes.push(ep);
    }
  }
}
```

}

// ========================================
// 2) TMDB FALLBACK → TVMAZE
// ========================================
const tmdbRaw = await fetchTMDBDiscoverPages();
const tmdbMapped = await tmdbToTvmazeShows(tmdbRaw);

for (const entry of tmdbMapped) {
const show = entry.tvmaze;
if (!show?.id) continue;

```
if (!isAllowedCountry(show)) continue;
if (isForeign(show)) continue;
if (isNews(show)) continue;
if (isSportsShow(show) || looksLikeSports(show)) continue;

const eps = show._embedded?.episodes || [];
if (!eps.length) continue;

const cur = showMap.get(show.id);
if (!cur) {
  showMap.set(show.id, { show, episodes: eps });
} else {
  cur.episodes.push(...eps);
}
```

}

// ========================================
// 3) FINAL FILTER + SORT
// ========================================
const list = [...showMap.values()]
.map((v) => {
const recent = filterLastNDays(v.episodes, 10, todayStr);
if (!recent.length) return null;

```
  const latestDate = recent
    .map((e) => pickDate(e))
    .filter(Boolean)
    .sort()
    .reverse()[0];

  return {
    id: `tvmaze:${v.show.id}`,
    type: "series",
    name: v.show.name,
    description: cleanHTML(v.show.summary),
    poster: v.show.image?.medium || v.show.image?.original || null,
    background: v.show.image?.original || null,
    latestDate,
  };
})
.filter(Boolean)
.sort((a, b) => b.latestDate.localeCompare(a.latestDate));
```

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
id: "tvmaze-weekly-schedule",
version: "3.0.0",
name: "Weekly Schedule",
description:
"English shows from US/UK/CA/AU/IE/NZ aired in last 10 days. No news, talk shows, sports, or foreign-language content.",
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
{ headers: CORS }
);
}

if (p.startsWith("/catalog/series/tvmaze_weekly_schedule.json")) {
const shows = await buildShows();
return new Response(
JSON.stringify({ metas: shows, ts: Date.now() }, null, 2),
{ headers: CORS }
);
}

if (p.startsWith("/meta/series/")) {
const id = p.split("/").pop().replace(".json", "");
const showId = id.replace("tvmaze:", "");

```
const show = await fetchJSON(
  `https://api.tvmaze.com/shows/${showId}?embed=episodes`
);

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
```

}

return new Response("Not found", { status: 404, headers: CORS });
}
