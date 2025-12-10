// api/index.js — Final Version (B1 full fallback + remove Russian + remove Asian)

import dayjs from "dayjs";

export default async function handler(req, res) {
  const today = dayjs();
  const since = today.subtract(7, "day").format("YYYY-MM-DD");

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  }

  // --- 1. GET SCHEDULE (US + WEB) ---
  const scheduleUS = await fetchJSON(
    `https://api.tvmaze.com/schedule?country=US&date=${today.format("YYYY-MM-DD")}`
  );

  const scheduleWEB = await fetchJSON(
    `https://api.tvmaze.com/schedule/web?date=${today.format("YYYY-MM-DD")}`
  );

  // merge schedule
  const schedule = [...(scheduleUS || []), ...(scheduleWEB || [])];

  // --- 2. Build dictionary of shows found in schedule ---
  const scheduleShows = {};
  schedule.forEach((ep) => {
    if (ep.show) scheduleShows[ep.show.id] = ep.show;
  });

  // --- 3. Fallback scan: Check episodes per show from schedule + extra pages ---
  // We scan extra pages of shows to catch missing ones (AITH, DMV, Watson, NCIS)
  const searchPages = [0, 1, 2, 3]; // find up to ~1000 shows quickly

  async function fetchShowsFromPage(p) {
    const url = `https://api.tvmaze.com/shows?page=${p}`;
    return await fetchJSON(url);
  }

  let allShows = [];
  for (let p of searchPages) {
    const pageShows = await fetchShowsFromPage(p);
    if (pageShows) allShows.push(...pageShows);
  }

  // --- 4. Filter all shows to US English only (B1 fallback scope) ---
  const usEnglishShows = allShows.filter((s) => {
    const lang = s.language || "";
    const country = s.network?.country?.code || s.webChannel?.country?.code || "";
    return lang === "English" && country === "US";
  });

  // --- 5. For each US show, fetch its episodes, pick last-7-days aired ---
  async function fetchRecentEpisodes(showId) {
    const url = `https://api.tvmaze.com/shows/${showId}?embed=episodes`;
    const data = await fetchJSON(url);
    if (!data || !data._embedded?.episodes) return [];

    return data._embedded.episodes.filter((ep) => {
      return ep.airdate && ep.airdate >= since && ep.airdate <= today.format("YYYY-MM-DD");
    });
  }

  const fallbackEpisodes = [];
  for (let show of usEnglishShows) {
    if (scheduleShows[show.id]) continue; // already in schedule
    const eps = await fetchRecentEpisodes(show.id);
    eps.forEach((ep) => fallbackEpisodes.push(ep));
  }

  // --- 6. Combine schedule episodes + fallback episodes ---
  const combined = [...schedule, ...fallbackEpisodes];

  // --- 7. Build final unique show list ---
  const shows = {};
  combined.forEach((ep) => {
    if (ep.show) shows[ep.show.id] = ep.show;
    else if (ep._embedded) shows[ep._embedded.show.id] = ep._embedded.show;
  });

  let list = Object.values(shows);

  // --- 8. EXCLUDE unwanted languages (Russian + Asian) ---
  const blockLanguages = [
    "Russian",
    "Korean",
    "Chinese",
    "Mandarin",
    "Cantonese",
    "Japanese",
    "Thai",
  ];

  list = list.filter((s) => {
    const lang = s.language || "";
    const country = s.network?.country?.code || s.webChannel?.country?.code || "";

    if (blockLanguages.includes(lang)) return false;
    if (country === "RU") return false;

    return true;
  });

  // --- 9. Cleanup description text ---
  list = list.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    language: s.language,
    genres: s.genres,
    runtime: s.runtime,
    premiered: s.premiered,
    officialSite: s.officialSite,
    image: s.image?.medium || s.image?.original || null,
    summary: s.summary?.replace(/<[^>]*>/g, "") || "",
  }));

  // Sort alphabetically
  list.sort((a, b) => a.name.localeCompare(b.name));

  res.status(200).json(list);
}
