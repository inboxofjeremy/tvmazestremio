// index.js – TVMaze Weekly Schedule Addon with TMDB fallback
// -----------------------------
// CONFIG
// -----------------------------
const TMDB_KEY = "944017b839d3c040bdd2574083e4c1bc";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TVMAZE_BASE = "https://api.tvmaze.com";

const DAYS_BACK = 10;

// -----------------------------
// HELPERS
// -----------------------------
function daysAgo(dateStr) {
    if (!dateStr) return Infinity;
    const then = new Date(dateStr);
    const now = new Date();
    return (now - then) / (1000 * 60 * 60 * 24);
}

function isRecent(dateStr) {
    return daysAgo(dateStr) <= DAYS_BACK;
}

function removeSports(show) {
    return (show.type || "").toLowerCase() !== "sports";
}

// TVMaze embedded episode recency
function tmmazeHasRecentEpisode(show) {
    if (!show._embedded || !show._embedded.episodes) return false;
    return show._embedded.episodes.some(ep => isRecent(ep.airdate));
}

// TMDB episodes recency
function tmdbHasRecentEpisode(episodes) {
    return episodes.some(ep => isRecent(ep.air_date));
}

// -----------------------------
// FETCH HELPERS
// -----------------------------
async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
}

// -----------------------------
// TMDB FALLBACK
// -----------------------------
async function searchTMDBByName(name) {
    const url = `${TMDB_BASE}/search/tv?query=${encodeURIComponent(name)}&api_key=${TMDB_KEY}`;
    const data = await fetchJSON(url);
    if (!data || !data.results || !data.results.length) return null;
    return data.results[0]; // best match
}

async function fetchTMDBShow(tmdbId) {
    return await fetchJSON(`${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_KEY}`);
}

async function fetchTMDBSeason(tmdbId, s) {
    return await fetchJSON(`${TMDB_BASE}/tv/${tmdbId}/season/${s}?api_key=${TMDB_KEY}`);
}

// Build TMDB episode list (season by season)
async function buildTMDBEpisodeList(tmdbId, seasonCount) {
    const episodes = [];
    for (let s = 1; s <= seasonCount; s++) {
        const season = await fetchTMDBSeason(tmdbId, s);
        if (!season || !season.episodes) continue;
        season.episodes.forEach(ep => {
            episodes.push({
                id: `tmdb:${tmdbId}:${s}:${ep.episode_number}`,
                title: ep.name || `Episode ${ep.episode_number}`,
                season: s,
                episode: ep.episode_number,
                released: ep.air_date || "",
                overview: ep.overview || ""
            });
        });
    }
    return episodes;
}

// -----------------------------
// TVMAZE SCHEDULE FETCH
// -----------------------------
async function fetchTVMazeSchedule() {
    const today = new Date();
    const urls = [];

    for (let i = 0; i <= DAYS_BACK; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        urls.push(`${TVMAZE_BASE}/schedule?country=US&date=${yyyy}-${mm}-${dd}`);
    }

    let shows = {};
    for (const url of urls) {
        const data = await fetchJSON(url);
        if (!data) continue;

        for (const entry of data) {
            if (!entry.show || !removeSports(entry.show)) continue;

            const showId = entry.show.id;
            if (!shows[showId]) {
                shows[showId] = entry.show;
            }
        }
    }

    return Object.values(shows);
}

// -----------------------------
// TVMAZE FULL SHOW
// -----------------------------
async function fetchTVMazeFullShow(id) {
    return await fetchJSON(`${TVMAZE_BASE}/shows/${id}?embed=episodes`);
}

// -----------------------------
// BUILD METADATA FROM TVMAZE
// -----------------------------
function buildTVMazeMeta(show) {
    return {
        id: `tvmaze:${show.id}`,
        type: "series",
        name: show.name,
        poster: show.image?.original || show.image?.medium || "",
        background: show.image?.original || "",
        description: show.summary || "",
        videos: show._embedded.episodes.map(ep => ({
            id: `tvmaze:${ep.id}`,
            title: ep.name || `Episode ${ep.number}`,
            season: ep.season,
            episode: ep.number,
            released: ep.airdate || "",
            overview: ep.summary || ""
        }))
    };
}

// -----------------------------
// BUILD METADATA FROM TMDB
// -----------------------------
async function buildTMDBMeta(tmdbId, showData) {
    const episodes = await buildTMDBEpisodeList(tmdbId, showData.number_of_seasons);

    return {
        id: `tmdb:${tmdbId}`,
        type: "series",
        name: showData.name,
        poster: `https://image.tmdb.org/t/p/original${showData.poster_path}`,
        background: `https://image.tmdb.org/t/p/original${showData.backdrop_path}`,
        description: showData.overview || "",
        videos: episodes.map(ep => ({
            id: ep.id,
            title: ep.title,
            season: ep.season,
            episode: ep.episode,
            released: ep.released,
            overview: ep.overview
        }))
    };
}

// -----------------------------
// CATALOG HANDLER
// -----------------------------
async function buildCatalog() {
    const baseShows = await fetchTVMazeSchedule();
    const results = [];

    for (const s of baseShows) {
        const full = await fetchTVMazeFullShow(s.id);

        if (full && tmmazeHasRecentEpisode(full)) {
            results.push({
                id: `tvmaze:${full.id}`,
                type: "series",
                name: full.name,
                poster: full.image?.medium || "",
            });
            continue;
        }

        // TMDB fallback
        const tmdb = await searchTMDBByName(s.name);
        if (!tmdb) continue;

        const tmdbShow = await fetchTMDBShow(tmdb.id);
        if (!tmdbShow) continue;

        const tmdbEpisodes = await buildTMDBEpisodeList(tmdb.id, tmdbShow.number_of_seasons);
        if (!tmdbHasRecentEpisode(tmdbEpisodes)) continue;

        results.push({
            id: `tmdb:${tmdb.id}`,
            type: "series",
            name: tmdbShow.name,
            poster: `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}`
        });
    }

    return results;
}

// -----------------------------
// STREMIO ADDON SERVER
// -----------------------------
const { addonBuilder } = require("stremio-addon-sdk");

const manifest = {
    id: "community.tvmaze_weekly_schedule",
    version: "1.0.0",
    name: "TVMaze Weekly Schedule (with TMDB fallback)",
    catalog: [{ type: "series", id: "tvmaze_weekly_schedule" }],
    resources: ["catalog", "meta"],
    types: ["series"],
};

const builder = new addonBuilder(manifest);

// CATALOG ROUTE
builder.defineCatalogHandler(async args => {
    if (args.id !== "tvmaze_weekly_schedule") {
        return { metas: [] };
    }
    const metas = await buildCatalog();
    return { metas };
});

// META ROUTE
builder.defineMetaHandler(async args => {
    const [prefix, rawId] = args.id.split(":");
    if (prefix === "tvmaze") {
        const full = await fetchTVMazeFullShow(rawId);
        if (!full) return { meta: {} };
        return { meta: buildTVMazeMeta(full) };
    }

    if (prefix === "tmdb") {
        const showData = await fetchTMDBShow(rawId);
        if (!showData) return { meta: {} };
        const meta = await buildTMDBMeta(rawId, showData);
        return { meta };
    }

    return { meta: {} };
});

// EXPORT
module.exports = builder.getInterface();
