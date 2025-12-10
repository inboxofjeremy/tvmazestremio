// api/index.js
export const config = { runtime: "edge" };

// CORS headers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

// Basic fetch wrapper
async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

// Last 7 calendar dates
function last7Dates() {
  const list = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    list.push(d.toISOString().split("T")[0]);
  }
  return list;
}

// Strip HTML summaries
function cleanHTML(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "").trim();
}

// Choose best airstamp
function pickStamp(ep) {
  return (
    ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z")
  );
}

// 🔥 Remove Asian (CN/JP/KR/TW) + Russian + News
function blockFiltered(show) {
  const lang = (show.language || "").toLowerCase();
  const name = (show.name || "").toLowerCase();
  const genres = Array.isArray(show.genres) ? show.genres.map(g => g.toLowerCase()) : [];

  // Remove news & talk-news
  if (genres.includes("news") || genres.includes("talk")) return true;

  // Remove Russian
  if (lang.includes("russian")) return true;

  // Remove Japanese
  if (lang.includes("japanese")) return true;

  // Remove Chinese
  if (lang.includes("chinese") || name.match(/[\u4E00-\u9FFF]/)) return true;

  // Remove Korean
  if (lang.includes("korean") || name.match(/[\u3130-\u318F\uAC00-\uD7AF]/)) return true;

  return false;
}

// Fetch all shows from both endpoints
async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  for (const date of dates) {
    const urlNormal = `https://api.tvmaze.com/schedule?country=US&date=${date}&embed=show`;
    const urlWeb = `https://api.tvmaze.com/schedule/web?date=${date}&embed=show`;

    const normal = await getJSON(urlNormal);
    const web = await getJSON(urlWeb);

    const all = []
      .concat(Array.isArray(normal) ? normal : [])
      .concat(Array.isArray(web) ? web : []);

    for (const ep of all) {
      const show = ep?._embedded?.show;
      if (!show?.id) continue;

      // Skip news / CN / JP / KR / RU / TW shows
      if (blockFiltered(show)) continue;

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

async function fetchMeta(showId) {
  const id = showId.replace("tvmaze:", "");
  const url = `https://api.tvmaze.com/shows/${id}?embed=episodes`;
  const show = await getJSON(url);

  if (!show?.id) {
    return {
      meta: { id: showId, type: "series", name: "Unknown Show", videos: [] },
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

// MAIN HANDLER
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
          name: "TVMaze – Last 7 Days",
          description: "English-language US shows aired in the last 7 days.",
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
  if (path.startsWith("/catalog/series/tvmaze_last7.json")) {
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
