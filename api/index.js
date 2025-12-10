export default async function handler(req, res) {
  try {
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dates.push(d.toISOString().split("T")[0]);
    }

    // Fetch 7-day schedule
    const scheduleUrls = dates.map(
      (d) => `https://api.tvmaze.com/schedule?country=US&date=${d}`
    );

    const scheduleData = (
      await Promise.all(scheduleUrls.map((url) => fetch(url).then((r) => r.json())))
    ).flat();

    // Extract unique show IDs
    const ids = [...new Set(scheduleData.map((e) => e.show?.id).filter(Boolean))];

    // Fetch shows
    const shows = await Promise.all(
      ids.map((id) =>
        fetch(`https://api.tvmaze.com/shows/${id}?embed=episodes`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );

    let results = shows.filter(Boolean);

    // --- LANGUAGE & REGION FILTER ---
    const blockedLanguages = ["Chinese", "Japanese", "Korean", "Thai", "Mandarin"];
    const blockedCountries = ["China", "Japan", "Korea", "Taiwan", "Thailand", "Russia"];

    results = results.filter((s) => {
      const lang = s.language || "";
      const country = s.network?.country?.name || s.webChannel?.country?.name || "";
      return (
        !blockedLanguages.includes(lang) &&
        !blockedCountries.includes(country)
      );
    });

    // --- REMOVE NEWS / POLITICS / TALK-NEWS ---
    const newsKeywords = [
      "news",
      "morning",
      "today",
      "politic",
      "now",
      "this week",
      "dateline",
      "fox",
      "nbc",
      "abc",
      "cbs",
      "msnbc",
      "cnn",
      "700 club",
      "friends"
    ];

    results = results.filter((s) => {
      const name = s.name.toLowerCase();
      return !newsKeywords.some((n) => name.includes(n));
    });

    // --- FORCE-ADD SHOWS THAT TVMAZE SOMETIMES FAILS TO RETURN ---

    // Helper to fetch a show safely
    async function fetchShow(id) {
      try {
        const r = await fetch(`https://api.tvmaze.com/shows/${id}?embed=episodes`);
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }

    const mustInclude = [
      84,    // NCIS
      87454, // Am I The A**hole?
      83625, // Watson
      73070, // DMV
      515,   // Wheel of Fortune
    ];

    const missing = [];

    for (const id of mustInclude) {
      if (!results.some((s) => s.id === id)) {
        const show = await fetchShow(id);
        if (show) missing.push(show);
      }
    }

    results = [...results, ...missing];

    // --- RETURN STREMIO CATALOG FORMAT ---
    const catalog = results.map((show) => ({
      id: show.id.toString(),
      name: show.name,
      poster: show.image?.medium || null,
      posterShape: "regular",
      description: show.summary?.replace(/<\/?[^>]+(>|$)/g, "") || "",
      type: "series",
    }));

    return res.status(200).json({ metas: catalog });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error" });
  }
}