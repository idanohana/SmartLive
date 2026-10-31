/* =========================================================================
   SmartLive — movies & series
   Metadata from IMDb suggestions + TVmaze, playback through a sandboxed
   the upstream embed, reached through /play/... on this server.
   ========================================================================= */
'use strict';

(() => {
  const { $, $$, toast, getJSON, readStore, writeStore } = window.SL;

  const KEYS = {
    watchlist: 'smartlive.vod.watchlist',
    recent: 'smartlive.vod.recent',
    progress: 'smartlive.vod.progress', // { ttid: {season, episode} }
  };

  const vod = {
    filter: 'home',          // home | movies | series | list
    shelves: [],
    query: '',
    searchSeq: 0,
    watchlist: readStore(KEYS.watchlist, []),
    recent: readStore(KEYS.recent, []),
    progress: readStore(KEYS.progress, {}),
    current: null,           // { id, type, title, poster, year }
    episodes: null,          // { seasons: [...] }
    season: 1,
    episode: 1,
    blocked: 0,
  };

  /* ------------------------------------------------------------ helpers --- */

  const inWatchlist = (id) => vod.watchlist.some((x) => x.id === id);

  function toggleWatchlist(item) {
    if (inWatchlist(item.id)) vod.watchlist = vod.watchlist.filter((x) => x.id !== item.id);
    else vod.watchlist = [{ id: item.id, type: item.type, title: item.title, year: item.year, poster: item.poster }, ...vod.watchlist].slice(0, 200);
    writeStore(KEYS.watchlist, vod.watchlist);
    renderNav();
  }

  function rememberWatched(item, season, episode) {
    const entry = {
      id: item.id, type: item.type, title: item.title, year: item.year, poster: item.poster,
      season: season || null, episode: episode || null, ts: Date.now(),
    };
    vod.recent = [entry, ...vod.recent.filter((x) => x.id !== item.id)].slice(0, 30);
    writeStore(KEYS.recent, vod.recent);
    if (item.type === 'tv' && season) {
      vod.progress[item.id] = { season, episode };
      writeStore(KEYS.progress, vod.progress);
    }
  }

  /* --------------------------------------------------------------- nav --- */

  function renderNav() {
    const items = [
      { id: 'home', icon: '🏠', name: 'ראשי', count: '' },
      { id: 'movies', icon: '🍿', name: 'סרטים', count: '' },
      { id: 'series', icon: '📺', name: 'סדרות', count: '' },
      { id: 'list', icon: '⭐', name: 'הרשימה שלי', count: vod.watchlist.length },
      { id: 'continue', icon: '▶️', name: 'המשך צפייה', count: vod.recent.length },
    ];

    const nav = $('#nav');
    nav.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (vod.filter === item.id ? ' active' : '');
      btn.dataset.filter = `vod:${item.id}`;
      btn.innerHTML = `<span class="ico">${item.icon}</span><span class="n"></span>${item.count !== '' ? `<span class="c">${item.count}</span>` : ''}`;
      btn.querySelector('.n').textContent = item.name;
      btn.addEventListener('click', () => {
        vod.filter = item.id;
        history.replaceState(null, '', `#/vod/${item.id}`);
        $('#sidebar').classList.remove('open');
        $('#scrim').classList.remove('on');
        renderNav();
        renderView();
      });
      nav.appendChild(btn);
    }
  }

  /* -------------------------------------------------------------- cards --- */

  function posterCard(item, extra = '') {
    const card = document.createElement('button');
    card.className = 'poster';
    card.type = 'button';
    card.innerHTML = `
      <div class="poster-art">
        ${item.poster ? `<img loading="lazy" alt="" src="${item.poster}">` : '<span class="poster-fallback">🎞️</span>'}
        <span class="poster-play"><svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/></svg></span>
        <span class="badge type-badge">${item.type === 'tv' ? 'סדרה' : 'סרט'}</span>
        ${extra}
      </div>
      <div class="poster-title"></div>
      <div class="poster-meta"></div>`;
    card.querySelector('.poster-title').textContent = item.title;
    card.querySelector('.poster-meta').textContent = [item.year, item.cast ? item.cast.split(',')[0] : '']
      .filter(Boolean).join(' · ');
    const img = card.querySelector('img');
    if (img) img.addEventListener('error', () => { img.closest('.poster-art').classList.add('no-art'); img.remove(); });
    card.addEventListener('click', () => open(item));
    return card;
  }

  function renderGrid(container, items) {
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(posterCard(item));
    container.appendChild(frag);
  }

  function renderShelf(shelf) {
    const section = document.createElement('section');
    section.className = 'shelf';
    section.innerHTML = '<div class="shelf-head"><h3></h3></div><div class="shelf-row"></div>';
    section.querySelector('h3').textContent = shelf.title;
    const row = section.querySelector('.shelf-row');
    for (const item of shelf.items) row.appendChild(posterCard(item));
    return section;
  }

  /* --------------------------------------------------------------- view --- */

  async function enter() {
    renderNav();
    if (!vod.shelves.length) {
      $('#vodShelves').innerHTML = shelfSkeleton();
      try {
        vod.shelves = await getJSON('/api/vod/shelves');
      } catch (err) {
        toast(`טעינת הקטלוג נכשלה: ${err.message}`, 'err');
      }
    }
    renderView();
  }

  function shelfSkeleton() {
    const cards = Array.from({ length: 7 }, () => '<div class="poster skeleton"></div>').join('');
    return Array.from({ length: 2 }, () =>
      `<section class="shelf"><div class="shelf-head"><h3 class="skeleton-text"></h3></div><div class="shelf-row">${cards}</div></section>`).join('');
  }

  function renderView() {
    const results = $('#vodResults');
    const shelvesBox = $('#vodShelves');
    const empty = $('#vodEmpty');
    $('#vodBanner').hidden = vod.filter !== 'home' || !!vod.query;

    // search results take over the view
    if (vod.query) {
      shelvesBox.hidden = true;
      empty.hidden = true;
      results.hidden = false;
      return;
    }

    results.hidden = true;
    shelvesBox.hidden = false;

    if (vod.filter === 'list' || vod.filter === 'continue') {
      const items = vod.filter === 'list' ? vod.watchlist : vod.recent;
      shelvesBox.innerHTML = '';
      if (!items.length) {
        empty.hidden = false;
        $('#vodEmpty').querySelector('h3').textContent = vod.filter === 'list' ? 'הרשימה שלך ריקה' : 'עוד לא צפית בכלום';
        $('#vodEmptyHint').textContent = vod.filter === 'list'
          ? 'סמן כותרים בכוכב כדי לשמור אותם כאן.'
          : 'כל סרט או פרק שתפתח יופיע כאן כדי להמשיך מאיפה שהפסקת.';
        return;
      }
      empty.hidden = true;
      const section = document.createElement('section');
      section.className = 'shelf';
      section.innerHTML = '<div class="shelf-head"><h3></h3></div><div class="poster-grid"></div>';
      section.querySelector('h3').textContent = vod.filter === 'list' ? 'הרשימה שלי' : 'המשך צפייה';
      const grid = section.querySelector('.poster-grid');
      for (const item of items) {
        const label = item.type === 'tv' && item.season
          ? `<span class="badge ep-badge">S${item.season}E${item.episode}</span>` : '';
        grid.appendChild(posterCard(item, label));
      }
      shelvesBox.appendChild(section);
      return;
    }

    empty.hidden = true;
    const shelves = vod.shelves.filter((s) => {
      if (vod.filter === 'movies') return s.kind === 'movie';
      if (vod.filter === 'series') return s.kind === 'tv';
      return true;
    });

    shelvesBox.innerHTML = '';
    if (vod.filter === 'home' && vod.recent.length) {
      shelvesBox.appendChild(renderShelf({ title: 'המשך צפייה', items: vod.recent.slice(0, 12) }));
    }
    for (const shelf of shelves) shelvesBox.appendChild(renderShelf(shelf));
  }

  /* ------------------------------------------------------------- search --- */

  async function search(query) {
    vod.query = query;
    if (!query) { renderView(); return; }

    const seq = ++vod.searchSeq;
    const type = vod.filter === 'movies' ? 'movie' : (vod.filter === 'series' ? 'tv' : 'all');
    $('#vodResultsTitle').textContent = `תוצאות עבור “${query}”`;
    $('#vodResultsCount').textContent = '';
    $('#vodResultsGrid').innerHTML = Array.from({ length: 6 }, () => '<div class="poster skeleton"></div>').join('');
    renderView();

    try {
      const results = await getJSON(`/api/vod/search?q=${encodeURIComponent(query)}&type=${type}`);
      if (seq !== vod.searchSeq) return;
      $('#vodResultsCount').textContent = results.length ? `${results.length} כותרים` : '';
      renderGrid($('#vodResultsGrid'), results);
      $('#vodEmpty').hidden = results.length > 0;
      $('#vodResults').hidden = results.length === 0;
      if (!results.length) {
        $('#vodEmpty').querySelector('h3').textContent = 'לא מצאנו כותרים';
        $('#vodEmptyHint').textContent = 'נסה שם באנגלית, או הדבק מזהה IMDb כמו tt1300854.';
      }
    } catch (err) {
      if (seq !== vod.searchSeq) return;
      $('#vodResultsGrid').innerHTML = '';
      toast(`חיפוש נכשל: ${err.message}`, 'err');
    }
  }

  /* ------------------------------------------------------------- player --- */

  /* Pop-up defence.
   *
   * The embed refuses to run inside an <iframe sandbox> (it detects the cage
   * and bounces itself out), so the usual sandbox lock-down is not available.
   * What works instead:
   *   1. a click shield that swallows the first click on the player - the ad
   *      pop-ups need a fresh user gesture, and this is the gesture they wait
   *      for, so the first "accidental" tab never opens;
   *   2. a beforeunload guard while the player is open, so nothing can silently
   *      navigate the app away to another site;
   *   3. detection: if the tab loses focus right after a click in the player,
   *      we count it and tell the user.
   */
  let unloadGuardArmed = false;

  function armUnloadGuard() {
    if (unloadGuardArmed) return;
    window.addEventListener('beforeunload', blockUnload);
    unloadGuardArmed = true;
  }
  function disarmUnloadGuard() {
    window.removeEventListener('beforeunload', blockUnload);
    unloadGuardArmed = false;
  }
  function blockUnload(ev) {
    ev.preventDefault();
    ev.returnValue = '';
    return '';
  }

  function armClickShield() {
    const shield = $('#clickShield');
    shield.hidden = false;
    shield.classList.remove('armed');
    requestAnimationFrame(() => shield.classList.add('armed'));
  }

  async function open(item, { season, episode } = {}) {
    vod.current = item;
    vod.blocked = 0;
    $('#blockedCount').textContent = '0';

    $('#vodLayer').hidden = false;
    document.body.style.overflow = 'hidden';
    history.replaceState(null, '', `#/title/${item.id}`);

    $('#vodTitle').textContent = item.title;
    $('#vodYear').hidden = !item.year;
    $('#vodYear').textContent = item.year || '';
    $('#vodSub').textContent = item.cast || (item.type === 'tv' ? 'סדרה' : 'סרט');
    $('#vodPoster').src = item.poster || '';
    $('#vodPoster').style.display = item.poster ? '' : 'none';
    syncWatchlistButton();

    if (item.type === 'tv') {
      $('#vodPanel').hidden = false;
      $('#vodBar').hidden = false;
      await loadEpisodes(item, season, episode);
    } else {
      $('#vodPanel').hidden = true;
      $('#vodBar').hidden = true;
      vod.episodes = null;
      mountFrame(item, null, null);
      rememberWatched(item);
    }
  }

  async function loadEpisodes(item, wantSeason, wantEpisode) {
    const list = $('#episodeList');
    list.innerHTML = '<div class="panel-note">טוען פרקים…</div>';
    $('#vodSpinner').hidden = false;

    let data = null;
    try {
      data = await getJSON(`/api/vod/episodes/${item.id}`);
    } catch {
      data = null;
    }
    if (vod.current?.id !== item.id) return;

    vod.episodes = data && data.found ? data : null;

    if (!vod.episodes || !vod.episodes.seasons.length) {
      list.innerHTML = '<div class="panel-note">לא נמצאה רשימת פרקים — מנגן עונה 1 פרק 1.</div>';
      vod.season = wantSeason || 1;
      vod.episode = wantEpisode || 1;
      renderEpisodeBar();
      mountFrame(item, vod.season, vod.episode);
      rememberWatched(item, vod.season, vod.episode);
      return;
    }

    if (vod.episodes.summary) $('#vodSub').textContent = vod.episodes.summary.slice(0, 160);

    const saved = vod.progress[item.id];
    const seasons = vod.episodes.seasons;
    vod.season = wantSeason || saved?.season || seasons[0].season;
    vod.episode = wantEpisode || saved?.episode || 1;
    if (!seasons.some((s) => s.season === vod.season)) vod.season = seasons[0].season;

    const select = $('#seasonSelect');
    select.innerHTML = '';
    for (const s of seasons) {
      const opt = document.createElement('option');
      opt.value = String(s.season);
      opt.textContent = `עונה ${s.season} · ${s.episodes.length} פרקים`;
      select.appendChild(opt);
    }
    select.value = String(vod.season);

    renderEpisodeList();
    playEpisode(vod.season, vod.episode);
  }

  function renderEpisodeList() {
    const list = $('#episodeList');
    list.innerHTML = '';
    const season = vod.episodes?.seasons.find((s) => s.season === vod.season);
    if (!season) return;

    for (const ep of season.episodes) {
      const row = document.createElement('button');
      row.className = 'ep-row' + (ep.season === vod.season && ep.number === vod.episode ? ' active' : '');
      row.type = 'button';
      row.innerHTML = `
        <span class="ep-thumb">${ep.image ? `<img loading="lazy" alt="" src="${ep.image}">` : `<b>${ep.number}</b>`}</span>
        <span class="ep-text">
          <span class="ep-title"></span>
          <span class="ep-meta"></span>
        </span>`;
      row.querySelector('.ep-title').textContent = `${ep.number}. ${ep.name}`;
      row.querySelector('.ep-meta').textContent = [ep.airdate, ep.rating ? `★ ${ep.rating}` : '', ep.aired ? '' : 'טרם שודר']
        .filter(Boolean).join(' · ');
      row.title = ep.summary || '';
      row.addEventListener('click', () => playEpisode(ep.season, ep.number));
      list.appendChild(row);
    }
    const active = list.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function playEpisode(season, episode) {
    vod.season = season;
    vod.episode = episode;
    $('#seasonSelect').value = String(season);
    renderEpisodeList();
    renderEpisodeBar();
    mountFrame(vod.current, season, episode);
    rememberWatched(vod.current, season, episode);
  }

  function currentSeasonEpisodes() {
    return vod.episodes?.seasons.find((s) => s.season === vod.season)?.episodes || [];
  }

  function renderEpisodeBar() {
    const eps = currentSeasonEpisodes();
    const current = eps.find((e) => e.number === vod.episode);
    $('#vodBarLabel').textContent = current
      ? `עונה ${vod.season} · פרק ${vod.episode} — ${current.name}`
      : `עונה ${vod.season} · פרק ${vod.episode}`;
    $('#prevEp').disabled = !hasNeighbour(-1);
    $('#nextEp').disabled = !hasNeighbour(1);
  }

  function neighbour(step) {
    if (!vod.episodes) return null;
    const seasons = vod.episodes.seasons;
    const si = seasons.findIndex((s) => s.season === vod.season);
    if (si === -1) return null;
    const eps = seasons[si].episodes;
    const ei = eps.findIndex((e) => e.number === vod.episode);
    const next = eps[ei + step];
    if (next) return { season: next.season, episode: next.number };
    const sibling = seasons[si + step];
    if (!sibling || !sibling.episodes.length) return null;
    const edge = step > 0 ? sibling.episodes[0] : sibling.episodes[sibling.episodes.length - 1];
    return { season: edge.season, episode: edge.number };
  }

  const hasNeighbour = (step) => Boolean(neighbour(step));

  function mountFrame(item, season, episode) {
    const holder = $('#frameHolder');
    holder.innerHTML = '';
    $('#vodSpinner').hidden = false;

    // Our own path; the server redirects it to the provider, so the page never
    // has to hand out the provider's address itself.
    const url = item.type === 'tv'
      ? `/play/tv/${item.id}/${season || 1}/${episode || 1}`
      : `/play/movie/${item.id}`;

    Promise.resolve().then(() => {
      if (vod.current?.id !== item.id) return;
      const frame = document.createElement('iframe');
      frame.id = 'vodFrame';
      frame.src = url;
      frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      frame.setAttribute('referrerpolicy', 'origin');
      frame.setAttribute('allowfullscreen', '');
      frame.addEventListener('load', () => { $('#vodSpinner').hidden = true; });
      holder.appendChild(frame);
      armClickShield();
      armUnloadGuard();
      setTimeout(() => { $('#vodSpinner').hidden = true; }, 6000);
    }).catch((err) => {
      $('#vodSpinner').hidden = true;
      toast(`לא ניתן לטעון את הנגן: ${err.message}`, 'err');
    });
  }

  function syncWatchlistButton() {
    const on = vod.current && inWatchlist(vod.current.id);
    $('#vodWatchlist').classList.toggle('on', Boolean(on));
  }

  function close() {
    $('#frameHolder').innerHTML = '';
    disarmUnloadGuard();
    $('#clickShield').hidden = true;
    $('#vodLayer').hidden = true;
    document.body.style.overflow = '';
    vod.current = null;
    history.replaceState(null, '', `#/vod/${vod.filter}`);
    renderNav();
    renderView();
  }

  /* -------------------------------------------------------------- route --- */

  async function applyRoute(hash) {
    if (hash.startsWith('title/')) {
      const id = hash.slice(6);
      if (!/^tt\d+$/.test(id)) return;
      try {
        const item = await getJSON(`/api/vod/title/${id}`);
        open(item);
      } catch {
        toast('הכותר לא נמצא', 'err');
      }
      return;
    }
    const part = hash.split('/')[1];
    vod.filter = ['home', 'movies', 'series', 'list', 'continue'].includes(part) ? part : 'home';
  }

  /* ------------------------------------------------------------- events --- */

  $('#vodClose').addEventListener('click', close);
  $('#vodTogglePanel').addEventListener('click', () => $('#vodPanel').classList.toggle('collapsed'));
  $('#vodWatchlist').addEventListener('click', () => {
    if (!vod.current) return;
    toggleWatchlist(vod.current);
    syncWatchlistButton();
    toast(inWatchlist(vod.current.id) ? 'נוסף לרשימה שלי' : 'הוסר מהרשימה', 'ok');
  });
  $('#vodFs').addEventListener('click', () => {
    const el = $('#vodStage');
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  });
  $('#seasonSelect').addEventListener('change', (ev) => {
    vod.season = Number(ev.target.value);
    const first = currentSeasonEpisodes()[0];
    if (first) playEpisode(first.season, first.number);
  });
  $('#prevEp').addEventListener('click', () => { const n = neighbour(-1); if (n) playEpisode(n.season, n.episode); });
  $('#nextEp').addEventListener('click', () => { const n = neighbour(1); if (n) playEpisode(n.season, n.episode); });

  $('#clickShield').addEventListener('click', () => {
    $('#clickShield').hidden = true;
    const frame = $('#vodFrame');
    if (frame) { try { frame.contentWindow.focus(); } catch { /* cross-origin */ } }
  });

  // A pop-up steals focus from the tab; if that happens while the player is
  // open, say so instead of leaving the user wondering what just flashed by.
  let warned = false;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || $('#vodLayer').hidden) return;
    bumpBlocked();
    if (!warned) {
      warned = true;
      toast('הנגן ניסה לפתוח חלון חיצוני. אם זה חוזר, התקן uBlock Origin בדפדפן.', 'err');
    }
  });

  function bumpBlocked() {
    if ($('#vodLayer').hidden) return;
    vod.blocked += 1;
    $('#blockedCount').textContent = String(vod.blocked);
  }

  window.SL.vod = { enter, renderNav, renderView, search, applyRoute, open, close };
})();
