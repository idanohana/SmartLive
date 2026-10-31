'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Minimal .env loader so the project stays dependency-light.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env'));

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`\n  Missing ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return value;
}

// The session secret must survive restarts, otherwise everyone is logged out
// on every deploy; generate one on first run and keep it next to the project.
function sessionSecret() {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  const file = path.join(root, '.session-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Read-only filesystem (serverless). A per-instance secret still works,
    // but everyone is signed out whenever the instance recycles.
    console.warn('  ⚠  SESSION_SECRET is not set and cannot be stored - sign-ins will not survive a restart.');
    return crypto.randomBytes(48).toString('hex');
  }
}

module.exports = {
  port: Number(process.env.PORT) || 4321,
  sessionSecret: sessionSecret(),
  sessionDays: Number(process.env.SESSION_DAYS) || 30,

  supabase: {
    url: requireEnv('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: requireEnv('SUPABASE_SERVICE_KEY'),
  },

  // Seeded into the first admin account when the database is still empty.
  seed: {
    adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
    adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
    playlist: process.env.IPTV_HOST && process.env.IPTV_USERNAME && process.env.IPTV_PASSWORD
      ? {
        host: process.env.IPTV_HOST.replace(/\/+$/, ''),
        username: process.env.IPTV_USERNAME,
        password: process.env.IPTV_PASSWORD,
      }
      : null,
  },

  defaultMaxStreams: Number(process.env.MAX_STREAMS) || 1,
};
