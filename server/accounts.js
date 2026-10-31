'use strict';

// Users and the IPTV playlists attached to them.

const db = require('./db');
const auth = require('./auth');
const config = require('./config');

const USERS = 'app_users';
const PLAYLISTS = 'playlists';

/* ------------------------------------------------------------- shaping --- */

// Never let password_hash leave this module.
function publicUser(row, playlists = []) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    playlists: playlists.map(publicPlaylist),
  };
}

function publicPlaylist(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    host: row.host,
    username: row.username,
    // The line password is shown in the admin screen on purpose: whoever
    // manages accounts has to be able to read back what they typed.
    password: row.password,
    maxStreams: row.max_streams,
    updatedAt: row.updated_at,
  };
}

/* --------------------------------------------------------------- users --- */

async function listUsers() {
  const [users, playlists] = await Promise.all([
    db.select(USERS, { order: 'created_at.asc' }),
    db.select(PLAYLISTS, { order: 'created_at.asc' }),
  ]);
  const byUser = new Map();
  for (const p of playlists) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id).push(p);
  }
  return users.map((u) => publicUser(u, byUser.get(u.id) || []));
}

async function rawUserByUsername(username) {
  // Usernames are compared case-insensitively (matching the unique index).
  const rows = await db.select(USERS, { username: `ilike.${username}`, limit: 1 });
  return rows[0] || null;
}

// Every request resolves its session user, so keep that out of the database
// for a few seconds. Any write through this module drops the entry.
const userCache = new Map();
const USER_TTL = 15 * 1000;

function invalidate(userId) {
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

async function getUserById(id, { fresh = false } = {}) {
  if (!fresh) {
    const hit = userCache.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;
  }
  const [rows, playlists] = await Promise.all([
    db.select(USERS, { id: `eq.${id}`, limit: 1 }),
    db.select(PLAYLISTS, { user_id: `eq.${id}`, order: 'created_at.asc' }),
  ]);
  const user = publicUser(rows[0], playlists);
  userCache.set(id, { value: user, expires: Date.now() + USER_TTL });
  return user;
}

async function authenticate(username, password) {
  const row = await rawUserByUsername(String(username || '').trim());
  if (!row || !row.active) return null;
  if (!auth.verifyPassword(String(password || ''), row.password_hash)) return null;
  db.update(USERS, { id: `eq.${row.id}` }, { last_login_at: new Date().toISOString() }).catch(() => {});
  return row;
}

async function createUser({ username, password, displayName, role = 'user' }) {
  const clean = String(username || '').trim();
  if (!/^[\w.@-]{3,40}$/.test(clean)) throw new Error('שם המשתמש חייב להיות 3-40 תווים (אותיות, ספרות, נקודה, מקף)');
  if (String(password || '').length < 4) throw new Error('הסיסמה חייבת להיות 4 תווים לפחות');
  if (await rawUserByUsername(clean)) throw new Error('שם המשתמש כבר תפוס');

  const row = await db.insert(USERS, {
    username: clean,
    password_hash: auth.hashPassword(String(password)),
    display_name: displayName?.trim() || null,
    role: role === 'admin' ? 'admin' : 'user',
  });
  return publicUser(row, []);
}

async function updateUser(id, patch) {
  const next = {};
  if (patch.displayName !== undefined) next.display_name = patch.displayName?.trim() || null;
  if (patch.role !== undefined) next.role = patch.role === 'admin' ? 'admin' : 'user';
  if (patch.active !== undefined) next.active = Boolean(patch.active);
  if (patch.password) {
    if (String(patch.password).length < 4) throw new Error('הסיסמה חייבת להיות 4 תווים לפחות');
    next.password_hash = auth.hashPassword(String(patch.password));
  }
  if (!Object.keys(next).length) return getUserById(id, { fresh: true });
  await db.update(USERS, { id: `eq.${id}` }, next);
  invalidate(id);
  return getUserById(id, { fresh: true });
}

async function deleteUser(id) {
  await db.remove(USERS, { id: `eq.${id}` });
  invalidate(id);
}

async function countAdmins() {
  const rows = await db.select(USERS, { select: 'id', role: 'eq.admin', active: 'eq.true' });
  return rows.length;
}

/* ----------------------------------------------------------- playlists --- */

/**
 * Accepts what an admin is likely to paste:
 *   http://host:80/get.php?username=U&password=P&type=m3u_plus
 *   http://host:80/U/P/12345
 *   http://host:80  (+ separate username / password fields)
 */
function parsePlaylist(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }

  const host = `${url.protocol}//${url.host}`;
  const fromQuery = {
    username: url.searchParams.get('username'),
    password: url.searchParams.get('password'),
  };
  if (fromQuery.username && fromQuery.password) {
    return { host, username: fromQuery.username, password: fromQuery.password };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && !/\.php$/i.test(parts[0])) {
    return { host, username: decodeURIComponent(parts[0]), password: decodeURIComponent(parts[1]) };
  }

  return { host, username: '', password: '' };
}

function normalizePlaylistInput(body) {
  const fromUrl = body.url ? parsePlaylist(body.url) : null;
  const host = (body.host || fromUrl?.host || '').trim().replace(/\/+$/, '');
  const username = (body.username || fromUrl?.username || '').trim();
  const password = (body.password || fromUrl?.password || '').trim();

  if (!/^https?:\/\//i.test(host)) throw new Error('כתובת השרת חייבת להתחיל ב-http:// או https://');
  if (!username || !password) throw new Error('חסרים שם משתמש או סיסמה של הפלייליסט');

  return {
    host,
    username,
    password,
    name: (body.name || '').trim() || 'הפלייליסט שלי',
    max_streams: Math.max(1, Number(body.maxStreams) || config.defaultMaxStreams),
  };
}

async function createPlaylist(userId, body) {
  const data = normalizePlaylistInput(body);
  const row = await db.insert(PLAYLISTS, { user_id: userId, ...data });
  invalidate(userId);
  return publicPlaylist(row);
}

async function updatePlaylist(id, body) {
  const data = normalizePlaylistInput(body);
  const row = await db.update(PLAYLISTS, { id: `eq.${id}` }, { ...data, updated_at: new Date().toISOString() });
  invalidate(row?.user_id);
  return row ? publicPlaylist(row) : null;
}

async function deletePlaylist(id) {
  const existing = await getPlaylist(id);
  await db.remove(PLAYLISTS, { id: `eq.${id}` });
  invalidate(existing?.userId);
}

async function getPlaylist(id) {
  const rows = await db.select(PLAYLISTS, { id: `eq.${id}`, limit: 1 });
  return rows[0] ? publicPlaylist(rows[0]) : null;
}

async function playlistsFor(userId) {
  const rows = await db.select(PLAYLISTS, { user_id: `eq.${userId}`, order: 'created_at.asc' });
  return rows.map(publicPlaylist);
}

/* ---------------------------------------------------------------- seed --- */

/** First run: make sure somebody can actually sign in. */
async function ensureSeedAdmin() {
  const existing = await db.select(USERS, { select: 'id', limit: 1 });
  if (existing.length) return null;

  const password = config.seed.adminPassword || require('crypto').randomBytes(6).toString('base64url');
  const admin = await createUser({
    username: config.seed.adminUsername,
    password,
    displayName: 'מנהל',
    role: 'admin',
  });

  if (config.seed.playlist) {
    await createPlaylist(admin.id, { ...config.seed.playlist, name: 'הפלייליסט מההתקנה' });
  }

  return { username: admin.username, password };
}

module.exports = {
  listUsers,
  invalidate,
  getUserById,
  authenticate,
  createUser,
  updateUser,
  deleteUser,
  countAdmins,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  getPlaylist,
  playlistsFor,
  parsePlaylist,
  ensureSeedAdmin,
};
