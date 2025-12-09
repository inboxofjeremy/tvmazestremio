export const config = {
  runtime: "edge",
};

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

// Remove HTML tags
function cleanHTML(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, "").trim();
}

function last7Dates() {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().split("T")[0]);
  }
  return out;
}

function pickStamp(ep) {
  return (
    ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z")
  );
}

// BLOCK ***ALL*** Asian region content
function blockForeign(show) {
  const lang = (show.language || "").toLowerCase();

  // Simple language block
  if (["chinese", "japanese", "korean"].includes(lang)) return true;

  // Region block
  const country =
    show.network?.country?.code ||
    show.webChannel?.country?.code ||
    "";

  if (["CN", "JP", "KR", "TW"].includes(country)) return true;

  // Platform block
  const platform =
    (show.webChannel?.name || "").toLowerCase();

  const asianPlatforms = [
    "tencent",
    "youku",
    "iqiyi",
    "bilibili",
    "mango",
    "wetv",
  ];

  if (asianPlatforms.some(p => platform.includes(p))) return true;

  // Unicode CJK detection (catch-all)
  if (show.name.match(/[\u3040-\u30FF\u4E00-\u9FFF]/)) return true;

  return false;
}

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
      // READ SHOW PROPERLY (fixes NCIS issue)
      const show = ep.show || ep._embedded?.show;
      if (!show) continue;

      // FOREIGN BLOCK
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
    title: ep.name,
    season: ep.season,
    episode: ep.number,
    released: ep.airdate,
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

export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze – Last 7 Days",
          description:
            "Lists US/English shows aired in the last 7 days.",
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

  if (pathname.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (pathname.startsWith("/meta/series/")) {
    const id = pathname.split("/")[3].replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: CORS,
    });
  }

  return new Response("Not found", { status: 404, headers: CORS });
}
