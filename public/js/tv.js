/* =========================================================================
   SmartLive TV — remote-driven UI.
   Everything is reachable with a D-pad: focus moves geometrically, OK opens,
   BACK goes up one level. No pointer, no hover, no small targets.
   ========================================================================= */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  playlistId: null,
  channels: [],
  byId: new Map(),
  genres: [],
  shelves: [],
  section: 'home',
  recent: readStore('smartlive.tv.recent', []),
  screen: 'login',
  // live player
  player: null,
  current: null,
  zapOpen: false,
  // vod
  vod: null,
  episodes: null,
  season: 1,
  episode: 1,
};

function readStore(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function withPlaylist(url) {
  if (!state.playlistId) return url;
  return url + (url.includes('?') ? '&' : '?') + `playlist=${encodeURIComponent(state.playlistId)}`;
}

async function api(url) {
  const res = await fetch(withPlaylist(url), { headers: { Accept: 'application/json' } });
  if (res.status === 401) { showScreen('login'); throw new Error('unauthorized'); }
  if (!res.ok) {
    let message = `שגיאה ${res.status}`;
    try { message = (await res.json()).error || message; } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json();
}

let toastTimer = null;
function toast(message) {
  const el = $('#tvToast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ==================================================== spatial navigation === */

const FOCUSABLE = '.focusable, .card, .nav-item, .zap-item, .ep-card, .season-chip';

function isVisible(el) {
  if (el.hidden || el.disabled) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  return !el.closest('[hidden]');
}

function candidates() {
  return $$(FOCUSABLE).filter(isVisible);
}

function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  onFocusChanged(el);
}

/**
 * Pick the nearest focusable in a direction: distance along the axis matters
 * most, drift across it is penalised, and anything behind us is ignored.
 */
function move(direction) {
  const current = document.activeElement;
  const list = candidates();
  if (!current || !list.includes(current)) { focusEl(list[0]); return; }

  const a = current.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;

  let best = null;
  let bestScore = Infinity;

  for (const el of list) {
    if (el === current) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;

    let along;
    let across;
    if (direction === 'left') { along = -dx; across = Math.abs(dy); }
    else if (direction === 'right') { along = dx; across = Math.abs(dy); }
    else if (direction === 'up') { along = -dy; across = Math.abs(dx); }
    else { along = dy; across = Math.abs(dx); }

    if (along < 6) continue;                       // not in that direction
    if (across > along * 2.2 + window.innerHeight * 0.12) continue;  // too far off-axis

    const score = along + across * 2.4;
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) focusEl(best);
}

function onFocusChanged(el) {
  // The rail sidebar only shows its labels while it has focus.
  $('#tvNav')?.classList.toggle('open', Boolean(el.closest?.('.sidebar')));
  if (el.dataset?.heroTitle) updateHero(el.dataset);
}

/* ================================================================ screens === */

function showScreen(name) {
  state.screen = name;
  for (const id of ['loginScreen', 'homeScreen', 'liveScreen', 'vodScreen']) {
    $(`#${id}`).hidden = id !== `${name}Screen`;
  }
  if (name === 'login') setTimeout(() => focusEl($('#loginUser')), 50);
}

function back() {
  if (state.screen === 'live') {
    if (state.zapOpen) { closeZap(); return; }
    stopLive();
    showScreen('home');
    restoreHomeFocus();
    return;
  }
  if (state.screen === 'vod') {
    if (!$('#epPicker').hidden && state.episodes) { $('#epPicker').hidden = true; }
    closeVod();
    showScreen('home');
    restoreHomeFocus();
    return;
  }
  if (state.screen === 'home') {
    const nav = $('.nav-item.active');
    if (document.activeElement?.closest('.sidebar')) return;  // already at the root
    focusEl(nav || $('.nav-item'));
  }
}

let lastHomeFocus = null;
function restoreHomeFocus() {
  if (lastHomeFocus && isVisible(lastHomeFocus)) focusEl(lastHomeFocus);
  else focusEl($('#rails .card') || $('.nav-item'));
}

/* ================================================================== login === */

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  const error = $('#loginError');
  error.hidden = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ההתחברות נכשלה');
    state.user = data.user;
    $('#loginPass').value = '';
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

/* =================================================================== boot === */

async function boot() {
  $('#serverHint').textContent = location.host;
  try {
    const me = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (!me.ok) { showScreen('login'); return; }
    state.user = (await me.json()).user;
    await enterApp();
  } catch {
    showScreen('login');
  }
}

/** What this account may watch; everything is allowed until we know better. */
const access = () => state.user?.access || { live: true, vod: true, genres: [] };

async function enterApp() {
  const playlists = state.user?.playlists || [];
  state.playlistId = playlists[0]?.id || null;

  // Hide the menu entries this account does not have, so the remote never
  // lands on a section that would only answer "not included".
  for (const btn of $$('.nav-item')) {
    const nav = btn.dataset.nav;
    if (nav === 'live') btn.hidden = !access().live;
    if (nav === 'movies' || nav === 'series') btn.hidden = !access().vod;
  }

  showScreen('home');
  await loadLibrary();
  renderSection('home');
}

async function loadLibrary() {
  const jobs = [];

  if (state.playlistId && access().live) {
    jobs.push(api('/api/channels').then((catalog) => {
      state.channels = catalog.channels;
      state.byId = new Map(catalog.channels.map((c) => [c.id, c]));
      state.genres = catalog.genres;
    }).catch((err) => toast(`טעינת הערוצים נכשלה: ${err.message}`)));
  }

  if (access().vod) {
    jobs.push(api('/api/vod/shelves').then((shelves) => { state.shelves = shelves; })
      .catch(() => { /* the VOD section just stays empty */ }));
  }

  await Promise.all(jobs);
}

/* ================================================================== rails === */

function channelCard(ch) {
  const card = document.createElement('button');
  card.className = 'card live';
  card.type = 'button';
  card.dataset.kind = 'channel';
  card.dataset.id = String(ch.id);
  card.dataset.heroTitle = ch.nameHe || ch.name;
  card.dataset.heroKicker = 'שידור חי';
  card.dataset.heroMeta = [ch.name, ch.quality].filter(Boolean).join(' · ');
  card.dataset.heroArt = ch.logo || '';
  card.innerHTML = `
    <div class="card-art">
      ${ch.logo ? `<img loading="lazy" alt="" src="${ch.logo}">` : `<span class="card-fallback">${ch.name}</span>`}
      ${ch.quality ? `<span class="badge-tv">${ch.quality}</span>` : ''}
    </div>
    <div class="card-label"></div>
    <div class="card-sub"></div>`;
  card.querySelector('.card-label').textContent = ch.nameHe || ch.name;
  card.querySelector('.card-sub').textContent = ch.nameHe ? ch.name : '';
  card.querySelector('img')?.addEventListener('error', (ev) => {
    const art = ev.target.closest('.card-art');
    ev.target.remove();
    art.insertAdjacentHTML('afterbegin', `<span class="card-fallback">${ch.name}</span>`);
  });
  card.addEventListener('click', () => playChannel(ch.id));
  return card;
}

function posterCard(item) {
  const card = document.createElement('button');
  card.className = 'card poster';
  card.type = 'button';
  card.dataset.kind = 'vod';
  card.dataset.id = item.id;
  card.dataset.type = item.type;
  card.dataset.heroTitle = item.title;
  card.dataset.heroKicker = item.type === 'tv' ? 'סדרה' : 'סרט';
  card.dataset.heroMeta = [item.year, item.cast].filter(Boolean).join(' · ');
  card.dataset.heroArt = item.posterLarge || item.poster || '';
  card.innerHTML = `
    <div class="card-art">
      ${item.poster ? `<img loading="lazy" alt="" src="${item.poster}">` : '<span class="card-fallback">🎞️</span>'}
    </div>
    <div class="card-label"></div>
    <div class="card-sub"></div>`;
  card.querySelector('.card-label').textContent = item.title;
  card.querySelector('.card-sub').textContent = item.year || '';
  card.addEventListener('click', () => openVod(item));
  return card;
}

function buildRail(title, nodes) {
  if (!nodes.length) return null;
  const rail = document.createElement('section');
  rail.className = 'rail';
  rail.innerHTML = '<h2 class="rail-title"></h2><div class="rail-row"></div>';
  rail.querySelector('.rail-title').textContent = title;
  const row = rail.querySelector('.rail-row');
  for (const node of nodes) row.appendChild(node);
  return rail;
}

function renderSection(section) {
  state.section = section;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === section));
  $('#searchBar').hidden = section !== 'search';

  const rails = $('#rails');
  rails.innerHTML = '';
  const add = (rail) => { if (rail) rails.appendChild(rail); };

  if (section === 'search') {
    setTimeout(() => focusEl($('#searchInput')), 60);
    return;
  }

  if (section === 'home' || section === 'live') {
    if (section === 'home' && state.recent.length) {
      const nodes = state.recent
        .map((entry) => (entry.kind === 'channel' ? state.byId.get(entry.id) : null))
        .filter(Boolean)
        .map(channelCard);
      add(buildRail('ממשיכים לצפות', nodes));
    }
    for (const genre of state.genres) {
      const nodes = state.channels.filter((c) => c.genre === genre.id).slice(0, 24).map(channelCard);
      add(buildRail(`${genre.icon} ${genre.label}`, nodes));
    }
    if (!state.channels.length) {
      rails.innerHTML = '<p class="rail-title">אין פלייליסט מקושר לחשבון הזה.</p>';
    }
  }

  if (section === 'home' || section === 'movies' || section === 'series') {
    const wanted = section === 'movies' ? 'movie' : (section === 'series' ? 'tv' : null);
    for (const shelf of state.shelves) {
      if (wanted && shelf.kind !== wanted) continue;
      add(buildRail(shelf.title, shelf.items.map(posterCard)));
    }
  }

  $('#stageScroll').scrollTop = 0;
  const first = $('#rails .card');
  if (first) { focusEl(first); lastHomeFocus = first; }
}

/* =================================================================== hero === */

let heroTimer = null;
function updateHero(data) {
  clearTimeout(heroTimer);
  heroTimer = setTimeout(() => {
    $('#heroKicker').textContent = data.heroKicker || 'SmartLive';
    $('#heroTitle').textContent = data.heroTitle || '';
    $('#heroMeta').textContent = data.heroMeta || '';
    $('#heroDesc').textContent = '';

    const bg = $('#heroBg');
    const art = data.heroArt || '';
    const isChannel = data.kind === 'channel';
    bg.style.backgroundImage = art ? `url("${art}")` : 'none';
    bg.classList.toggle('is-logo', Boolean(art) && isChannel);
    bg.classList.toggle('is-poster', Boolean(art) && !isChannel);
    bg.classList.toggle('is-empty', !art);

    const poster = $('#heroPoster');
    poster.hidden = isChannel || !art;
    if (!poster.hidden) poster.src = art;

    // Channels get their "now playing" line from the EPG, lazily.
    if (data.kind === 'channel') {
      const id = Number(data.id);
      api(`/api/epg/${id}`).then((epg) => {
        if (Number($('#rails .card:focus')?.dataset.id) !== id) return;
        if (epg.now) {
          $('#heroDesc').textContent = epg.now.description || '';
          $('#heroMeta').textContent = `עכשיו: ${epg.now.title}`;
        }
      }).catch(() => {});
    }
  }, 180);
}

/* ============================================================ live player === */

function playChannel(id) {
  const ch = state.byId.get(id);
  if (!ch) return;
  if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) {
    toast('הנגן לא נתמך במכשיר הזה');
    return;
  }

  lastHomeFocus = document.activeElement;
  state.current = ch;
  remember({ kind: 'channel', id: ch.id });

  showScreen('live');
  $('#poName').textContent = ch.nameHe || ch.name;
  $('#poNow').textContent = ch.name;
  $('#poLogo').src = ch.logo || '';
  $('#poLogo').style.display = ch.logo ? '' : 'none';
  $('#playerError').hidden = true;
  $('#buffering').hidden = false;

  api(`/api/epg/${ch.id}`).then((epg) => {
    if (state.current?.id === ch.id && epg.now) $('#poNow').textContent = `עכשיו: ${epg.now.title}`;
  }).catch(() => {});

  startStream(ch);
  showOverlay();
}

let retries = 0;
function startStream(ch) {
  stopLive(true);
  const video = $('#tvVideo');

  state.player = mpegts.createPlayer({
    type: 'mpegts',
    isLive: true,
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
  });

  state.player.attachMediaElement(video);
  state.player.on(mpegts.Events.ERROR, (type, detail) => {
    if (retries < 3) {
      retries += 1;
      setTimeout(() => { if (state.current) startStream(state.current); }, 1200 * retries);
      return;
    }
    $('#buffering').hidden = true;
    $('#playerError').hidden = false;
    $('#playerErrorText').textContent = `${type || ''} ${detail || ''}`.trim() || 'השידור נקטע';
    focusEl($('#retryBtn'));
  });
  state.player.on(mpegts.Events.MEDIA_INFO, () => { retries = 0; });

  state.player.load();
  video.play().catch(() => {});
}

function stopLive(keepScreen) {
  const player = state.player;
  state.player = null;
  if (player) {
    try { player.pause(); player.unload(); player.detachMediaElement(); player.destroy(); } catch { /* ignore */ }
  }
  if (!keepScreen) { state.current = null; retries = 0; closeZap(); }
}

$('#tvVideo').addEventListener('playing', () => { $('#buffering').hidden = true; });
$('#tvVideo').addEventListener('waiting', () => { $('#buffering').hidden = false; });
$('#retryBtn').addEventListener('click', () => { retries = 0; if (state.current) { $('#playerError').hidden = true; startStream(state.current); } });

let overlayTimer = null;
function showOverlay() {
  $('#liveOverlay').classList.remove('hide');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => $('#liveOverlay').classList.add('hide'), 4500);
}

function zap(step) {
  if (!state.current) return;
  const list = state.channels;
  const index = list.findIndex((c) => c.id === state.current.id);
  const next = list[(index + step + list.length) % list.length];
  if (next) { retries = 0; playChannel(next.id); }
}

function openZap() {
  const box = $('#zapList');
  box.innerHTML = '';
  for (const ch of state.channels) {
    const row = document.createElement('button');
    row.className = 'zap-item' + (ch.id === state.current?.id ? ' playing' : '');
    row.type = 'button';
    row.innerHTML = `${ch.logo ? `<img loading="lazy" alt="" src="${ch.logo}">` : ''}<span></span>`;
    row.querySelector('span').textContent = ch.nameHe || ch.name;
    row.addEventListener('click', () => { closeZap(); playChannel(ch.id); });
    box.appendChild(row);
  }
  box.hidden = false;
  state.zapOpen = true;
  const playing = box.querySelector('.playing') || box.firstElementChild;
  focusEl(playing);
}

function closeZap() {
  $('#zapList').hidden = true;
  state.zapOpen = false;
}

/* ============================================================= vod player === */

async function openVod(item) {
  lastHomeFocus = document.activeElement;
  state.vod = item;
  state.episodes = null;
  showScreen('vod');
  $('#vodHeadTitle').textContent = item.title;
  $('#epPicker').hidden = true;
  remember({ kind: 'vod', id: item.id, type: item.type, title: item.title, poster: item.poster });

  if (item.type === 'tv') {
    try {
      const data = await api(`/api/vod/episodes/${item.id}`);
      if (state.vod?.id !== item.id) return;
      if (data.found && data.seasons.length) {
        state.episodes = data;
        const saved = readStore(`smartlive.tv.progress.${item.id}`, null);
        state.season = saved?.season || data.seasons[0].season;
        state.episode = saved?.episode || 1;
        renderEpisodePicker();
        $('#epPicker').hidden = false;
      }
    } catch { /* fall through to S1E1 */ }
  }

  mountVodFrame();
}

function renderEpisodePicker() {
  const seasonsBox = $('#epSeasons');
  seasonsBox.innerHTML = '';
  for (const season of state.episodes.seasons) {
    const chip = document.createElement('button');
    chip.className = 'season-chip' + (season.season === state.season ? ' active' : '');
    chip.type = 'button';
    chip.textContent = `עונה ${season.season}`;
    chip.addEventListener('click', () => {
      state.season = season.season;
      state.episode = season.episodes[0]?.number || 1;
      renderEpisodePicker();
    });
    seasonsBox.appendChild(chip);
  }

  const rail = $('#epRail');
  rail.innerHTML = '';
  const season = state.episodes.seasons.find((s) => s.season === state.season);
  for (const ep of season?.episodes || []) {
    const card = document.createElement('button');
    card.className = 'ep-card' + (ep.number === state.episode ? ' playing' : '');
    card.type = 'button';
    card.innerHTML = `<span class="thumb">${ep.image ? `<img loading="lazy" alt="" src="${ep.image}">` : ep.number}</span><span class="t"></span>`;
    card.querySelector('.t').textContent = `${ep.number}. ${ep.name}`;
    card.addEventListener('click', () => {
      state.episode = ep.number;
      writeStore(`smartlive.tv.progress.${state.vod.id}`, { season: state.season, episode: ep.number });
      renderEpisodePicker();
      mountVodFrame();
      $('#epPicker').hidden = true;
    });
    rail.appendChild(card);
  }
  $('#epPickerTitle').textContent = `${state.vod.title} · עונה ${state.season}`;
}

function mountVodFrame() {
  const holder = $('#vodFrame');
  holder.innerHTML = '';
  const item = state.vod;
  const src = item.type === 'tv'
    ? `/play/tv/${item.id}/${state.season}/${state.episode}`
    : `/play/movie/${item.id}`;

  const frame = document.createElement('iframe');
  frame.src = src;
  frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
  frame.setAttribute('referrerpolicy', 'origin');
  frame.setAttribute('allowfullscreen', '');
  holder.appendChild(frame);
}

function closeVod() {
  $('#vodFrame').innerHTML = '';
  state.vod = null;
  state.episodes = null;
}

/* ================================================================ search === */

let searchTimer = null;
$('#searchInput').addEventListener('input', (ev) => {
  const query = ev.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(query), 450);
});

async function runSearch(query) {
  const rails = $('#rails');
  if (query.length < 2) { rails.innerHTML = ''; return; }

  const channels = state.channels
    .filter((c) => c.searchText.includes(query.toLowerCase()))
    .slice(0, 20)
    .map(channelCard);

  rails.innerHTML = '';
  if (channels.length) rails.appendChild(buildRail('ערוצים', channels));

  try {
    const results = await api(`/api/vod/search?q=${encodeURIComponent(query)}`);
    const rail = buildRail('סרטים וסדרות', results.map(posterCard));
    if (rail) rails.appendChild(rail);
  } catch { /* search is best-effort */ }

  if (!rails.children.length) rails.innerHTML = '<p class="rail-title">לא נמצאו תוצאות</p>';
}

/* ================================================================ recent === */

function remember(entry) {
  state.recent = [entry, ...state.recent.filter((x) => !(x.kind === entry.kind && x.id === entry.id))].slice(0, 20);
  writeStore('smartlive.tv.recent', state.recent);
}

/* ================================================================== keys === */

const BACK_KEYS = new Set(['Backspace', 'Escape', 'BrowserBack', 'GoBack', 'XF86Back']);
const OK_KEYS = new Set(['Enter', 'NumpadEnter', 'Select', ' ']);

document.addEventListener('keydown', (ev) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if (BACK_KEYS.has(ev.key)) {
    if (typing && ev.key === 'Backspace') return;   // let the field delete
    ev.preventDefault();
    back();
    return;
  }

  if (state.screen === 'live') showOverlay();

  switch (ev.key) {
    case 'ArrowUp':
      ev.preventDefault();
      if (state.screen === 'live' && !state.zapOpen) zap(-1); else move('up');
      break;
    case 'ArrowDown':
      ev.preventDefault();
      if (state.screen === 'live' && !state.zapOpen) zap(1); else move('down');
      break;
    case 'ArrowLeft':
      if (typing) return;
      ev.preventDefault();
      move('left');
      break;
    case 'ArrowRight':
      if (typing) return;
      ev.preventDefault();
      move('right');
      break;
    case 'MediaTrackNext': zap(1); break;
    case 'MediaTrackPrevious': zap(-1); break;
    default:
      if (OK_KEYS.has(ev.key)) {
        if (state.screen === 'live' && !state.zapOpen && !typing) { ev.preventDefault(); openZap(); return; }
        if (state.screen === 'vod' && !typing && state.episodes) { ev.preventDefault(); $('#epPicker').hidden = false; focusEl($('.ep-card.playing') || $('.ep-card')); return; }
        if (!typing && document.activeElement?.click) { ev.preventDefault(); document.activeElement.click(); }
      }
  }
});

document.addEventListener('focusin', (ev) => onFocusChanged(ev.target));

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => {
  const nav = btn.dataset.nav;
  if (nav === 'logout') {
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => location.reload());
    return;
  }
  renderSection(nav);
}));

// The Android wrapper routes the TV remote's BACK button here.
window.SLTV = {
  back,
  atRoot: () => state.screen === 'home' && Boolean(document.activeElement?.closest('.sidebar')),
};

boot();
