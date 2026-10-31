/* =========================================================================
   SmartLive — admin console: users and the playlists attached to them.
   ========================================================================= */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let users = [];

/* ------------------------------------------------------------- plumbing --- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('נדרשת התחברות'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 5000 : 2600);
}

const randomPassword = () => Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);

/* -------------------------------------------------------------- packages --- */

let genreList = [];

/** Draws the package chips, with `selected` ticked. Empty selection = all. */
function renderGenreChips(box, selected = []) {
  if (!box) return;
  box.innerHTML = '';
  for (const genre of genreList) {
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.innerHTML = `<input type="checkbox" value="${genre.id}"><span>${genre.icon} ${genre.label}</span>`;
    const input = chip.querySelector('input');
    input.checked = selected.includes(genre.id);
    chip.classList.toggle('on', input.checked);
    input.addEventListener('change', () => chip.classList.toggle('on', input.checked));
    box.appendChild(chip);
  }
}

const selectedGenres = (box) => $$('input:checked', box).map((i) => i.value);

function formatDate(value) {
  if (!value) return 'טרם התחבר';
  const d = new Date(value);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function playlistFields(form) {
  return {
    url: $('.pf-url', form)?.value.trim() || $('#nuUrl')?.value.trim(),
    name: $('.pf-name', form)?.value.trim() || $('#nuPlName')?.value.trim(),
    maxStreams: Number($('.pf-max', form)?.value || $('#nuMax')?.value || 1),
  };
}

async function testPlaylist(url, resultEl) {
  if (!url) { resultEl.textContent = 'אין קישור לבדוק'; resultEl.className = 'test-result bad'; return; }
  resultEl.textContent = 'בודק…';
  resultEl.className = 'test-result';
  try {
    const data = await api('/api/admin/playlists/test', { method: 'POST', body: { url } });
    if (data.ok) {
      const expiry = data.account.expiresAt ? new Date(data.account.expiresAt).toLocaleDateString('he-IL') : 'ללא הגבלה';
      resultEl.textContent = `תקין · ${data.channels} ערוצים · עד ${expiry} · ${data.account.maxConnections} חיבורים`;
      resultEl.className = 'test-result good';
    } else {
      resultEl.textContent = data.error || 'החיבור נכשל';
      resultEl.className = 'test-result bad';
    }
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'test-result bad';
  }
}

/* --------------------------------------------------------------- render --- */

function renderStats() {
  const admins = users.filter((u) => u.role === 'admin').length;
  const playlists = users.reduce((n, u) => n + u.playlists.length, 0);
  const withoutPlaylist = users.filter((u) => !u.playlists.length).length;

  $('#stats').innerHTML = [
    { label: 'משתמשים', value: users.length },
    { label: 'מנהלים', value: admins },
    { label: 'פלייליסטים', value: playlists },
    { label: 'בלי פלייליסט', value: withoutPlaylist, warn: withoutPlaylist > 0 },
  ].map((s) => `<div class="stat-card${s.warn ? ' warn' : ''}"><b>${s.value}</b><span>${s.label}</span></div>`).join('');
}

function renderPlaylist(playlist, card) {
  const node = $('#playlistTpl').content.cloneNode(true);
  const row = $('.playlist-row', node);
  const form = $('.pl-form', row);

  $('.pl-name', row).textContent = playlist.name;
  $('.pl-meta', row).textContent = `${playlist.host} · ${playlist.username} · ${playlist.maxStreams} חיבורים`;

  $('.pl-edit', row).addEventListener('click', () => {
    form.hidden = !form.hidden;
    $('.pf-url', form).value = `${playlist.host}/get.php?username=${playlist.username}&password=${playlist.password}&type=m3u_plus`;
    $('.pf-name', form).value = playlist.name;
    $('.pf-max', form).value = playlist.maxStreams;
  });
  $('.pf-cancel', form).addEventListener('click', () => { form.hidden = true; });
  $('.pf-test', form).addEventListener('click', () => testPlaylist($('.pf-url', form).value.trim(), $('.pf-result', form)));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api(`/api/admin/playlists/${playlist.id}`, { method: 'PATCH', body: playlistFields(form) });
      toast('הפלייליסט עודכן', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('.pl-delete', row).addEventListener('click', async () => {
    if (!confirm(`להסיר את "${playlist.name}"?`)) return;
    try {
      await api(`/api/admin/playlists/${playlist.id}`, { method: 'DELETE' });
      toast('הפלייליסט הוסר', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('.playlists', card).appendChild(row);
}

function renderUser(user) {
  const node = $('#userTpl').content.cloneNode(true);
  const card = $('.user-card', node);
  const form = $('.edit-form', card);

  $('.avatar', card).textContent = (user.displayName || user.username).slice(0, 2).toUpperCase();
  $('.u-display', card).textContent = user.displayName || user.username;
  $('.u-username', card).textContent = user.username;
  $('.u-last', card).textContent = `כניסה אחרונה: ${formatDate(user.lastLoginAt)}`;

  const role = $('.u-role', card);
  role.textContent = user.role === 'admin' ? 'מנהל' : 'משתמש';
  role.classList.toggle('qhd', user.role === 'admin');

  const state = $('.u-state', card);
  state.textContent = user.active ? 'פעיל' : 'מושבת';
  state.classList.add(user.active ? 'ok-badge' : 'off-badge');

  $('.u-toggle', card).textContent = user.active ? 'השבת' : 'הפעל';
  $('.u-toggle', card).addEventListener('click', async () => {
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { active: !user.active } });
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  const access = user.access || { live: true, vod: true, genres: [] };
  const badges = $('.user-name', card);
  if (!access.live) badges.insertAdjacentHTML('beforeend', '<span class="badge off-badge">בלי לייב</span>');
  if (!access.vod) badges.insertAdjacentHTML('beforeend', '<span class="badge off-badge">בלי VOD</span>');
  if (access.genres.length) {
    badges.insertAdjacentHTML('beforeend', `<span class="badge">${access.genres.length} חבילות</span>`);
  }

  $('.u-edit', card).addEventListener('click', () => {
    form.hidden = !form.hidden;
    $('.e-display', form).value = user.displayName || '';
    $('.e-role', form).value = user.role;
    $('.e-password', form).value = '';
    $('.e-live', form).checked = access.live;
    $('.e-vod', form).checked = access.vod;
    renderGenreChips($('.e-genres', form), access.genres);
  });
  $('.e-cancel', form).addEventListener('click', () => { form.hidden = true; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const patch = {
      displayName: $('.e-display', form).value,
      role: $('.e-role', form).value,
      hasLive: $('.e-live', form).checked,
      hasVod: $('.e-vod', form).checked,
      genres: selectedGenres($('.e-genres', form)),
    };
    const password = $('.e-password', form).value.trim();
    if (password) patch.password = password;
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: patch });
      toast('המשתמש עודכן', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('.e-add-playlist', form).addEventListener('click', async () => {
    const url = prompt('הדבק את קישור הפלייליסט:');
    if (!url) return;
    try {
      await api(`/api/admin/users/${user.id}/playlists`, { method: 'POST', body: { url } });
      toast('הפלייליסט נוסף', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('.u-delete', card).addEventListener('click', async () => {
    if (!confirm(`למחוק את המשתמש ${user.username}? הפעולה אינה הפיכה.`)) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      toast('המשתמש נמחק', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  });

  if (!user.playlists.length) {
    const empty = document.createElement('p');
    empty.className = 'no-playlist';
    empty.textContent = 'לא מקושר פלייליסט — המשתמש לא יראה ערוצי לייב.';
    $('.playlists', card).appendChild(empty);
  } else {
    for (const playlist of user.playlists) renderPlaylist(playlist, card);
  }

  $('#users').appendChild(card);
}

function render() {
  renderStats();
  $('#users').innerHTML = '';
  for (const user of users) renderUser(user);
}

async function load() {
  users = await api('/api/admin/users');
  render();
}

/* ---------------------------------------------------------- create form --- */

const createForm = $('#createForm');

$('#newUserBtn').addEventListener('click', () => {
  createForm.hidden = !createForm.hidden;
  if (!createForm.hidden) {
    $('#nuPassword').value = randomPassword();
    $('#nuUsername').focus();
  }
});
$('#nuCancel').addEventListener('click', () => { createForm.hidden = true; });
$('#nuGen').addEventListener('click', () => { $('#nuPassword').value = randomPassword(); });
$('#nuTest').addEventListener('click', () => testPlaylist($('#nuUrl').value.trim(), $('#nuTestResult')));

createForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = {
    username: $('#nuUsername').value.trim(),
    displayName: $('#nuDisplay').value.trim(),
    password: $('#nuPassword').value,
    role: $('#nuRole').value,
    hasLive: $('#nuLive').checked,
    hasVod: $('#nuVod').checked,
    genres: selectedGenres($('#nuGenres')),
  };
  const url = $('#nuUrl').value.trim();
  if (url) body.playlist = { url, name: $('#nuPlName').value.trim(), maxStreams: Number($('#nuMax').value || 1) };

  try {
    await api('/api/admin/users', { method: 'POST', body });
    toast(`נוצר המשתמש ${body.username} (סיסמה: ${body.password})`, 'ok');
    createForm.reset();
    createForm.hidden = true;
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

api('/api/admin/genres')
  .then((list) => { genreList = list; renderGenreChips($('#nuGenres')); })
  .catch(() => { /* the chips just stay empty, which means "all packages" */ });

load().catch((err) => toast(err.message, 'err'));
