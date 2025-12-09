export const config = {
  matcher: [
    "/manifest.json",
    "/catalog/series/tvmaze_last7.json",
    "/meta/series/:id.json"
  ]
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

function pickStamp(ep) {
  return ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z");
}

async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  for (const date of dates) {
    const normal = await getJSON(`https://api.tvmaze.com/schedule?country=US&date=${date}`);
    const web = await getJSON(`https://api.tvmaze.com/schedule/web?date=${date}`);

    const all = [].concat(normal || []).concat(web || []);

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
          airstamp: stamp
        });
      }
    }
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.airstamp) - new Date(a.airstamp)
  );
}

async function fetchMeta(id) {
  const real = id.replace("tvmaze:", "");
  const show = await getJSON(
    `https://api.tvmaze.com/shows/${real}?embed=episodes`
  );

  if (!show?.id) {
    return {
      meta: {
        id,
        type: "series",
        name: "Unknown Show",
        videos: []
      }
    };
  }

  const eps = (show._embedded?.episodes || []).map(ep => ({
    id: `tvmaze:${ep.id}`,
    title: ep.name || `Episode ${ep.number}`,
    season: ep.season,
    episode: ep.number,
    released: ep.airdate || null,
    overview: ep.summary || ""
  }));

  return {
    meta: {
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: show.summary || "",
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos: eps
    }
  };
}

// MAIN HANDLER (Middleware)
export default async function middleware(req) {
  const url = new URL(req.url);

  // MANIFEST
  if (url.pathname === "/manifest.json") {
    return new Response(JSON.stringify({
      id: "tvmaze-last7-addon",
      version: "1.0.0",
      name: "TVMaze – Last 7 Days",
      description: "Shows aired in the last 7 days (including web/Netflix).",
      resources: ["catalog", "meta"],
      types: ["series"],
      idPrefixes: ["tvmaze"],
      catalogs: [
        {
          type: "series",
          id: "tvmaze_last7",
          name: "TVMaze Last 7 Days",
          extra: []
        }
      ]
    }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // CATALOG
  if (url.pathname === "/catalog/series/tvmaze_last7.json") {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // META
  if (url.pathname.startsWith("/meta/series/")) {
    const id = url.pathname.replace("/meta/series/", "").replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("Not matched", { status: 404 });
}
