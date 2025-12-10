export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const today = new Date();
  const since = new Date(today.getTime() - 7 * 86400000);

  function formatDate(d) {
    return d.toISOString().slice(0, 10);
  }

  async function fetchJSON(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // ---------- ROUTING ----------
  const { url } = req;
  if (url.endsWith("/manifest.json")) {
    return res.status(200).json({
      id: "tvmaze-last7-addon",
      version: "1.0.0",
      name: "TVMaze Last 7 Days",
      description: "English US shows aired in the last 7 days",
      catalogs: [
        { type: "series", id: "tvmaze_last7", name: "TVMaze Last 7 Days" },
      ],
      resources: ["catalog", "meta"],
      types: ["series"],
      idPrefixes: ["tvmaze"],
    });
  }

  // ---------- META (show page) ----------
  if (url.includes("/meta/series/")) {
    const id = url.split("/meta/series/")[1].replace(".json", "").replace("tvmaze:", "");

    const show = await fetchJSON(
      `https://api.tvmaze.com/shows/${id}?embed=episodes`
    );

    if (!show)
      return res.status(200).json({
        meta: { id: "tvmaze:" + id, type: "series", name: "Unknown", videos: [] },
      });

    const episodes = (show._embedded?.episodes || []).map((ep) => ({
      id: "tvmaze:" + ep.id,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: (ep.summary || "").replace(/<[^>]+>/g, ""),
    }));

    return res.status(200).json({
      meta: {
        id: "tvmaze:" + show.id,
        type: "series",
        name: show.name,
        description: (show.summary || "").replace(/<[^>]+>/g, ""),
        poster: show.image?.original || show.image?.medium || null,
        background: show.image?.original || null,
        videos: episodes,
      },
    });
  }

  // ---------- CATALOG ----------
  if (url.includes("/catalog/series/tvmaze_last7.json")) {
    // 1. Collect schedule (normal + web)
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(today.getTime() - i * 86400000);
      dates.push(formatDate(dt));
    }

    let episodes = [];
    for (const d of dates) {
      const us = await fetchJSON(
        `https://api.tvmaze.com/schedule?country=US&date=${d}&embed=show`
      );
      const web = await fetchJSON(
        `https://api.tvmaze.com/schedule/web?date=${d}&embed=show`
      );
      if (Array.isArray(us)) episodes.push(...us);
      if (Array.isArray(web)) episodes.push(...web);
    }

    // 2. Extract shows
    const map = new Map();

    function blockForeign(show) {
      if (!show) return true;
      const lang = (show.language || "").toLowerCase();
      const country = (
        show.network?.country?.code ||
        show.webChannel?.country?.code ||
        ""
      ).toUpperCase();

      const asian = ["chinese", "mandarin", "cantonese", "japanese", "korean", "thai"];

      if (lang === "russian") return true;
      if (country === "RU") return true;
      if (asian.includes(lang)) return true;

      return false;
    }

    for (const ep of episodes) {
      const show = ep._embedded?.show;
      if (!show) continue;

      if (blockForeign(show)) continue;

      const air = ep.airstamp || (ep.airdate ? ep.airdate + "T00:00:00Z" : null);
      if (!air) continue;

      const current = map.get(show.id);
      if (!current || air > current.airstamp) {
        map.set(show.id, {
          id: "tvmaze:" + show.id,
          type: "series",
          name: show.name,
          description: (show.summary || "").replace(/<[^>]+>/g, ""),
          poster: show.image?.medium || show.image?.original || null,
          background: show.image?.original || null,
          airstamp: air,
        });
      }
    }

    // 3. Fallback: catch shows NOT in schedule but aired in last 7 days
    async function fetchShowEpisodes(showId) {
      const data = await fetchJSON(
        `https://api.tvmaze.com/shows/${showId}?embed=episodes`
      );
      if (!data?.id) return [];
      return data._embedded?.episodes || [];
    }

    const extraPages = [0, 1, 2]; // up to ~700 shows
    let universe = [];

    for (const p of extraPages) {
      const pageData = await fetchJSON(`https://api.tvmaze.com/shows?page=${p}`);
      if (Array.isArray(pageData)) universe.push(...pageData);
    }

    universe = universe.filter((s) => {
      const lang = (s.language || "").toLowerCase();
      const country =
        s.network?.country?.code || s.webChannel?.country?.code || "";
      return lang === "English" && country === "US";
    });

    for (const s of universe) {
      if (map.has(s.id)) continue;

      const eps = await fetchShowEpisodes(s.id);
      const recent = eps.filter(
        (e) => e.airdate && new Date(e.airdate) >= since
      );

      if (recent.length) {
        const ep = recent[recent.length - 1];
        map.set(s.id, {
          id: "tvmaze:" + s.id,
          type: "series",
          name: s.name,
          description: (s.summary || "").replace(/<[^>]+>/g, ""),
          poster: s.image?.medium || s.image?.original || null,
          background: s.image?.original || null,
          airstamp: ep.airstamp || ep.airdate + "T00:00:00Z",
        });
      }
    }

    const final = [...map.values()].sort(
      (a, b) => new Date(b.airstamp) - new Date(a.airstamp)
    );

    return res.status(200).json({ metas: final });
  }

  // default 404
  return res.status(404).send("Not Found");
}
