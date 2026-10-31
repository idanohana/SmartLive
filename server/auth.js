'use strict';

// Password hashing (scrypt, from node's crypto - no extra dependency) and
// stateless signed-cookie sessions.

const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'sl_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------ passwords --- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- sessions --- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

function createToken(user) {
  const payload = b64url(JSON.stringify({
    uid: user.id,
    role: user.role,
    exp: Date.now() + config.sessionDays * 24 * 60 * 60 * 1000,
  }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- cookies --- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Over HTTPS the cookie must be Secure; over plain http on a LAN it must not
// be, or the browser drops it and nobody can sign in.
function cookieFlags(req) {
  const https = Boolean(req?.secure) || req?.headers?.['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
}

function setSessionCookie(res, token, req) {
  const maxAge = config.sessionDays * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req)}; Max-Age=${maxAge}`);
}

function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  createToken,
  readToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
};
