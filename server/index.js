'use strict';

const os = require('os');
const path = require('path');
const { once } = require('events');
const express = require('express');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const accounts = require('./accounts');
const xtream = require('./xtream');
const vod = require('./vod');
const catalog = require('./catalog');

const app = express();
app.disable('x-powered-by');
// Hosted behind the provider's proxy: without this, req.secure is always false
// and the session cookie never gets its Secure flag.
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// Without its settings the app cannot do anything useful, so every route says
// which ones are missing. Far easier to act on than a blank 503.
if (config.missing.length) {
  app.use((req, res) => {
    const list = config.missing.map((name) => `<li><code>${name}</code></li>`).join('');
    res.status(503);
    if (wantsJson(req)) return res.json({ error: 'missing configuration', missing: config.missing });
    res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
<title>SmartLive - חסרות הגדרות</title>
<body style="font-family:system-ui,sans-serif;background:#0b0e16;color:#eef1f8;padding:48px;line-height:1.7">
<h1 style="margin:0 0 8px">חסרות הגדרות</h1>
<p style="color:#a8b0c4;margin:0 0 20px">השרת רץ, אבל משתני הסביבה האלה לא הוגדרו:</p>
<ul style="color:#ffd9e0;font-size:18px">${list}</ul>
<p style="color:#a8b0c4">הוסף אותם במסך האפליקציה (Environment variables) או בקובץ <code>.env</code>
בתיקיית הפרויקט, ואז לחץ <b>Restart</b>.</p>
</body></html>`);
  });
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, '..', 'views');
const view = (name) => path.join(VIEWS_DIR, name);

let schemaReady = false;

/* ----------------------------------------------------------------- auth --- */

// Static assets need no session; skip the lookup for them.
const SKIP_AUTH = /^\/(css|js|vendor|favicon|setup$)/;

app.use(async (req, _res, next) => {
  if (SKIP_AUTH.test(req.path)) return next();
  const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
  const session = token ? auth.readToken(token) : null;
  if (session && schemaReady) {
    try {
      const user = await accounts.getUserById(session.uid);
      if (user && user.active) req.user = user;
    } catch { /* treated as signed out */ }
  }
  next();
});

const wantsJson = (req) => req.path.startsWith('/api/') || req.path.startsWith('/stream/');

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'נדרשת התחברות', login: true });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'נדרשות הרשאות מנהל' });
  return res.redirect('/');
}

// Host names and URLs out of an upstream error would name the provider, so
// they never reach a normal viewer - the full text stays in the server log.
function scrubMessage(message) {
  return String(message)
    .replace(/https?:\/\/\S+/gi, 'השרת')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, 'השרת');
}

function apiError(res, err, status = 502, req = null) {
  const message = err?.message || String(err);
  console.error('[api]', message);
  const isAdmin = req?.user?.role === 'admin';
  res.status(err?.code === 'SCHEMA_MISSING' ? 503 : status)
    .json({ error: isAdmin ? message : scrubMessage(message) });
}

/* ----------------------------------------------------------- auth routes --- */

app.post('/api/auth/login', async (req, res) => {
  try {
    const row = await accounts.authenticate(req.body?.username, req.body?.password);
    if (!row) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    auth.setSessionCookie(res, auth.createToken(row), req);
    const user = await accounts.getUserById(row.id);
    res.json({ user });
  } catch (err) {
    apiError(res, err, 500);
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res, req);
  res.json({ ok: true });
});

// A viewer only needs to know which packages they have, never the line
// behind them - host, username and password stay on the server.
function viewerUser(user) {
  return {
    ...user,
    playlists: (user.playlists || []).map((p) => ({ id: p.id, name: p.name })),
  };
}

// Even for an admin: the admin screen reads credentials from /api/admin/users,
// so they have no reason to ride along with the session.
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: viewerUser(req.user) });
});

app.post('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const row = await accounts.authenticate(req.user.username, req.body?.current);
    if (!row) return res.status(400).json({ error: 'הסיסמה הנוכחית שגויה' });
    await accounts.updateUser(req.user.id, { password: req.body?.next });
    res.json({ ok: true });
  } catch (err) {
    apiError(res, err, 400);
  }
});

/* ---------------------------------------------------------- admin routes --- */

// The packages an admin can hand out. Static, because they come from how
// channel names are classified rather than from any one playlist.
app.get('/api/admin/genres', requireAuth, requireAdmin, (_req, res) => {
  res.json(catalog.GENRES.concat({ id: 'other', label: 'שונות', icon: '📺' })
    .map((g) => ({ id: g.id, label: g.label, icon: g.icon })));
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await accounts.listUsers());
  } catch (err) {
    apiError(res, err, 500);
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await accounts.createUser(req.body || {});
    if (req.body?.playlist && (req.body.playlist.url || req.body.playlist.host)) {
      await accounts.createPlaylist(user.id, req.body.playlist);
    }
    res.json(await accounts.getUserById(user.id));
  } catch (err) {
    apiError(res, err, 400);
  }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await accounts.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'המשתמש לא נמצא' });

    // Don't let the last admin lock everyone out.
    const losingAdmin = target.role === 'admin' && (req.body.role === 'user' || req.body.active === false);
    if (losingAdmin && (await accounts.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'חייב להישאר לפחות מנהל אחד פעיל' });
    }
    res.json(await accounts.updateUser(req.params.id, req.body || {}));
  } catch (err) {
    apiError(res, err, 400);
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'אי אפשר למחוק את עצמך' });
    const target = await accounts.getUserById(req.params.id);
    if (target?.role === 'admin' && (await accounts.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'חייב להישאר לפחות מנהל אחד פעיל' });
    }
    for (const playlist of target?.playlists || []) xtream.forget(playlist.id);
    await accounts.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    apiError(res, err, 400);
  }
});

app.post('/api/admin/users/:id/playlists', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await accounts.createPlaylist(req.params.id, req.body || {}));
  } catch (err) {
    apiError(res, err, 400);
  }
});

app.patch('/api/admin/playlists/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    xtream.forget(req.params.id);
    const playlist = await accounts.updatePlaylist(req.params.id, req.body || {});
    if (!playlist) return res.status(404).json({ error: 'הפלייליסט לא נמצא' });
    res.json(playlist);
  } catch (err) {
    apiError(res, err, 400);
  }
});

app.delete('/api/admin/playlists/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    xtream.forget(req.params.id);
    await accounts.deletePlaylist(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    apiError(res, err, 400);
  }
});

/** Try a line before saving it, so the admin sees right away whether it works. */
app.post('/api/admin/playlists/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = accounts.parsePlaylist(req.body?.url) || {};
    const probe = {
      id: `probe:${Date.now()}`,
      host: (req.body?.host || parsed.host || '').replace(/\/+$/, ''),
      username: req.body?.username || parsed.username || '',
      password: req.body?.password || parsed.password || '',
      maxStreams: 1,
    };
    if (!probe.host || !probe.username || !probe.password) {
      return res.status(400).json({ error: 'חסרים פרטי חיבור' });
    }

    const client = xtream.clientFor(probe);
    const [account, catalog] = await Promise.all([client.getAccount(), client.getCatalog()]);
    xtream.forget(probe.id);
    res.json({
      ok: account.authorized,
      account,
      channels: catalog.channels.length,
      parsed: { host: probe.host, username: probe.username, password: probe.password },
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------- playlist for this user --- */

async function resolvePlaylist(req, res) {
  const playlists = req.user.playlists || [];
  if (!playlists.length) {
    res.status(409).json({
      error: 'לא מקושר פלייליסט לחשבון הזה. פנה למנהל המערכת.',
      noPlaylist: true,
    });
    return null;
  }
  const wanted = req.query.playlist;
  const playlist = wanted ? playlists.find((p) => p.id === wanted) : playlists[0];
  if (!playlist) {
    res.status(404).json({ error: 'הפלייליסט לא נמצא' });
    return null;
  }
  return playlist;
}

/* ------------------------------------------------------------- live API --- */

app.get('/api/account', requireAuth, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;
  try {
    const { server, ...account } = await xtream.clientFor(playlist).getAccount();
    // Viewers get the playlist's label, never the provider's address.
    res.json({
      ...account,
      username: req.user.role === 'admin' ? account.username : null,
      playlistName: playlist.name,
      server: req.user.role === 'admin' ? server : null,
    });
  } catch (err) {
    apiError(res, err, 502, req);
  }
});

// The raw catalog carries the provider's logo host on every channel, so the
// browser gets opaque /logo/<id> paths instead and the server resolves them.
function publicCatalog(catalog, user) {
  const channels = catalog.channels
    .filter((ch) => accounts.allowsGenre(user, ch.genre))
    .map((ch) => ({ ...ch, logo: ch.logo ? `/logo/${ch.id}` : null }));

  // The package list has to shrink with the channels, or the sidebar offers
  // categories that come back empty.
  const counts = {};
  for (const ch of channels) counts[ch.genre] = (counts[ch.genre] || 0) + 1;

  return {
    ...catalog,
    channels,
    genres: catalog.genres.filter((g) => counts[g.id]).map((g) => ({ ...g, count: counts[g.id] })),
  };
}

/** Gatekeeper for everything that serves live TV. */
function requireLive(req, res, next) {
  if (!req.user?.access?.live) {
    return res.status(403).json({ error: 'החשבון הזה לא כולל שידורים חיים', noLive: true });
  }
  next();
}

/** Gatekeeper for the movies & series section. */
function requireVod(req, res, next) {
  if (!req.user?.access?.vod) {
    return res.status(403).json({ error: 'החשבון הזה לא כולל סרטים וסדרות', noVod: true });
  }
  next();
}

/**
 * A channel id in a URL proves nothing, so every per-channel route checks the
 * channel against the viewer's packages before doing any work.
 */
async function allowedChannel(req, res, playlist, id) {
  const catalog = await xtream.clientFor(playlist).getCatalog();
  const channel = catalog.channels.find((c) => String(c.id) === String(id));
  if (!channel || !accounts.allowsGenre(req.user, channel.genre)) {
    res.status(404).json({ error: 'הערוץ לא נמצא' });
    return null;
  }
  return channel;
}

app.get('/api/channels', requireAuth, requireLive, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;
  try {
    res.json(publicCatalog(await xtream.clientFor(playlist).getCatalog(), req.user));
  } catch (err) {
    apiError(res, err, 502, req);
  }
});

app.get('/api/epg/:id', requireAuth, requireLive, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad stream id' });
  try {
    if (!(await allowedChannel(req, res, playlist, id))) return;
    res.json(await xtream.clientFor(playlist).getChannelEpg(id));
  } catch (err) {
    apiError(res, err);
  }
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;
  xtream.clientFor(playlist).clearCache();
  res.json({ ok: true });
});

/* ------------------------------------------------------- movies & series --- */

app.get('/api/vod/shelves', requireAuth, requireVod, async (_req, res) => {
  try { res.json(await vod.shelves()); } catch (err) { apiError(res, err); }
});

app.get('/api/vod/search', requireAuth, requireVod, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 120);
  const type = ['movie', 'tv'].includes(req.query.type) ? req.query.type : 'all';
  if (q.trim().length < 2) return res.json([]);
  try { res.json(await vod.search(q, type)); } catch (err) { apiError(res, err); }
});

app.get('/api/vod/title/:id', requireAuth, requireVod, async (req, res) => {
  try { res.json(await vod.title(String(req.params.id))); } catch (err) { apiError(res, err, 404); }
});

app.get('/api/vod/episodes/:id', requireAuth, requireVod, async (req, res) => {
  try { res.json(await vod.episodes(String(req.params.id))); } catch (err) { apiError(res, err); }
});

// The player frame points here; we redirect to the provider instead of
// handing its address to the page.
app.get('/play/:type/:id/:season?/:episode?', requireAuth, requireVod, (req, res) => {
  try {
    res.redirect(302, vod.embedUrl({
      type: req.params.type === 'tv' ? 'tv' : 'movie',
      id: String(req.params.id),
      season: req.params.season,
      episode: req.params.episode,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------- logos --- */

const logoCache = new Map();
const LOGO_TTL = 12 * 60 * 60 * 1000;
const LOGO_CACHE_MAX = 400;

app.get('/logo/:id', requireAuth, requireLive, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;

  // Look the real address up here instead of taking it from the query string,
  // so the provider's logo host never appears in the browser's network log.
  let raw = null;
  try {
    const channel = await allowedChannel(req, res, playlist, req.params.id);
    if (!channel) return;
    raw = channel.logo || null;
  } catch {
    return res.status(502).end();
  }
  if (!raw || !/^https?:\/\//i.test(raw)) return res.status(404).end();

  const hit = logoCache.get(raw);
  if (hit && hit.expires > Date.now()) {
    if (!hit.body) return res.status(404).end();
    res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=43200');
    return res.end(hit.body);
  }

  const remember = (entry) => {
    if (logoCache.size >= LOGO_CACHE_MAX) logoCache.delete(logoCache.keys().next().value);
    logoCache.set(raw, entry);
  };

  try {
    const upstream = await fetch(raw, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      remember({ body: null, type: '', expires: Date.now() + 10 * 60 * 1000 });
      return res.status(404).end();
    }
    const type = upstream.headers.get('content-type') || 'image/png';
    if (!type.startsWith('image/')) return res.status(415).end();
    const body = Buffer.from(await upstream.arrayBuffer());
    remember({ body, type, expires: Date.now() + LOGO_TTL });
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=43200').end(body);
  } catch {
    remember({ body: null, type: '', expires: Date.now() + 10 * 60 * 1000 });
    res.status(504).end();
  }
});

/* --------------------------------------------------------------- streams --- */

// Provider lines allow a limited number of concurrent connections, counted
// per playlist so one user cannot knock another off the air.
const activeByPlaylist = new Map();

function releaseOldest(playlistId, limit) {
  const set = activeByPlaylist.get(playlistId);
  if (!set) return;
  while (set.size >= limit) {
    const oldest = set.values().next().value;
    if (!oldest) break;
    set.delete(oldest);
    oldest.stop('replaced by a newer stream');
  }
}

app.get('/stream/:id', requireAuth, requireLive, async (req, res) => {
  const playlist = await resolvePlaylist(req, res);
  if (!playlist) return;

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).end();

  // The one check that really counts: without it, guessing a stream id would
  // play a channel the account was never given.
  try {
    if (!(await allowedChannel(req, res, playlist, id))) return;
  } catch (err) {
    return apiError(res, err, 502, req);
  }

  const client = xtream.clientFor(playlist);
  const controller = new AbortController();
  const entry = {
    id,
    startedAt: Date.now(),
    stop(reason) {
      if (entry.stopped) return;
      entry.stopped = true;
      console.log(`[stream ${id}] closed (${reason})`);
      controller.abort();
      res.destroy();
    },
  };

  if (!activeByPlaylist.has(playlist.id)) activeByPlaylist.set(playlist.id, new Set());
  const active = activeByPlaylist.get(playlist.id);
  releaseOldest(playlist.id, playlist.maxStreams || config.defaultMaxStreams);
  active.add(entry);

  const cleanup = () => {
    active.delete(entry);
    if (!entry.stopped) {
      entry.stopped = true;
      controller.abort();
    }
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    await pumpStream(client, id, res, entry, controller);
  } catch (err) {
    if (controller.signal.aborted || entry.stopped) return;
    console.error(`[stream ${id}]`, err.message);
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.destroy();
  } finally {
    active.delete(entry);
  }
});

// The provider hands out short-lived stream sessions and hangs up every few
// seconds; players are expected to reconnect. We do that here so the browser
// sees one uninterrupted MPEG-TS response.
const RECONNECT_LIMIT = 60;

async function pumpStream(client, id, res, entry, controller) {
  let reconnects = 0;
  let delivered = 0;

  while (!entry.stopped && !res.writableEnded) {
    const upstream = await fetch(client.streamUrl(id), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: '*/*' },
    });

    if (!upstream.ok || !upstream.body) {
      if (!res.headersSent) {
        return void res.status(upstream.status === 404 ? 404 : 502).json({
          error: `הספק סירב לשידור (${upstream.status})`,
        });
      }
      break;
    }

    if (!res.headersSent) {
      res.status(200).set({
        'Content-Type': upstream.headers.get('content-type') || 'video/mp2t',
        'Cache-Control': 'no-store, no-transform',
        // A hosting proxy that buffers this response would stall live TV until
        // its buffer fills; these tell nginx and friends to pass it straight on.
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      console.log(`[stream ${id}] streaming`);
    }

    for await (const chunk of upstream.body) {
      if (entry.stopped || res.writableEnded) return;
      delivered += chunk.length;
      if (!res.write(Buffer.from(chunk))) await once(res, 'drain');
    }

    if (entry.stopped || res.writableEnded) return;
    reconnects += 1;
    if (reconnects > RECONNECT_LIMIT) {
      console.warn(`[stream ${id}] giving up after ${reconnects} reconnects`);
      break;
    }
    console.log(`[stream ${id}] upstream ended at ${(delivered / 1048576).toFixed(1)} MB, reconnecting (#${reconnects})`);
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!res.writableEnded) res.end();
}

/* ----------------------------------------------------------------- pages --- */

app.get('/setup', (_req, res) => res.sendFile(view('setup.html')));

app.get('/api/setup/sql', (_req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '..', 'supabase', 'schema.sql'));
});

// Served so an existing installation can copy the access migration straight
// out of the admin screen instead of digging through the repo.
app.get('/api/setup/sql/access', requireAuth, requireAdmin, (_req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '..', 'supabase', 'migration-access.sql'));
});

app.get('/api/setup/status', async (_req, res) => {
  schemaReady = await db.schemaReady().catch(() => false);
  let seeded = null;
  if (schemaReady) {
    seeded = await accounts.ensureSeedAdmin().catch(() => null);
    if (seeded) console.log(`\n  נוצר חשבון מנהל ראשון:  ${seeded.username} / ${seeded.password}\n`);
  }
  res.json({ ready: schemaReady, seeded });
});

app.get('/login', (req, res) => {
  if (!schemaReady) return res.redirect('/setup');
  if (req.user) return res.redirect('/');
  res.sendFile(view('login.html'));
});

app.get('/admin', (req, res, next) => {
  if (!schemaReady) return res.redirect('/setup');
  requireAuth(req, res, () => requireAdmin(req, res, () => res.sendFile(view('admin.html'))));
});

app.get('/', (req, res) => {
  if (!schemaReady) return res.redirect('/setup');
  if (!req.user) return res.redirect('/login');
  res.sendFile(view('app.html'));
});

// The TV build (and the Android wrapper) land here. It signs in on its own,
// so it is served without the redirect dance a remote control cannot follow.
app.get('/tv', (_req, res) => res.sendFile(view('tv.html')));

app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'mpegts.js', 'dist'), {
  maxAge: '7d',
  immutable: true,
}));

app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'),
}));

app.use((req, res) => {
  if (wantsJson(req)) return res.status(404).json({ error: 'not found' });
  res.redirect('/');
});

/* ------------------------------------------------------------------ boot --- */

(async () => {
  try {
    schemaReady = await db.schemaReady();
  } catch (err) {
    console.error(`\n  Supabase error: ${err.message}\n`);
  }

  if (schemaReady) {
    try {
      const seeded = await accounts.ensureSeedAdmin();
      if (seeded) {
        console.log(`\n  נוצר חשבון מנהל ראשון:  ${seeded.username} / ${seeded.password}`);
        console.log('  מומלץ להחליף סיסמה אחרי ההתחברות.\n');
      }
    } catch (err) {
      console.error('  seed failed:', err.message);
    }
  } else {
    console.log('\n  ⚠  הטבלאות ב-Supabase עדיין לא קיימות — פתח http://localhost:' + config.port + '/setup\n');
  }

  // On a serverless host the platform owns the socket: export the app instead.
  if (process.env.VERCEL) return;

  // Managed Node hosting (cPanel/Passenger, Railway, Render...) hands the port
  // over in PORT and puts its own proxy in front, so bind what we were given.
  app.listen(config.port, () => {
    console.log(`  SmartLive  ->  http://localhost:${config.port}`);
    console.log(`  admin      ->  http://localhost:${config.port}/admin`);

    // The TV app asks for an address; print the ones that actually work from
    // another device on the network.
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  TV         ->  ${net.address}:${config.port}   (הזן בטלוויזיה)`);
        }
      }
    }
    console.log('');
  });
})();

module.exports = app;
