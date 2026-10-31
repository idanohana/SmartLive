'use strict';

// Client for an Xtream-style panel (player_api.php). One instance per
// playlist, so every signed-in user talks to their own provider line.

const { buildCatalog } = require('./catalog');

const TTL = {
  account: 5 * 60 * 1000,
  catalog: 10 * 60 * 1000,
  epg: 4 * 60 * 1000,
};

const clients = new Map(); // playlist id -> client

function clientFor(playlist) {
  const fingerprint = `${playlist.host}|${playlist.username}|${playlist.password}`;
  const existing = clients.get(playlist.id);
  if (existing && existing.fingerprint === fingerprint) return existing;
  const client = createClient(playlist, fingerprint);
  clients.set(playlist.id, client);
  return client;
}

function forget(playlistId) {
  clients.delete(playlistId);
}

function createClient(playlist, fingerprint) {
  const host = playlist.host.replace(/\/+$/, '');
  const api = `${host}/player_api.php`;
  const authQuery = `username=${encodeURIComponent(playlist.username)}&password=${encodeURIComponent(playlist.password)}`;

  const cache = new Map();
  const inflight = new Map();

  const fromCache = (key) => {
    const hit = cache.get(key);
    return hit && hit.expires > Date.now() ? hit.value : null;
  };
  const toCache = (key, value, ttl) => {
    cache.set(key, { value, expires: Date.now() + ttl });
    return value;
  };
  const once = (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const promise = fn().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };

  async function apiCall(action, params = {}, { timeout = 20000 } = {}) {
    const extra = Object.entries(params).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
    const url = `${api}?${authQuery}${action ? `&action=${action}` : ''}${extra}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`הספק החזיר ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('הספק לא החזיר תשובה תקינה');
    }
  }

  async function getAccount() {
    const hit = fromCache('account');
    if (hit) return hit;
    return once('account', async () => {
      const data = await apiCall(null);
      const u = data.user_info || {};
      const s = data.server_info || {};
      return toCache('account', {
        username: u.username || null,
        status: u.status || null,
        authorized: Number(u.auth) === 1,
        trial: u.is_trial === '1',
        expiresAt: u.exp_date ? Number(u.exp_date) * 1000 : null,
        maxConnections: Number(u.max_connections) || 1,
        activeConnections: Number(u.active_cons) || 0,
        formats: u.allowed_output_formats || [],
        server: s.url || host,
        timezone: s.timezone || null,
      }, TTL.account);
    });
  }

  async function getCatalog() {
    const hit = fromCache('catalog');
    if (hit) return hit;
    return once('catalog', async () => {
      const [categories, streams] = await Promise.all([
        apiCall('get_live_categories').catch(() => []),
        apiCall('get_live_streams', {}, { timeout: 45000 }),
      ]);
      if (!Array.isArray(streams)) throw new Error('הספק לא החזיר רשימת ערוצים');
      const catalog = buildCatalog(streams, Array.isArray(categories) ? categories : []);
      catalog.updatedAt = Date.now();
      return toCache('catalog', catalog, TTL.catalog);
    });
  }

  function decodeField(value) {
    if (!value) return '';
    try {
      const decoded = Buffer.from(String(value), 'base64').toString('utf8');
      if (decoded && !/�/.test(decoded)) return decoded.trim();
    } catch { /* fall through */ }
    return String(value).trim();
  }

  /**
   * EPG for one channel: what is on now plus the next few shows.
   * get_simple_data_table holds the full table; get_short_epg on these panels
   * starts at the *next* show, so the table is the reliable source.
   */
  async function getChannelEpg(streamId) {
    const key = `epg:${streamId}`;
    const hit = fromCache(key);
    if (hit) return hit;

    return once(key, async () => {
      let listings = [];
      try {
        const data = await apiCall('get_simple_data_table', { stream_id: streamId }, { timeout: 15000 });
        listings = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
      } catch {
        listings = [];
      }

      const shows = listings
        .map((l) => ({
          title: decodeField(l.title),
          description: decodeField(l.description),
          start: Number(l.start_timestamp) * 1000,
          end: Number(l.stop_timestamp) * 1000,
        }))
        .filter((s) => s.title && s.start && s.end && s.end > s.start)
        .sort((a, b) => a.start - b.start);

      const now = Date.now();
      const index = shows.findIndex((s) => s.start <= now && s.end > now);
      const current = index >= 0 ? shows[index] : null;
      const upcoming = (index >= 0 ? shows.slice(index + 1) : shows.filter((s) => s.start > now)).slice(0, 5);

      return toCache(key, { streamId: Number(streamId), now: current, upcoming }, TTL.epg);
    });
  }

  const streamUrl = (streamId) =>
    `${host}/${encodeURIComponent(playlist.username)}/${encodeURIComponent(playlist.password)}/${Number(streamId)}`;

  return {
    fingerprint,
    playlistId: playlist.id,
    maxStreams: playlist.maxStreams || 1,
    getAccount,
    getCatalog,
    getChannelEpg,
    streamUrl,
    clearCache: () => cache.clear(),
  };
}

module.exports = { clientFor, forget };
