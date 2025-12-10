export const config = {
  runtime: "edge",
};

// CORS headers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

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
  return (
    ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z")
  );
}

// REMOVE CHINESE / JAPANESE / KOREAN / RUSSIAN LANGUAGE SHOWS
function isNonEnglishByScriptOrLang(show) {
  const lang = (show.language || "").toLowerCase();
  const name = (show.name || "").toLowerCase();

  if (["japanese", "korean", "mandarin", "chinese", "russian"].includes(lang))
    return true;

  if (name.match(/[\u0400-\u04FF]/)) return true; // Cyrillic
  if (name.match(/[\u3040-\u30FF\u4E00-\u9FFF]/)) return true; // JP/CN/KR

  return false;
}

// REMOVE NEWS SHOWS
function isNews(show) {
  const type = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());

  if (type === "news") return true;
  if (genres.includes("news")) return true;

  return false;
}

async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  for (const date of dates) {
    const urlA = `https://api.tvmaze.com/schedule?country=US&date=${date}&embed=show`;
    const urlB = `https://api.tvmaze.com/schedule/web?date=${date}&embed=show`;

    const normal = await getJSON(urlA);
    const web = await getJSON(urlB);

    const all = []
      .concat(Array.isArray(normal) ? normal : [])
      .concat(Array.isArray(web) ? web : []);

    for (const ep of all) {
      const show = ep?._embedded?.show;
      if (!show?.id) continue;

      // EXCLUDE NON-ENGLISH & NEWS SHOWS
      if (isNonEnglishByScriptOrLang(show)) continue;
      if (isNews(show)) continue;

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

// MAIN HANDLER
export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // MANIFEST
  if (pathname === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze – Last 7 Days",
          description:
            "Lists last-7-day US English-language shows (Schedule + Web Schedule).",
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
  if (pathname.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  // META
  if (pathname.startsWith("/meta/series/")) {
    const id = pathname.split("/")[3].replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: CORS,
    });
  }

  return new Response("Not found", { status: 404, headers: CORS });
}
