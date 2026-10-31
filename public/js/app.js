/* =========================================================================
   SmartLive — client app
   Grid + filters + MPEG-TS live player (mpegts.js) over the local proxy.
   ========================================================================= */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE = {
  favs: 'smartlive.favorites',
  recent: 'smartlive.recent',
  volume: 'smartlive.volume',
  muted: 'smartlive.muted',
  view: 'smartlive.view',
  sort: 'smartlive.sort',
};

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const state = {
  mode: 'live',           // live | vod
  me: null,               // signed-in user
  playlistId: readStore('smartlive.playlist', null),
  channels: [],
  byId: new Map(),
  genres: [],
  account: null,
  filter: 'all',          // all | favorites | recent | genre:<id>
  query: '',
  sort: readStore(STORE.sort, 'default'),
  view: readStore(STORE.view, 'grid'),
  favorites: new Set(readStore(STORE.favs, [])),
  recent: readStore(STORE.recent, []),
  visible: [],            // channels currently listed, in display order
  current: null,
};

const epgCache = new Map();

/* ------------------------------------------------------------- helpers --- */

const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayMonth = (ts) => { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}`; };

// The server hands out opaque /logo/<id> paths; the real address stays there.
function logoUrl(ch) {
  return ch.logo || null;
}

function initials(name) {
  return name.replace(/[^A-Za-z֐-׿0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ') || name.slice(0, 6);
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 5200 : 2800);
}

async function getJSON(url) {
  const res = await fetch(withPlaylist(url));
  if (res.status === 401) { location.href = '/login'; throw new Error('נדרשת התחברות'); }
  if (!res.ok) {
    let detail = `${res.status}`;
    let payload = null;
    try { payload = await res.json(); detail = payload.error || detail; } catch { /* ignore */ }
    const err = new Error(detail);
    err.payload = payload;
    throw err;
  }
  return res.json();
}

// Live endpoints are scoped to the playlist the user picked.
function withPlaylist(url) {
  if (!state.playlistId) return url;
  if (!/^\/(api\/(channels|account|epg|refresh)|stream)\b/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `playlist=${encodeURIComponent(state.playlistId)}`;
}

/* ---------------------------------------------------------------- boot --- */

async function boot() {
  renderSkeleton();

  if (!(await loadMe())) return;

  // An account without live TV goes straight to the movies section; the live
  // half of the app is not just hidden, the server refuses it too.
  if (!access().live) {
    setMode('vod');
    history.replaceState(null, '', '#/vod');
    return;
  }

  loadAccount();

  try {
    const catalog = await getJSON('/api/channels');
    state.channels = catalog.channels;
    state.byId = new Map(catalog.channels.map((c) => [c.id, c]));
    state.genres = catalog.genres;
    $('#footMeta').textContent = `${catalog.channels.length} ערוצים · עודכן ${clock(catalog.updatedAt)}`;
    renderNav();
    applyRoute();
    render();
  } catch (err) {
    $('#channels').innerHTML = '';
    $('#hero').hidden = true;
    $('#empty').hidden = false;
    if (err.payload?.noPlaylist) {
      $('#empty').querySelector('.empty-art').textContent = '🔌';
      $('#empty').querySelector('h3').textContent = 'אין פלייליסט מקושר לחשבון';
      $('#emptyHint').textContent = state.me?.role === 'admin'
        ? 'אפשר לקשר פלייליסט בדף הניהול.'
        : 'פנה למנהל המערכת כדי שיקשר לך פלייליסט. סרטים וסדרות זמינים גם בלי זה.';
    } else {
      $('#empty').querySelector('h3').textContent = 'לא הצלחנו לטעון את רשימת הערוצים';
      $('#emptyHint').textContent = String(err.message || err);
      toast(`שגיאת ספק: ${err.message}`, 'err');
    }
  }
}

/** What this account may watch; everything is allowed until we know better. */
const access = () => state.me?.access || { live: true, vod: true, genres: [] };

/** Who is signed in, and which playlists they have. */
async function loadMe() {
  try {
    const { user } = await getJSON('/api/auth/me');
    state.me = user;

    const playlists = user.playlists || [];
    if (!playlists.some((p) => p.id === state.playlistId)) {
      state.playlistId = playlists[0]?.id || null;
      writeStore('smartlive.playlist', state.playlistId);
    }

    $('#userName').textContent = user.displayName || user.username;
    $('#userAvatar').textContent = (user.displayName || user.username).slice(0, 2).toUpperCase();
    $('#adminLink').hidden = user.role !== 'admin';

    // Only offer the halves of the app this account actually has.
    $$('#modeSwitch button').forEach((b) => {
      b.hidden = b.dataset.mode === 'live' ? !access().live : !access().vod;
    });
    $('#modeSwitch').hidden = !access().live || !access().vod;

    const picker = $('#playlistPicker');
    picker.hidden = playlists.length < 2;
    if (playlists.length > 1) {
      picker.innerHTML = playlists.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      picker.value = state.playlistId;
    }
    return true;
  } catch {
    location.href = '/login';
    return false;
  }
}

async function loadAccount() {
  const chip = $('#accountChip');
  try {
    const acc = await getJSON('/api/account');
    state.account = acc;
    const ok = acc.authorized && /active/i.test(acc.status || '');
    chip.classList.add(ok ? 'ok' : 'bad');
    chip.querySelector('.account-text').textContent = ok
      ? (acc.trial ? 'מנוי ניסיון פעיל' : 'מנוי פעיל')
      : `מנוי ${acc.status || 'לא מאומת'}`;
    $('#metaServer').textContent = acc.server || acc.playlistName || '—';
    $('#metaConns').textContent = `${acc.activeConnections}/${acc.maxConnections}`;
    $('#metaExpiry').textContent = acc.expiresAt
      ? `${dayMonth(acc.expiresAt)}/${new Date(acc.expiresAt).getFullYear()}`
      : 'ללא הגבלה';
    const until = acc.expiresAt ? new Date(acc.expiresAt).toLocaleString('he-IL') : 'ללא הגבלה';
    chip.title = [acc.username, `בתוקף עד ${until}`].filter(Boolean).join(' · ');
  } catch {
    chip.classList.add('bad');
    chip.querySelector('.account-text').textContent = 'אין חיבור לספק';
  }
}

/* -------------------------------------------------------------- filters --- */

function renderNav() {
  if (state.mode === 'vod') {
    window.SL?.vod?.renderNav?.();
    return;
  }

  const groups = [
    { label: '', items: [
      { id: 'all', icon: '📡', name: 'כל הערוצים', count: state.channels.length },
      { id: 'favorites', icon: '⭐', name: 'מועדפים', count: state.favorites.size },
      { id: 'recent', icon: '🕘', name: 'נצפו לאחרונה', count: state.recent.length },
    ] },
    { label: 'קטגוריות', items: state.genres.map((g) => ({ id: `genre:${g.id}`, icon: g.icon, name: g.label, count: g.count })) },
  ];

  const nav = $('#nav');
  nav.innerHTML = '';
  for (const group of groups) {
    if (group.label) {
      const label = document.createElement('div');
      label.className = 'nav-label';
      label.textContent = group.label;
      nav.appendChild(label);
    }
    for (const item of group.items) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (state.filter === item.id ? ' active' : '');
      btn.dataset.filter = item.id;
      btn.innerHTML = `<span class="ico">${item.icon}</span><span class="n"></span><span class="c">${item.count}</span>`;
      btn.querySelector('.n').textContent = item.name;
      btn.addEventListener('click', () => {
        state.filter = item.id;
        location.hash = item.id === 'all' ? '' : `#/${item.id}`;
        closeSidebar();
        render();
      });
      nav.appendChild(btn);
    }
  }
}

function filterTitle() {
  if (state.query) return `תוצאות עבור “${state.query}”`;
  if (state.filter === 'all') return 'כל הערוצים';
  if (state.filter === 'favorites') return 'מועדפים';
  if (state.filter === 'recent') return 'נצפו לאחרונה';
  const genre = state.genres.find((g) => `genre:${g.id}` === state.filter);
  return genre ? genre.label : 'כל הערוצים';
}

function computeVisible() {
  let list = state.channels;

  if (state.filter === 'favorites') {
    list = list.filter((c) => state.favorites.has(c.id));
  } else if (state.filter === 'recent') {
    const order = new Map(state.recent.map((id, i) => [id, i]));
    list = state.recent.map((id) => state.byId.get(id)).filter(Boolean);
    list.sort((a, b) => order.get(a.id) - order.get(b.id));
  } else if (state.filter.startsWith('genre:')) {
    const genre = state.filter.slice(6);
    list = list.filter((c) => c.genre === genre);
  }

  if (state.query) {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((c) => terms.every((t) => c.searchText.includes(t)));
  }

  if (state.sort === 'name' && state.filter !== 'recent') {
    list = [...list].sort((a, b) => (a.nameHe || a.name).localeCompare(b.nameHe || b.name, 'he'));
  }

  return list;
}

/* --------------------------------------------------------------- render --- */

function renderSkeleton() {
  const grid = $('#channels');
  grid.innerHTML = '';
  for (let i = 0; i < 12; i += 1) {
    const sk = document.createElement('div');
    sk.className = 'card';
    sk.style.height = '176px';
    sk.style.opacity = String(0.55 - i * 0.03);
    grid.appendChild(sk);
  }
}

function channelCard(ch) {
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.id = String(ch.id);
  card.type = 'button';

  const tags = [];
  if (ch.quality) tags.push(`<span class="badge ${ch.quality === '4K' ? 'q4k' : 'qhd'}">${ch.quality}</span>`);
  if (ch.platform) tags.push(`<span class="badge plat">${ch.platform}</span>`);

  const logo = logoUrl(ch);
  card.innerHTML = `
    <div class="card-art">
      ${logo ? `<img loading="lazy" alt="" src="${logo}">` : `<span class="fallback">${initials(ch.name)}</span>`}
      <div class="card-tags">${tags.join('')}</div>
      <span class="card-play"><span><svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/></svg></span></span>
    </div>
    <div class="card-body">
      <div class="card-title"></div>
      <div class="card-sub"></div>
      <div class="progress" hidden><i style="width:0%"></i></div>
    </div>
    <button class="fav${state.favorites.has(ch.id) ? ' on' : ''}" title="מועדפים" aria-label="הוסף למועדפים">
      <svg viewBox="0 0 24 24"><path d="M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.8z"/></svg>
    </button>`;

  card.querySelector('.card-title').textContent = ch.nameHe || ch.name;
  card.querySelector('.card-sub').textContent = ch.nameHe ? ch.name : (ch.group || '');

  const img = card.querySelector('img');
  if (img) {
    img.addEventListener('error', () => {
      img.remove();
      const fb = document.createElement('span');
      fb.className = 'fallback';
      fb.textContent = initials(ch.name);
      card.querySelector('.card-art').prepend(fb);
    });
  }

  card.querySelector('.fav').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleFavorite(ch.id);
    card.querySelector('.fav').classList.toggle('on', state.favorites.has(ch.id));
    if (state.filter === 'favorites') render();
  });

  card.addEventListener('click', () => openPlayer(ch.id));
  return card;
}

function render() {
  if (state.mode !== 'live') return;
  state.visible = computeVisible();

  $('#listTitle').textContent = filterTitle();
  $('#listCount').textContent = state.visible.length ? `${state.visible.length} ערוצים` : '';
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
  $$('#sortSeg button').forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sort));
  $$('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));

  const grid = $('#channels');
  grid.className = `grid${state.view === 'list' ? ' list' : ''}`;
  grid.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const ch of state.visible) frag.appendChild(channelCard(ch));
  grid.appendChild(frag);

  $('#empty').hidden = state.visible.length > 0;
  if (!state.visible.length) {
    $('#empty').querySelector('h3').textContent = 'לא נמצאו ערוצים';
    $('#emptyHint').textContent = state.filter === 'favorites'
      ? 'סמן ערוצים בכוכב כדי שיופיעו כאן.'
      : 'נסה מונח חיפוש אחר או קטגוריה אחרת.';
  }

  renderHero();
  observeCards();
}

function renderHero() {
  const hero = $('#hero');
  const lastId = state.recent[0];
  const show = state.filter === 'all' && !state.query && lastId && state.byId.has(lastId);
  hero.hidden = !show;
  if (!show) return;

  const ch = state.byId.get(lastId);
  $('#heroTitle').textContent = ch.nameHe || ch.name;
  const logo = logoUrl(ch);
  $('#heroLogo').src = logo || '';
  $('#heroLogo').style.display = logo ? '' : 'none';
  $('#heroPlay').onclick = () => openPlayer(ch.id);

  $('#heroNow').textContent = ch.nameHe ? ch.name : '';
  epgFor(ch.id).then((epg) => {
    if ($('#heroTitle').textContent !== (ch.nameHe || ch.name)) return;
    if (epg?.now) $('#heroNow').textContent = `עכשיו: ${epg.now.title} · עד ${clock(epg.now.end)}`;
  }).catch(() => {});
}

/* ------------------------------------------------------- EPG on the grid --- */

const epgQueue = [];
let epgActive = 0;

function epgFor(id) {
  if (epgCache.has(id)) return Promise.resolve(epgCache.get(id));
  return new Promise((resolve, reject) => {
    epgQueue.push({ id, resolve, reject });
    pumpEpgQueue();
  });
}

function pumpEpgQueue() {
  while (epgActive < 4 && epgQueue.length) {
    const job = epgQueue.shift();
    if (epgCache.has(job.id)) { job.resolve(epgCache.get(job.id)); continue; }
    epgActive += 1;
    getJSON(`/api/epg/${job.id}`)
      .then((epg) => { epgCache.set(job.id, epg); job.resolve(epg); })
      .catch((err) => job.reject(err))
      .finally(() => { epgActive -= 1; pumpEpgQueue(); });
  }
}

let cardObserver = null;

function observeCards() {
  if (cardObserver) cardObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;

  cardObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      cardObserver.unobserve(card);
      decorateCardWithEpg(card);
    }
  }, { rootMargin: '220px' });

  $$('#channels .card').forEach((card) => cardObserver.observe(card));
}

async function decorateCardWithEpg(card) {
  const id = Number(card.dataset.id);
  const ch = state.byId.get(id);
  if (!ch) return;
  try {
    const epg = await epgFor(id);
    if (!epg?.now) return;
    const sub = card.querySelector('.card-sub');
    sub.textContent = epg.now.title;
    sub.title = epg.now.description || epg.now.title;
    const bar = card.querySelector('.progress');
    if (bar) {
      const pct = Math.min(100, Math.max(0, ((Date.now() - epg.now.start) / (epg.now.end - epg.now.start)) * 100));
      bar.hidden = false;
      bar.querySelector('i').style.width = `${pct}%`;
    }
  } catch { /* EPG is a nice-to-have */ }
}

/* ----------------------------------------------------------- favorites --- */

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  writeStore(STORE.favs, [...state.favorites]);
  const navItem = $('.nav-item[data-filter="favorites"] .c');
  if (navItem) navItem.textContent = String(state.favorites.size);
}

function pushRecent(id) {
  state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 20);
  writeStore(STORE.recent, state.recent);
  const navItem = $('.nav-item[data-filter="recent"] .c');
  if (navItem) navItem.textContent = String(state.recent.length);
}

/* ================================ player ================================ */

const video = $('#video');
let player = null;
let retries = 0;
let statsTimer = null;
let idleTimer = null;

function supportsLive() {
  return window.mpegts && mpegts.getFeatureList().mseLivePlayback;
}

function openPlayer(id) {
  const ch = state.byId.get(id);
  if (!ch) return;

  if (!supportsLive()) {
    toast('הדפדפן הזה לא תומך בנגינת MPEG-TS. נסה Chrome, Edge או Firefox במחשב.', 'err');
    return;
  }

  state.current = ch;
  pushRecent(id);
  if (!state.visible.some((c) => c.id === id)) state.visible = computeVisible();

  $('#playerLayer').hidden = false;
  document.body.style.overflow = 'hidden';
  if (location.hash !== `#/watch/${id}`) history.replaceState(null, '', `#/watch/${id}`);

  $('#pName').textContent = ch.nameHe || ch.name;
  $('#pName').title = ch.name;
  const quality = $('#pQuality');
  quality.hidden = !ch.quality;
  quality.textContent = ch.quality || '';
  quality.className = `badge ${ch.quality === '4K' ? 'q4k' : 'qhd'}`;
  const logo = logoUrl(ch);
  $('#pLogo').src = logo || '';
  $('#pLogo').style.display = logo ? '' : 'none';
  $('#pNow').textContent = ch.name;
  $('#pStats').textContent = '';

  renderPanelList();
  loadEpgPanel(ch.id);
  startStream(ch);
  armIdle();
}

function destroyStream() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (player) {
    try { player.pause(); } catch { /* ignore */ }
    try { player.unload(); } catch { /* ignore */ }
    try { player.detachMediaElement(); } catch { /* ignore */ }
    try { player.destroy(); } catch { /* ignore */ }
    player = null;
  }
}

function startStream(ch) {
  destroyStream();
  $('#spinner').hidden = false;
  $('#stageError').hidden = true;
  $('#bigPlay').hidden = true;

  player = mpegts.createPlayer({
    type: 'mpegts',
    isLive: true,
    // Absolute: mpegts.js fetches from a worker, where relative URLs do not resolve.
    url: `${location.origin}${withPlaylist(`/stream/${ch.id}`)}`,
  }, {
    enableWorker: true,
    enableStashBuffer: false,
    stashInitialSize: 192,
    lazyLoad: false,
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 5,
    liveBufferLatencyMinRemain: 0.4,
    autoCleanupSourceBuffer: true,
    reuseRedirectedURL: true,
  });

  player.attachMediaElement(video);

  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    console.warn('[player]', type, detail, info);
    if (retries < 3) {
      retries += 1;
      $('#spinner').hidden = false;
      setTimeout(() => { if (state.current) startStream(state.current); }, 1200 * retries);
      return;
    }
    showStreamError(type, detail);
  });

  player.on(mpegts.Events.MEDIA_INFO, (info) => {
    retries = 0;
    if (info?.width) $('#pStats').textContent = `${info.width}×${info.height}`;
  });

  player.load();

  const volume = readStore(STORE.volume, 1);
  video.volume = Math.min(1, Math.max(0, volume));
  video.muted = readStore(STORE.muted, false);
  syncVolumeUi();

  video.play().then(() => {
    $('#spinner').hidden = true;
  }).catch(() => {
    // Autoplay with sound is blocked - offer a manual start.
    $('#spinner').hidden = true;
    $('#bigPlay').hidden = false;
  });

  statsTimer = setInterval(updateStats, 1000);
}

function updateStats() {
  if (!player) return;
  const info = player.mediaInfo || {};
  const stats = player.statisticsInfo || {};
  const parts = [];
  if (info.width) parts.push(`${info.width}×${info.height}`);
  if (stats.speed) parts.push(`${(stats.speed / 125).toFixed(1)} Mb/s`);
  const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
  if (buffered > 0) parts.push(`באפר ${buffered.toFixed(1)} שנ׳`);
  $('#pStats').textContent = parts.join(' · ');
  $('#liveBtn').classList.toggle('behind', buffered > 8);
}

function showStreamError(type, detail) {
  $('#spinner').hidden = true;
  $('#stageError').hidden = false;
  const limited = state.account && state.account.maxConnections <= 1;
  $('#errTitle').textContent = 'לא מצליחים לנגן את הערוץ';
  $('#errText').textContent = detail === 'HttpStatusCodeInvalid'
    ? 'הספק סירב לשידור. ייתכן שהערוץ אינו זמין כרגע.'
    : `${type || 'שגיאה'}: ${detail || 'השידור נקטע'}${limited ? ' · שים לב: המנוי מאפשר חיבור אחד בלבד בכל רגע.' : ''}`;
}

function closePlayer() {
  destroyStream();
  $('#playerLayer').hidden = true;
  document.body.style.overflow = '';
  state.current = null;
  retries = 0;
  if (location.hash.startsWith('#/watch/')) history.replaceState(null, '', location.pathname + (state.filter === 'all' ? '' : `#/${state.filter}`));
  render();
}

function zap(step) {
  if (!state.current) return;
  const list = state.visible.length ? state.visible : state.channels;
  const index = list.findIndex((c) => c.id === state.current.id);
  const next = list[(index + step + list.length) % list.length];
  if (next) { retries = 0; openPlayer(next.id); }
}

/* --------------------------------------------------------- player panel --- */

function renderPanelList() {
  const box = $('#panelList');
  box.innerHTML = '';
  const list = state.visible.length ? state.visible : state.channels;
  for (const ch of list) {
    const btn = document.createElement('button');
    btn.className = 'plist-item' + (state.current && ch.id === state.current.id ? ' active' : '');
    const logo = logoUrl(ch);
    btn.innerHTML = `<span class="lg">${logo ? `<img loading="lazy" alt="" src="${logo}">` : ''}</span><span class="nm"></span>${ch.quality ? `<span class="badge ${ch.quality === '4K' ? 'q4k' : 'qhd'}">${ch.quality}</span>` : ''}`;
    btn.querySelector('.nm').textContent = ch.nameHe || ch.name;
    btn.addEventListener('click', () => { retries = 0; openPlayer(ch.id); });
    box.appendChild(btn);
  }
  const active = box.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'center' });
}

async function loadEpgPanel(id) {
  const nowBox = $('#epgNow');
  const listBox = $('#epgList');
  nowBox.innerHTML = '<div class="panel-note">טוען לוח שידורים…</div>';
  listBox.innerHTML = '';

  try {
    const epg = await epgFor(id);
    if (state.current?.id !== id) return;

    if (epg.now) {
      const pct = Math.min(100, ((Date.now() - epg.now.start) / (epg.now.end - epg.now.start)) * 100);
      nowBox.innerHTML = `
        <div class="k">עכשיו בשידור</div>
        <h4></h4>
        <div class="t">${clock(epg.now.start)} – ${clock(epg.now.end)}</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <p></p>`;
      nowBox.querySelector('h4').textContent = epg.now.title;
      nowBox.querySelector('p').textContent = epg.now.description || '';
      $('#pNow').textContent = `עכשיו: ${epg.now.title}`;
    } else {
      nowBox.innerHTML = '<div class="panel-note">אין נתוני שידור לערוץ הזה</div>';
      $('#pNow').textContent = state.current?.name || '';
    }

    if (epg.upcoming?.length) {
      for (const show of epg.upcoming) {
        const row = document.createElement('div');
        row.className = 'epg-item';
        row.innerHTML = '<span class="time"></span><span class="ttl"></span>';
        row.querySelector('.time').textContent = clock(show.start);
        row.querySelector('.ttl').textContent = show.title;
        row.title = show.description || '';
        listBox.appendChild(row);
      }
    }
  } catch {
    nowBox.innerHTML = '<div class="panel-note">לוח השידורים אינו זמין</div>';
  }
}

/* -------------------------------------------------------------- volume --- */

function syncVolumeUi() {
  $('#volume').value = String(video.muted ? 0 : video.volume);
  $('#muteBtn').querySelector('.i-vol').hidden = video.muted || video.volume === 0;
  $('#muteBtn').querySelector('.i-mute').hidden = !(video.muted || video.volume === 0);
}

/* ---------------------------------------------------------- idle timer --- */

function armIdle() {
  clearTimeout(idleTimer);
  $('#playerLayer').classList.remove('idle');
  idleTimer = setTimeout(() => {
    if (!video.paused) $('#playerLayer').classList.add('idle');
  }, 3200);
}

/* --------------------------------------------------------------- modes --- */

function setMode(mode) {
  // A hash someone typed by hand must not open a section they do not have.
  if (mode === 'vod' && !access().vod) mode = 'live';
  if (mode === 'live' && !access().live) mode = 'vod';
  state.mode = mode;
  $$('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#liveView').hidden = mode !== 'live';
  $('#vodView').hidden = mode !== 'vod';

  const search = $('#search');
  search.value = '';
  state.query = '';
  $('#searchClear').hidden = true;
  search.placeholder = mode === 'vod' ? 'חפש סרט או סדרה…  (לחץ /)' : 'חיפוש ערוץ…  (לחץ /)';

  renderNav();
  if (mode === 'vod') window.SL.vod.enter();
  else render();
}

/* ------------------------------------------------------------- routing --- */

function applyRoute() {
  const hash = location.hash.replace(/^#\/?/, '');

  if (hash.startsWith('vod') || hash.startsWith('title/')) {
    setMode('vod');
    window.SL.vod.applyRoute(hash);
    return;
  }

  if (state.mode !== 'live') setMode('live');

  if (hash.startsWith('watch/')) {
    const id = Number(hash.slice(6));
    if (state.byId.has(id)) setTimeout(() => openPlayer(id), 60);
    return;
  }

  const known = ['all', 'favorites', 'recent'].includes(hash) || state.genres.some((g) => `genre:${g.id}` === hash);
  state.filter = known ? hash : 'all';
}

/* --------------------------------------------------------------- events --- */

function wireEvents() {
  // search
  const search = $('#search');
  let searchTimer = null;
  search.addEventListener('input', () => {
    $('#searchClear').hidden = !search.value;
    clearTimeout(searchTimer);
    const vod = state.mode === 'vod';
    searchTimer = setTimeout(() => {
      if (vod) { window.SL.vod.search(search.value.trim()); return; }
      state.query = search.value.trim();
      render();
    }, vod ? 380 : 130);
  });
  $('#searchClear').addEventListener('click', () => {
    search.value = ''; state.query = ''; $('#searchClear').hidden = true;
    if (state.mode === 'vod') window.SL.vod.search(''); else render();
    search.focus();
  });

  // account
  $('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });
  $('#playlistPicker').addEventListener('change', (ev) => {
    state.playlistId = ev.target.value;
    writeStore('smartlive.playlist', state.playlistId);
    location.reload();
  });

  // mode switch
  $$('#modeSwitch button').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.mode;
    if (state.mode === mode) return;
    setMode(mode);
    closeSidebar();
    history.replaceState(null, '', mode === 'vod' ? '#/vod' : location.pathname);
  }));

  // sort / view
  $$('#sortSeg button').forEach((b) => b.addEventListener('click', () => {
    state.sort = b.dataset.sort; writeStore(STORE.sort, state.sort); render();
  }));
  $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view; writeStore(STORE.view, state.view); render();
  }));

  // refresh
  $('#refreshBtn').addEventListener('click', async () => {
    const btn = $('#refreshBtn');
    btn.classList.add('spin');
    try {
      await fetch('/api/refresh', { method: 'POST' });
      epgCache.clear();
      const catalog = await getJSON('/api/channels');
      state.channels = catalog.channels;
      state.byId = new Map(catalog.channels.map((c) => [c.id, c]));
      state.genres = catalog.genres;
      renderNav(); render(); loadAccount();
      toast('הרשימה עודכנה', 'ok');
    } catch (err) {
      toast(`רענון נכשל: ${err.message}`, 'err');
    } finally {
      btn.classList.remove('spin');
    }
  });

  // mobile sidebar
  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#scrim').classList.add('on');
  });
  $('#scrim').addEventListener('click', closeSidebar);

  // player controls
  $('#closePlayer').addEventListener('click', closePlayer);
  $('#playPause').addEventListener('click', togglePlay);
  $('#bigPlay').addEventListener('click', () => {
    video.play().then(() => { $('#bigPlay').hidden = true; }).catch(() => {
      video.muted = true; syncVolumeUi();
      video.play().then(() => { $('#bigPlay').hidden = true; toast('השידור הופעל בהשתקה — לחץ על הרמקול לביטול ההשתקה'); }).catch(() => {});
    });
  });
  $('#retryBtn').addEventListener('click', () => { retries = 0; if (state.current) startStream(state.current); });
  $('#prevCh').addEventListener('click', () => zap(-1));
  $('#nextCh').addEventListener('click', () => zap(1));
  $('#liveBtn').addEventListener('click', jumpToLive);
  $('#muteBtn').addEventListener('click', () => {
    video.muted = !video.muted; writeStore(STORE.muted, video.muted); syncVolumeUi();
  });
  $('#volume').addEventListener('input', (ev) => {
    video.volume = Number(ev.target.value);
    video.muted = video.volume === 0;
    writeStore(STORE.volume, video.volume);
    writeStore(STORE.muted, video.muted);
    syncVolumeUi();
  });
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  $('#pipBtn').addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { toast('תמונה בתוך תמונה לא נתמכת בדפדפן הזה'); }
  });
  $('#togglePanel').addEventListener('click', () => $('#playerPanel').classList.toggle('collapsed'));
  $$('.panel-tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.panel-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('#panelEpg').hidden = b.dataset.tab !== 'epg';
    $('#panelList').hidden = b.dataset.tab !== 'list';
  }));

  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFullscreen);
  video.addEventListener('playing', () => { $('#spinner').hidden = true; $('#bigPlay').hidden = true; updatePlayIcon(); });
  video.addEventListener('waiting', () => { $('#spinner').hidden = false; });
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('volumechange', syncVolumeUi);

  $('#stage').addEventListener('mousemove', armIdle);
  $('#controls').addEventListener('mouseenter', () => { clearTimeout(idleTimer); $('#playerLayer').classList.remove('idle'); });

  // keyboard
  document.addEventListener('keydown', (ev) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (ev.key === '/' && !typing) { ev.preventDefault(); $('#search').focus(); return; }
    if (typing) { if (ev.key === 'Escape') document.activeElement.blur(); return; }

    if (!$('#vodLayer').hidden) {
      if (ev.key === 'Escape') window.SL.vod.close();
      return;
    }

    const playing = !$('#playerLayer').hidden;
    if (ev.key === 'Escape' && playing) { closePlayer(); return; }
    if (!playing) return;

    switch (ev.key) {
      case ' ': case 'k': ev.preventDefault(); togglePlay(); break;
      case 'f': toggleFullscreen(); break;
      case 'm': video.muted = !video.muted; writeStore(STORE.muted, video.muted); syncVolumeUi(); break;
      case 'ArrowUp': ev.preventDefault(); zap(-1); break;
      case 'ArrowDown': ev.preventDefault(); zap(1); break;
      case 'ArrowRight': video.volume = Math.min(1, video.volume + 0.08); writeStore(STORE.volume, video.volume); break;
      case 'ArrowLeft': video.volume = Math.max(0, video.volume - 0.08); writeStore(STORE.volume, video.volume); break;
      default: break;
    }
    armIdle();
  });

  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#/watch/') || location.hash.startsWith('#/title/')) return;
    applyRoute();
    if (state.mode === 'live') render();
  });

  // keep the "now playing" line fresh
  setInterval(() => {
    if (state.current) {
      epgCache.delete(state.current.id);
      loadEpgPanel(state.current.id);
    }
  }, 5 * 60 * 1000);
}

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  updatePlayIcon();
  armIdle();
}

function updatePlayIcon() {
  $('#playPause').querySelector('.i-play').hidden = !video.paused;
  $('#playPause').querySelector('.i-pause').hidden = video.paused;
}

function jumpToLive() {
  if (!video.buffered.length) return;
  video.currentTime = Math.max(0, video.buffered.end(video.buffered.length - 1) - 0.4);
  video.play().catch(() => {});
}

function toggleFullscreen() {
  const el = $('#playerLayer');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
}

// Shared surface for js/vod.js (movies & series section).
window.SL = { $, $$, toast, getJSON, readStore, writeStore, state, setMode, clock };

wireEvents();
boot();
