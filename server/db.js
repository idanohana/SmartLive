'use strict';

// Thin PostgREST client for Supabase. The service key stays on the server, so
// every query here runs with full access - never expose these helpers to the
// browser without an auth check in front of them.

const config = require('./config');

const BASE = `${config.supabase.url}/rest/v1`;
const HEADERS = {
  apikey: config.supabase.serviceKey,
  Authorization: `Bearer ${config.supabase.serviceKey}`,
  'Content-Type': 'application/json',
};

class SchemaMissingError extends Error {
  constructor(table) {
    super(`table "${table}" is missing - run supabase/schema.sql in the Supabase SQL editor`);
    this.code = 'SCHEMA_MISSING';
    this.table = table;
  }
}

async function request(table, { method = 'GET', query = '', body, prefer } = {}) {
  const headers = { ...HEADERS };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${BASE}/${table}${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (payload?.code === 'PGRST205' || payload?.code === '42P01') throw new SchemaMissingError(table);
    const message = payload?.message || `supabase ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.details = payload;
    throw err;
  }
  return payload;
}

const qs = (params) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

const select = (table, params = {}) => request(table, { query: qs({ select: '*', ...params }) });

const insert = (table, row) =>
  request(table, { method: 'POST', body: row, prefer: 'return=representation' }).then((rows) => rows?.[0] || null);

const update = (table, params, patch) =>
  request(table, { method: 'PATCH', query: qs(params), body: patch, prefer: 'return=representation' })
    .then((rows) => rows?.[0] || null);

const remove = (table, params) => request(table, { method: 'DELETE', query: qs(params) });

/** Are the SmartLive tables there yet? */
async function schemaReady() {
  try {
    await select('app_users', { select: 'id', limit: 1 });
    await select('playlists', { select: 'id', limit: 1 });
    return true;
  } catch (err) {
    if (err.code === 'SCHEMA_MISSING') return false;
    throw err;
  }
}

module.exports = { select, insert, update, remove, request, schemaReady, SchemaMissingError };
