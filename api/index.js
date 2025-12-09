export const config = {
  runtime: "edge",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

// ------------------------------
// UTILITIES
// ------------------------------
async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

function last7Dates() {
  const list = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    list.push(d.toISOString().split("T")[0]);
  }
  return list;
}

function cleanHTML(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "").trim();
}

function pickStamp(ep) {
  return ep?.airstamp ||
    (ep?.airdate ? `${ep.airdate}T00:00:00Z` : "1970-01-01T00:00:00Z");
}

// BLOCK FOREIGN (CHINA / JAPAN / KOREA / TAIWAN / RUSSIA)
function blockForeign(show) {
  const lang = (show.language || "").toLowerCase();
  const c1 = show.network?.country?.code;
  const c2 = show.webChannel?.country?.code;

  const country = (c1 || c2 || "").toUpperCase();

  const blockedCountries = ["CN", "JP", "KR", "TW", "RU"];

  if (blockedCountries.includes(country)) return true;

  return false;
}

// ------------------------------
// FETCH SHOW LIST
// ------------------------------
async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  for (const date of dates) {
    const urlA = `https://api.tvmaze.com/schedule?country=US&date=${date}`;
    const urlB = `https://api.tvmaze.com/schedule/web?date=${date}`;

    const normal = await getJSON(urlA);
    const web = await getJSON(urlB);

    const all = []
      .concat(Array.isArray(normal) ? normal : [])
      .concat(Array.isArray(web) ? web : []);

    for (const ep of all) {
      const show = ep.show || ep._embedded?.show;
      if (!show?.id) continue;

      if (blockForeign(show)) continue;

      const stamp = pickStamp(ep);
      const existing = map.get(show.id);

      if (!existing || stamp > existing.airstamp) {
        map.set(show.id, {
          id: `tvmaze:${show.id}`,
          type: "series",
          name: show.name,
          description: cleanHTML(show.summary),
          poster: show.image?.medium || show.image?.original || null,
          background: show.image?.original || null,
          airstamp: stamp,
        });
      }
    }
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.airstamp) - new Date(a.airstamp)
  );
}

// ------------------------------
// FETCH META
// ------------------------------
async function fetchMeta(showId) {
  const id = showId.replace("tvmaze:", "");
  const show = await getJSON(`https://api.tvmaze.com/shows/${id}?embed=episodes`);

  if (!show?.id) {
    return {
      meta: {
        id: showId,
        type: "series",
        name: "Unknown Show",
        videos: [],
      },
    };
  }

  const episodes = (show._embedded?.episodes || []).map((ep) => ({
    id: `tvmaze:${ep.id}`,
    title: ep.name || `Episode ${ep.number}`,
    season: ep.season,
    episode: ep.number,
    released: ep.airdate || null,
    overview: cleanHTML(ep.summary),
  }));

  return {
    meta: {
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos: episodes,
    },
  };
}

// ------------------------------
// MAIN ROUTER
// ------------------------------
export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // MANIFEST
  if (path === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze Last 7 Days",
          description:
            "English-language US shows aired in the last 7 days (includes Netflix/WebChannel).",
          catalogs: [
            {
              type: "series",
              id: "tvmaze_last7",
              name: "TVMaze Last 7 Days",
              extra: [],
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

  // CATALOG
  if (path === "/catalog/series/tvmaze_last7.json") {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  // META
  if (path.startsWith("/meta/series/")) {
    const id = path.split("/")[3].replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: CORS,
    });
  }

  return new Response("Not found", { status: 404, headers: CORS });
}
