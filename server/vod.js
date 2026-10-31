'use strict';

// Movies & series section.
//
// Metadata comes from two keyless public sources:
//   * IMDb's own suggestion endpoint  - titles, years, posters, cast
//   * TVmaze                          - season / episode lists for series
// Playback is handled by vidsrc.sh embeds, keyed by IMDb id.

const fs = require('fs');
const path = require('path');

const IMDB_SUGGEST = 'https://v3.sg.media-imdb.com/suggestion/x';
const TVMAZE = 'https://api.tvmaze.com';
const EMBED_BASE = 'https://vidsrc.sh/embed';

const TTL = { title: 24 * 60 * 60 * 1000, search: 30 * 60 * 1000, episodes: 6 * 60 * 60 * 1000 };
const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? hit.value : null;
}
function store(key, value, ttl) {
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getJSON(url, timeout = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/* --------------------------------------------------------------- posters --- */

// IMDb serves resized variants through the filename itself, which keeps the
// grid light instead of pulling multi-megabyte originals.
function imdbPoster(url, width = 320) {
  if (!url) return null;
  return url.replace(/\._V1_.*?\.(jpg|png)$/i, `._V1_QL75_UX${width}_.$1`);
}

/* ------------------------------------------------------------ normalize --- */

const MOVIE_KINDS = new Set(['movie', 'tvMovie', 'short', 'video', 'videoGame']);

function normalizeSuggestion(item) {
  if (!item || !item.id || !/^tt\d+$/.test(item.id)) return null;
  const qid = item.qid || '';
  if (qid === 'videoGame') return null;
  const type = MOVIE_KINDS.has(qid) ? 'movie' : (qid.startsWith('tv') ? 'tv' : null);
  if (!type) return null;
  return {
    id: item.id,
    title: item.l,
    year: item.y || null,
    yearLabel: item.tl || (item.y ? String(item.y) : ''),
    type,
    kindLabel: item.q || (type === 'tv' ? 'TV series' : 'Movie'),
    cast: item.s || '',
    poster: imdbPoster(item.i?.imageUrl, 320),
    posterLarge: imdbPoster(item.i?.imageUrl, 640),
    rank: item.rank || null,
  };
}

/* --------------------------------------------------------------- lookups --- */

async function search(query, type = 'all') {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const key = `search:${type}:${q}`;
  const hit = cached(key);
  if (hit) return hit;

  return once(key, async () => {
    const data = await getJSON(`${IMDB_SUGGEST}/${encodeURIComponent(q)}.json`);
    let results = (data.d || []).map(normalizeSuggestion).filter(Boolean);
    if (type === 'movie' || type === 'tv') results = results.filter((r) => r.type === type);
    return store(key, results, TTL.search);
  });
}

async function title(imdbId) {
  if (!/^tt\d+$/.test(imdbId)) throw new Error('bad IMDb id');
  const key = `title:${imdbId}`;
  const hit = cached(key);
  if (hit) return hit;

  return once(key, async () => {
    const data = await getJSON(`${IMDB_SUGGEST}/${imdbId}.json`);
    const match = (data.d || []).find((d) => d.id === imdbId) || (data.d || [])[0];
    const normalized = normalizeSuggestion(match);
    if (!normalized) throw new Error('title not found');
    return store(key, normalized, TTL.title);
  });
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Seasons + episodes for a series, via TVmaze's IMDb lookup. */
async function episodes(imdbId) {
  if (!/^tt\d+$/.test(imdbId)) throw new Error('bad IMDb id');
  const key = `eps:${imdbId}`;
  const hit = cached(key);
  if (hit) return hit;

  return once(key, async () => {
    let show;
    try {
      show = await getJSON(`${TVMAZE}/lookup/shows?imdb=${imdbId}`);
    } catch {
      show = null;
    }
    if (!show || !show.id) {
      return store(key, { found: false, summary: '', seasons: [] }, TTL.episodes);
    }

    const list = await getJSON(`${TVMAZE}/shows/${show.id}/episodes`, 20000);
    const seasons = new Map();
    for (const ep of list) {
      if (!ep.season || !ep.number) continue;
      if (!seasons.has(ep.season)) seasons.set(ep.season, []);
      seasons.get(ep.season).push({
        season: ep.season,
        number: ep.number,
        name: ep.name || `פרק ${ep.number}`,
        airdate: ep.airdate || null,
        runtime: ep.runtime || null,
        rating: ep.rating?.average || null,
        summary: stripHtml(ep.summary).slice(0, 400),
        image: ep.image?.medium || null,
        aired: ep.airstamp ? Date.parse(ep.airstamp) <= Date.now() : true,
      });
    }

    const payload = {
      found: true,
      summary: stripHtml(show.summary),
      genres: show.genres || [],
      status: show.status || null,
      rating: show.rating?.average || null,
      network: show.network?.name || show.webChannel?.name || null,
      seasons: [...seasons.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, eps]) => ({ season, episodes: eps.sort((a, b) => a.number - b.number) })),
    };
    return store(key, payload, TTL.episodes);
  });
}

/* ---------------------------------------------------------------- shelves --- */

const shelfConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'vod-shelves.json'), 'utf8'));

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

async function shelves() {
  const hit = cached('shelves');
  if (hit) return hit;

  return once('shelves', async () => {
    const result = await Promise.all(shelfConfig.map(async (shelf) => ({
      id: shelf.id,
      title: shelf.title,
      kind: shelf.kind,
      items: await mapLimited(shelf.ids, 5, (id) => title(id)),
    })));
    return store('shelves', result.filter((s) => s.items.length), TTL.title);
  });
}

/* ----------------------------------------------------------------- embed --- */

function embedUrl({ type, id, season, episode }) {
  if (!/^tt\d+$/.test(id)) throw new Error('bad IMDb id');
  if (type === 'tv') {
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    return `${EMBED_BASE}/tv/${id}/${s}/${e}`;
  }
  return `${EMBED_BASE}/movie/${id}`;
}

module.exports = { search, title, episodes, shelves, embedUrl, clearCache: () => cache.clear() };
