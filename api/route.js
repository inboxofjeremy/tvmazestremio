export const runtime = "edge";

// ---------------------------------------------------
// Helpers
// ---------------------------------------------------
async function getJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch (e) {
    return [];
  }
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

function pickStamp(ep) {
  return (
    ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z")
  );
}

// ---------------------------------------------------
// Fetch TVMaze schedule + web schedule
// ---------------------------------------------------
async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  for (const date of dates) {
    const normalURL = `https://api.tvmaze.com/schedule?country=US&date=${date}`;
    const webURL = `https://api.tvmaze.com/schedule/web?date=${date}`;

    const normal = await getJSON(normalURL);
    const web = await getJSON(webURL);

    const all = []
      .concat(Array.isArray(normal) ? normal : [])
      .concat(Array.isArray(web) ? web : []);

    for (const ep of all) {
      const show = ep?._embedded?.show;
      if (!show?.id) continue;

      const stamp = pickStamp(ep);
      const existing = map.get(show.id);

      if (!existing || stamp > existing.airstamp) {
        map.set(show.id, {
          id: `tvmaze:${show.id}`,
          type: "series",
          name: show.name,
          description: show.summary || "",
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

// ---------------------------------------------------
// Meta data (episodes)
// ---------------------------------------------------
async function fetchMeta(showId) {
  const id = showId.replace("tvmaze:", "");
  const show = await getJSON(
    `https://api.tvmaze.com/shows/${id}?embed=episodes`
  );

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
    overview: ep.summary || "",
  }));

  return {
    meta: {
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: show.summary || "",
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos: episodes,
    },
  };
}

// ---------------------------------------------------
// Route handler router
// ---------------------------------------------------
export async function GET(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // MANIFEST
  if (path === "/api/manifest.json") {
    const manifest = {
      id: "tvmaze-last7-addon",
      version: "1.0.0",
      name: "TVMaze – Last 7 Days",
      description:
        "Lists all shows aired in the last 7 days (TV + Netflix/web schedule).",
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
    };

    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // CATALOG
  if (path === "/api/catalog/series/tvmaze_last7.json") {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // META
  if (path.startsWith("/api/meta/series/")) {
    const id = path.split("/").pop().replace(".json", "");
    const meta = await fetchMeta(id);

    return new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
}
