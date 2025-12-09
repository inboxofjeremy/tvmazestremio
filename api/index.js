export const config = {
  runtime: "edge",
};

// -------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};
// -------------------------

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

// ❗ NEW: Improved blocking — removes CN / JP / KR / TW properly
function blockForeign(show) {
  const lang = (show.language || "").toLowerCase();
  const country = show.network?.country?.code || show.webChannel?.country?.code || "";

  // block by language
  if (["japanese", "russian", "mandarin", "chinese", "korean"].includes(lang))
    return true;

  // block by region code
  if (["JP", "CN", "TW", "KR", "RU"].includes(country)) return true;

  // block by characters (CJK + Cyrillic)
  const name = show.name || "";
  if (/[ء-ي]/.test(name)) return true; // Arabic
  if (/[\u0400-\u04FF]/.test(name)) return true; // Cyrillic
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(name)) return true; // CJK

  return false;
}

// ❗ NEW: fallback loader for shows with missing _embedded.show
async function loadShowBasic(id) {
  const url = `https://api.tvmaze.com/shows/${id}`;
  const data = await getJSON(url);
  return data?.id ? data : null;
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
      let show = ep?._embedded?.show;

      // ❗ Fallback if show missing (this fixes NCIS / Watson / DMV)
      if (!show && ep.show?.id) {
        show = await loadShowBasic(ep.show.id);
      }

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

// ------------------
// MAIN HANDLER
// ------------------
export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/api/manifest.json" || pathname === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "1.0.0",
          name: "TVMaze – Last 7 Days",
          description: "Lists English-language US shows aired in the last 7 days.",
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

  if (pathname.startsWith("/api/catalog/series/tvmaze_last7.json") ||
      pathname.startsWith("/catalog/series/tvmaze_last7.json")) {

    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (pathname.startsWith("/api/meta/series/") || pathname.startsWith("/meta/series/")) {
    const id = pathname.split("/").pop().replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: CORS,
    });
  }

  return new Response("Not found", { status: 404, headers: CORS });
}
