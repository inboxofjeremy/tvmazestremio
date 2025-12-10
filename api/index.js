export const config = {
  runtime: "edge",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

// -------------------- HELPERS --------------------

async function getJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function cleanHTML(str) {
  return str ? str.replace(/<[^>]+>/g, "").trim() : "";
}

// Languages to allow (English only)
function allowShow(show) {
  if (!show) return false;

  const lang = (show.language || "").toLowerCase();
  if (lang !== "english") return false;

  // Block by script (Asian + Russian/Cyrillic)
  const name = show.name || "";
  if (/[一-龯ぁ-ゟ゠-ヿ]/.test(name)) return false;      // Japanese/Chinese
  if (/[\u0E00-\u0E7F]/.test(name)) return false;        // Thai
  if (/[\u0400-\u04FF]/.test(name)) return false;        // Cyrillic Russian
  if (/[\uAC00-\uD7AF]/.test(name)) return false;        // Korean
  if (/[\u0600-\u06FF]/.test(name)) return false;        // Arabic
  if (/[\u0900-\u097F]/.test(name)) return false;        // Hindi

  return true;
}

// Pick most accurate timestamp
function pickStamp(ep) {
  return (
    ep?.airstamp ||
    (ep?.airdate ? ep.airdate + "T00:00:00Z" : "1970-01-01T00:00:00Z")
  );
}

// Get last 7 days ISO dates
function last7Dates() {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().split("T")[0]);
  }
  return out;
}

// -------------------- FETCH SHOWS --------------------

async function fetchShows() {
  const dates = last7Dates();
  const map = new Map();

  // 1. Pull from TVMaze schedule API (normal + web)
  for (const date of dates) {
    const urlA = `https://api.tvmaze.com/schedule?country=US&date=${date}&embed=show`;
    const urlB = `https://api.tvmaze.com/schedule/web?date=${date}&embed=show`;

    const normal = (await getJSON(urlA)) || [];
    const web = (await getJSON(urlB)) || [];

    for (const ep of [...normal, ...web]) {
      const show = ep?._embedded?.show;
      if (!show?.id) continue;
      if (!allowShow(show)) continue;

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

  // 2. Also check last 7 days by scanning episodes for English shows
  //    This fixes missing: NCIS, Watson, DMV, AITH etc.
  for (let page = 0; page < 7; page++) {
    const list = await getJSON(`https://api.tvmaze.com/shows?page=${page}`);
    if (!list) continue;

    for (const show of list) {
      if (!allowShow(show)) continue;

      const eps = await getJSON(
        `https://api.tvmaze.com/shows/${show.id}/episodes`
      );
      if (!eps) continue;

      for (const ep of eps) {
        if (!ep.airdate) continue;

        const stamp = ep.airdate + "T00:00:00Z";

        // Only keep if episode is in last 7 days
        if (last7Dates().includes(ep.airdate)) {
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
    }
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.airstamp) - new Date(a.airstamp)
  );
}

// -------------------- META FETCH --------------------

async function fetchMeta(showId) {
  const id = showId.replace("tvmaze:", "");
  const show = await getJSON(
    `https://api.tvmaze.com/shows/${id}?embed=episodes`
  );

  if (!show) {
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
      poster: show.image?.original || show.image?.medium,
      background: show.image?.original || null,
      videos: episodes,
    },
  };
}

// -------------------- HANDLER --------------------

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/manifest.json") {
    return new Response(
      JSON.stringify(
        {
          id: "tvmaze-last7-addon",
          version: "2.0.0",
          name: "TVMaze – English Last 7 Days",
          description: "English-language shows aired in the last 7 days.",
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

  if (path.startsWith("/catalog/series/tvmaze_last7.json")) {
    const shows = await fetchShows();
    return new Response(JSON.stringify({ metas: shows }, null, 2), {
      headers: CORS,
    });
  }

  if (path.startsWith("/meta/series/")) {
    const id = path.split("/")[3].replace(".json", "");
    const meta = await fetchMeta(id);
    return new Response(JSON.stringify(meta, null, 2), {
      headers: CORS,
    });
  }

  return new Response("Not found", { status: 404, headers: CORS });
}
