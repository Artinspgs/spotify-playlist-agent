/* app.js — liga a interface à engine e ao Spotify. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = window.Engine, S = window.Spotify;
  const FKEY = 'spa_filters';

  const state = {
    genres: new Set(), moods: new Set(), decades: new Set(),
    tracks: [], lastFilters: null,
  };

  // ---------- helpers de UI ----------
  const views = ['viewLogin', 'viewFilters', 'viewPreview', 'viewDone'];
  function show(view) {
    views.forEach((v) => ($(v).hidden = v !== view));
    $('barFilters').hidden = view !== 'viewFilters';
    $('barPreview').hidden = view !== 'viewPreview';
    $('btnLogout').hidden = view === 'viewLogin';
    window.scrollTo(0, 0);
  }
  function banner(msg, info) {
    const b = $('banner');
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg; b.className = 'banner' + (info ? ' info' : ''); b.hidden = false;
  }
  function busy(on, text, pct) {
    $('busy').hidden = !on;
    if (text) $('busyText').textContent = text;
    if (pct != null) $('busyBar').style.width = Math.round(pct * 100) + '%';
  }

  function chip(label, pressed, onToggle) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = label;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      onToggle(on);
    });
    return b;
  }

  function renderGenres() {
    const box = $('chipsGenres'); box.textContent = '';
    const all = [...new Set([...E.GENRES, ...state.genres])];
    all.forEach((g) => box.appendChild(chip(g, state.genres.has(g), (on) => (on ? state.genres.add(g) : state.genres.delete(g)))));
  }
  function renderMoods() {
    const box = $('chipsMoods'); box.textContent = '';
    Object.entries(E.MOODS).forEach(([k, m]) =>
      box.appendChild(chip(m.label, state.moods.has(k), (on) => (on ? state.moods.add(k) : state.moods.delete(k)))));
  }
  function renderDecades() {
    const box = $('chipsDecades'); box.textContent = '';
    Object.keys(E.DECADES).forEach((d) =>
      box.appendChild(chip(d, state.decades.has(d), (on) => (on ? state.decades.add(d) : state.decades.delete(d)))));
  }

  // ---------- filtros ----------
  function readFilters() {
    return {
      genres: [...state.genres], moods: [...state.moods], decades: [...state.decades],
      includeArtists: E.parseList($('inArtists').value), excludeArtists: E.parseList($('exArtists').value),
      size: parseInt($('size').value, 10), maxPerArtist: parseInt($('maxPerArtist').value, 10),
      market: $('market').value, avoidNoisy: $('avoidNoisy').checked, noExplicit: $('noExplicit').checked,
      isPrivate: $('isPrivate').checked,
    };
  }
  function writeFilters(f) {
    state.genres = new Set(f.genres || []); state.moods = new Set(f.moods || []); state.decades = new Set(f.decades || []);
    $('inArtists').value = (f.includeArtists || []).join(', ');
    $('exArtists').value = (f.excludeArtists || []).join(', ');
    $('size').value = f.size || 30; $('sizeVal').textContent = f.size || 30;
    $('maxPerArtist').value = String(f.maxPerArtist || 2);
    $('market').value = f.market || 'BR';
    $('avoidNoisy').checked = f.avoidNoisy !== false;
    $('noExplicit').checked = !!f.noExplicit;
    $('isPrivate').checked = f.isPrivate !== false;
    renderGenres(); renderMoods(); renderDecades();
  }
  const saveFilters = (f) => { try { localStorage.setItem(FKEY, JSON.stringify(f)); } catch (e) { /* ignore */ } };
  const loadFilters = () => { try { return JSON.parse(localStorage.getItem(FKEY)) || {}; } catch (e) { return {}; } };

  // ---------- geração ----------
  async function runPool(items, limit, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
    }));
  }

  async function collect(plan, f, cands, onTick) {
    let failed = 0;
    await runPool(plan, 3, async (item) => {
      try {
        const r = await S.search(item.q, item.offset, f.market);
        ((r.tracks && r.tracks.items) || []).forEach((t) => t && cands.push({ track: t, src: item.src }));
      } catch (e) {
        if (e.fatal) throw e;
        failed++;
      }
      onTick();
    });
    return failed;
  }

  async function generate() {
    banner('');
    const f = readFilters();
    if (!f.genres.length && !f.moods.length && !f.decades.length && !f.includeArtists.length) {
      banner('Escolha ao menos um filtro (gênero, vibe, época ou artista).', true);
      return;
    }
    saveFilters(f);
    state.lastFilters = f;
    busy(true, 'Buscando músicas…', 0);
    try {
      const used = new Set();
      const cands = [];
      let plan = E.planQueries(f, Math.random, used);
      let total = plan.length, done = 0;
      const tick = () => busy(true, 'Buscando músicas…', Math.min(1, ++done / total));
      let failed = await collect(plan, f, cands, tick);
      let res = E.curate(cands, f);

      // Segunda chance: se faltou música, amplia a busca sem palavras de vibe.
      if (res.tracks.length < f.size * 0.8) {
        busy(true, 'Ampliando a busca…', 0.9);
        const looser = Object.assign({}, f, { moods: [], includeArtists: [] });
        plan = E.planQueries(looser, Math.random, used);
        total += plan.length;
        failed += await collect(plan, f, cands, tick);
        res = E.curate(cands, f);
      }

      if (!res.tracks.length) {
        banner(failed ? 'Não consegui buscar agora. Verifique a conexão e tente de novo.'
          : 'Nenhuma música encontrada com esses filtros. Tente menos filtros (por exemplo, tire a vibe ou a época).', true);
        return;
      }
      state.tracks = res.tracks;
      $('plName').value = E.buildName(f);
      renderPreview(f.size);
      show('viewPreview');
    } catch (e) {
      handleError(e);
    } finally {
      busy(false);
    }
  }

  function renderPreview(wanted) {
    const ul = $('trackList'); ul.textContent = '';
    state.tracks.forEach((t, idx) => {
      const li = document.createElement('li'); li.className = 'track';
      const img = (t.album && t.album.images && (t.album.images[2] || t.album.images[1] || t.album.images[0])) || null;
      let cover;
      if (img) { cover = document.createElement('img'); cover.src = img.url; cover.alt = ''; cover.loading = 'lazy'; }
      else { cover = document.createElement('div'); cover.className = 'noimg'; }
      const meta = document.createElement('div'); meta.className = 'meta';
      const name = document.createElement('div'); name.className = 'name'; name.textContent = t.name;
      const sub = document.createElement('div'); sub.className = 'sub';
      if (t.explicit) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'E'; sub.appendChild(tag); }
      sub.appendChild(document.createTextNode((t.artists || []).map((a) => a.name).join(', ')));
      meta.append(name, sub);
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.setAttribute('aria-label', 'Remover ' + t.name); x.textContent = '×';
      x.addEventListener('click', () => { state.tracks.splice(idx, 1); renderPreview(wanted); });
      li.append(cover, meta, x);
      ul.appendChild(li);
    });
    const n = state.tracks.length;
    $('plStats').textContent = n + ' música' + (n === 1 ? '' : 's') +
      (wanted && n < wanted ? ' (você pediu ' + wanted + '; os filtros deixaram menos opções)' : '');
    $('btnSave').disabled = n === 0;
  }

  async function save() {
    const f = state.lastFilters || readFilters();
    const name = $('plName').value.trim() || E.buildName(f);
    busy(true, 'Salvando no Spotify…', 0.3);
    try {
      const pl = await S.createPlaylist(name, E.buildDescription(f), !f.isPrivate);
      busy(true, 'Adicionando músicas…', 0.6);
      await S.addItems(pl.id, state.tracks.map((t) => t.uri));
      const url = (pl.external_urls && pl.external_urls.spotify) || 'https://open.spotify.com/playlist/' + pl.id;
      $('doneText').textContent = '“' + name + '” com ' + state.tracks.length + ' músicas já está na sua biblioteca.';
      $('doneLink').href = url;
      show('viewDone');
    } catch (e) {
      handleError(e);
    } finally {
      busy(false);
    }
  }

  function handleError(e) {
    console.error(e);
    banner(e.message || 'Algo deu errado.');
    if (!S.isLoggedIn()) show('viewLogin');
  }

  // ---------- pedido em linguagem natural ----------
  function showNl(r) {
    const box = $('nlResult');
    box.hidden = false; box.textContent = ''; box.className = 'nl-result' + (r.error ? ' err' : '');
    if (r.error) { box.textContent = r.error; return; }
    const tag = document.createElement('span');
    tag.className = 'src' + (r.source === 'ai' ? ' ai' : '');
    tag.textContent = r.source === 'ai' ? 'IA' : r.source === 'local' ? 'Regras locais' : 'Parcial';
    box.append(tag, document.createTextNode('Entendi: ' + r.summary + '. Ajuste abaixo se quiser e toque em "Gerar prévia".'));
    (r.warnings || []).filter(Boolean).forEach((w) => {
      const s = document.createElement('span'); s.className = 'warn'; s.textContent = w; box.appendChild(s);
    });
  }

  function applyInterpreted(found) {
    const cur = readFilters();
    // pedido novo: zera os filtros de conteúdo; mantém os ajustes que o pedido não mencionou
    const base = {
      genres: [], moods: [], decades: [], includeArtists: [], excludeArtists: [],
      size: cur.size, maxPerArtist: cur.maxPerArtist, market: cur.market,
      avoidNoisy: cur.avoidNoisy, noExplicit: cur.noExplicit, isPrivate: cur.isPrivate,
    };
    const f = Object.assign(base, found);
    writeFilters(f);
    saveFilters(readFilters());
  }

  async function interpretRequest() {
    banner('');
    const btn = $('btnInterpret');
    btn.disabled = true; btn.textContent = 'Interpretando…';
    try {
      const r = await NLU.interpret($('nlText').value, { apiUrl: (window.CONFIG && window.CONFIG.API_URL) || '' });
      if (!r.error) applyInterpreted(r.filters);
      showNl(r);
    } catch (e) {
      showNl({ error: 'Não consegui interpretar agora. Use os filtros abaixo.' });
    } finally {
      btn.disabled = false; btn.textContent = 'Interpretar pedido';
    }
  }

  // ---------- início ----------
  async function init() {
    $('size').addEventListener('input', () => ($('sizeVal').textContent = $('size').value));
    $('btnAddGenre').addEventListener('click', addCustomGenre);
    $('customGenre').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomGenre(); } });
    $('btnInterpret').addEventListener('click', interpretRequest);
    $('nlText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); interpretRequest(); } });
    $('btnGenerate').addEventListener('click', generate);
    $('btnRegen').addEventListener('click', generate);
    $('btnBack').addEventListener('click', () => show('viewFilters'));
    $('btnSave').addEventListener('click', save);
    $('btnAgain').addEventListener('click', () => { state.tracks = []; show('viewFilters'); });
    $('btnReset').addEventListener('click', () => { writeFilters({}); saveFilters({}); });
    $('btnLogin').addEventListener('click', () => S.login());
    $('btnLogout').addEventListener('click', () => { S.logout(); banner(''); show('viewLogin'); });

    writeFilters(loadFilters());

    if (!S.configured()) {
      show('viewLogin');
      $('btnLogin').disabled = true;
      const h = $('setupHint'); h.hidden = false;
      h.textContent = 'Falta configurar: abra config.js e cole o Client ID do seu app do Spotify (veja o README).';
      return;
    }
    try { await S.handleRedirect(); } catch (e) { banner(e.message); }

    if (S.isLoggedIn()) {
      show('viewFilters');
      S.me().then((u) => { if (u && u.display_name) $('hello').textContent = 'Olá, ' + u.display_name + '! Monte sua playlist:'; })
        .catch((e) => { if (e.fatal) handleError(e); });
      $('hello').textContent = 'Monte sua playlist:';
    } else {
      show('viewLogin');
    }
  }

  function addCustomGenre() {
    const v = $('customGenre').value.trim().toLowerCase();
    if (!v) return;
    state.genres.add(v); $('customGenre').value = ''; renderGenres();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  init();
})();
