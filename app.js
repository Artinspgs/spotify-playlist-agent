/* app.js — liga a interface à engine, ao interpretador (IA) e ao Spotify. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = window.Engine, S = window.Spotify, N = window.NLU;
  const FKEY = 'spa_filters', DRAFT = 'spa_draft', AUTORUN = 'spa_autorun', HKEY = 'spa_hist', PKEY = 'spa_prompts';

  // Pedidos prontos: tocar preenche a caixa (dá para editar antes de montar).
  const PRESETS = [
    ['Treino 60 min', 'Treino de 1 hora, 18 músicas animadas de pop, rap e electronic'],
    ['Churrasco', 'Churrasco com amigos, 40 músicas de samba, pagode e sertanejo, para festa'],
    ['Foco', 'Música para foco e estudo, 30 músicas de lo-fi e jazz'],
    ['Festa', 'Festa com 60 músicas de funk, pop e hip hop, misturando clássicos e lançamentos novos'],
    ['Estrada', 'Viagem de estrada, 40 músicas de rock e pop rock, anos 80 e 90'],
    ['Relaxar', 'Relaxar à noite, 25 músicas de mpb e bossa nova'],
    ['Lançamentos', 'Só lançamentos novos de pop e rap em português e inglês, 30 músicas'],
  ];

  const state = {
    genres: new Set(), moods: new Set(), decades: new Set(), languages: new Set(),
    tracks: [], origin: new Map(), src: new Map(), notes: [], lastFilters: null, wanted: 0,
    playlists: null, mineLoaded: false,
    pool: [], used: new Set(), locked: new Set(), removed: new Set(), openId: null,
  };
  // caches de sessão: refazer a prévia ("Outra versão") não gasta chamadas ao Spotify
  const searchCache = new Map();
  const itemsCache = new Map();
  const run = { n: 0, ctl: null };

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
  const lsJson = (k, d) => { try { const v = JSON.parse(lsGet(k)); return v == null ? d : v; } catch (e) { return d; } };

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
  // busy(on, texto, progresso 0-1, estimativa, cancelável?) — parâmetro omitido (undefined) mantém o valor anterior
  function busy(on, text, pct, eta, cancel) {
    $('busy').hidden = !on;
    if (!on) { $('busyEta').textContent = ''; $('busyCancel').hidden = true; return; }
    if (text != null) $('busyText').textContent = text;
    if (pct != null) $('busyBar').style.width = Math.round(pct * 100) + '%';
    if (eta !== undefined) $('busyEta').textContent = eta || '';
    if (cancel !== undefined) $('busyCancel').hidden = !cancel;
  }
  function fmtEta(sec) {
    if (!(sec >= 0)) return '';
    if (sec < 6) return 'quase pronto…';
    if (sec < 90) return 'faltam cerca de ' + Math.round(sec / 5) * 5 + ' s';
    return 'faltam cerca de ' + Math.ceil(sec / 60) + ' min';
  }
  function newRun() {
    run.n++;
    run.ctl = { stop: false, rate: false, cancelled: false, id: run.n, t0: Date.now() };
    return run.ctl;
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
  function plainChip(label, onClick, title, extraClass) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (extraClass ? ' ' + extraClass : ''); b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderGenres() {
    const box = $('chipsGenres'); box.textContent = '';
    const all = [...new Set([...E.GENRES, ...state.genres])];
    all.forEach((g) => box.appendChild(chip(g, state.genres.has(g), (on) => (on ? state.genres.add(g) : state.genres.delete(g)))));
  }
  function renderLangs() {
    const box = $('chipsLangs'); box.textContent = '';
    Object.entries(E.LANGS).forEach(([k, label]) =>
      box.appendChild(chip(label, state.languages.has(k), (on) => (on ? state.languages.add(k) : state.languages.delete(k)))));
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

  // ---------- atalhos e pedidos recentes ----------
  function fillText(t) {
    $('nlText').value = t; lsSet(DRAFT, t);
    $('nlResult').hidden = true;
    $('nlText').focus();
  }
  function renderPresets() {
    const box = $('presets'); box.textContent = '';
    PRESETS.forEach(([label, text]) => box.appendChild(plainChip(label, () => fillText(text), text)));
  }
  function renderRecents() {
    const list = lsJson(PKEY, []).filter((x) => typeof x === 'string');
    $('recentsBox').hidden = !list.length;
    const box = $('recents'); box.textContent = '';
    list.forEach((t) => box.appendChild(plainChip(t.length > 34 ? t.slice(0, 33) + '…' : t, () => fillText(t), t, 'recent')));
  }
  function rememberPrompt(t) {
    t = (t || '').trim(); if (!t) return;
    const list = lsJson(PKEY, []).filter((x) => typeof x === 'string' && x !== t);
    list.unshift(t);
    lsSet(PKEY, JSON.stringify(list.slice(0, 8)));
    renderRecents();
  }

  // ---------- histórico do que já foi salvo ----------
  const loadHist = () => { const h = lsJson(HKEY, []); return Array.isArray(h) ? h.filter((e) => e && e.id && Array.isArray(e.ids)) : []; };
  function saveHist(h) {
    let total = 0; const out = [];
    for (const e of h.slice(0, 40)) {
      if (total >= 3000) break;
      const ids = e.ids.slice(0, 3000 - total); total += ids.length;
      out.push(Object.assign({}, e, { ids }));
    }
    lsSet(HKEY, JSON.stringify(out));
    refreshHistUi();
  }
  const histIds = () => { const s = new Set(); loadHist().forEach((e) => e.ids.forEach((i) => s.add(i))); return s; };
  function refreshHistUi() {
    const n = loadHist().length;
    $('btnClearHist').textContent = n ? 'Esquecer playlists já criadas (' + n + ')' : 'Nenhuma playlist criada ainda';
    $('btnClearHist').disabled = !n;
  }
  function renderSaveTo() {
    const sel = $('saveTo'); sel.textContent = '';
    const o = document.createElement('option'); o.value = 'new'; o.textContent = 'Nova playlist'; sel.appendChild(o);
    loadHist().slice(0, 15).forEach((e) => {
      const op = document.createElement('option'); op.value = e.id;
      op.textContent = 'Adicionar a: ' + e.name + ' (' + new Date(e.date || Date.now()).toLocaleDateString('pt-BR') + ')';
      sel.appendChild(op);
    });
    $('plName').disabled = false;
  }
  // ids que a próxima geração/troca deve evitar (histórico + o que o usuário tirou nesta sessão)
  function excludeIdsFor(f) {
    const s = new Set(state.removed);
    if (f.avoidHistory) histIds().forEach((i) => s.add(i));
    return [...s];
  }

  // ---------- filtros ----------
  function readFilters() {
    const useMine = $('useMine').checked;
    return {
      genres: [...state.genres], moods: [...state.moods], decades: [...state.decades], languages: [...state.languages],
      includeArtists: E.parseList($('inArtists').value), seedArtists: E.parseList($('inSeeds').value), excludeArtists: E.parseList($('exArtists').value),
      size: parseInt($('size').value, 10), maxPerArtist: parseInt($('maxPerArtist').value, 10) || 0,
      market: $('market').value, avoidNoisy: $('avoidNoisy').checked, noExplicit: $('noExplicit').checked,
      isPrivate: $('isPrivate').checked, avoidHistory: $('avoidHist').checked,
      useMyPlaylists: useMine, mineShare: useMine ? parseInt($('mineShare').value, 10) : 0,
      newShare: parseInt($('newShare').value, 10),
    };
  }
  function syncLabels() {
    $('sizeVal').textContent = $('size').value;
    $('mineVal').textContent = $('mineShare').value;
    $('newVal').textContent = $('newShare').value;
  }
  function writeFilters(f) {
    state.genres = new Set(f.genres || []); state.moods = new Set(f.moods || []);
    state.decades = new Set(f.decades || []); state.languages = new Set(f.languages || []);
    $('inArtists').value = (f.includeArtists || []).join(', ');
    $('inSeeds').value = (f.seedArtists || []).join(', ');
    $('exArtists').value = (f.excludeArtists || []).join(', ');
    $('size').value = f.size || 30;
    $('maxPerArtist').value = String(f.maxPerArtist || 0);
    $('market').value = f.market || 'BR';
    $('avoidNoisy').checked = f.avoidNoisy !== false;
    $('noExplicit').checked = !!f.noExplicit;
    $('isPrivate').checked = f.isPrivate !== false;
    $('avoidHist').checked = f.avoidHistory !== false;
    $('useMine').checked = !!f.useMyPlaylists;
    $('mineShare').value = f.mineShare || 40;
    $('newShare').value = f.newShare || 0;
    syncLabels();
    renderGenres(); renderLangs(); renderMoods(); renderDecades();
  }
  // o que veio do pedido atual (artistas sugeridos, suas playlists, novas) não é guardado para a próxima vez
  const saveFilters = (f) => lsSet(FKEY, JSON.stringify(Object.assign({}, f, { seedArtists: [], useMyPlaylists: false, mineShare: 40, newShare: 0 })));
  const loadFilters = () => lsJson(FKEY, {});

  // ---------- suas playlists ----------
  function renderMineList(playlists, chosenIds, meId) {
    const box = $('mineList'); box.textContent = '';
    const mine = playlists.filter((p) => p && p.id && ((p.owner && p.owner.id === meId) || p.collaborative) && E.playlistTotal(p) > 0).slice(0, 80);
    mine.forEach((p) => {
      const lab = document.createElement('label'); lab.className = 'switch';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.id = p.id; cb.checked = chosenIds.has(p.id);
      const sp = document.createElement('span'); sp.textContent = p.name + ' (' + E.playlistTotal(p) + ')';
      lab.append(cb, sp); box.appendChild(lab);
    });
    $('mineBox').hidden = !mine.length;
    state.mineLoaded = true;
  }
  const readMineSelection = () => {
    if (!state.mineLoaded) return null;
    return new Set([...$('mineList').querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.dataset.id));
  };
  function resetMineSelection() { state.mineLoaded = false; $('mineList').textContent = ''; $('mineBox').hidden = true; }

  // ---------- geração ----------
  async function runPool(items, limit, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
    }));
  }

  async function searchCached(q, offset, market) {
    const key = market + '|' + q + '|' + offset;
    if (searchCache.has(key)) return searchCache.get(key);
    const r = await S.search(q, offset, market);
    const items = (r.tracks && r.tracks.items) || [];
    searchCache.set(key, items);
    return items;
  }

  // Executa as buscas. Se o Spotify limitar o uso (429) ou o usuário cancelar, para de buscar e segue com o que já tem.
  async function collect(plan, f, cands, tick, ctl) {
    let failed = 0;
    await runPool(plan, 3, async (item) => {
      if (ctl.stop) return;
      try {
        const items = await searchCached(item.q, item.offset, f.market);
        items.forEach((t, i) => t && cands.push({ track: t, src: item.src, rank: item.offset + i }));
      } catch (e) {
        if (e.fatal) throw e;
        if (e.rate) { ctl.rate = true; ctl.stop = true; } else failed++;
      }
      tick();
    });
    return failed;
  }

  // Lê faixas das playlists do usuário (até 8 playlists, 2 páginas de 50 cada, sorteadas).
  async function gatherMine(f, cands, prog, tick, ctl) {
    if (!S.hasScope('playlist-read-private')) {
      const e = new Error('Para usar as suas playlists o app precisa de uma permissão nova do Spotify.');
      e.needScope = true; throw e;
    }
    busy(true, 'Lendo as suas playlists…');
    const meInfo = await S.me();
    if (!state.playlists) state.playlists = await S.listMyPlaylists();
    let chosen, byName = true;
    const sel = readMineSelection();
    if (sel) chosen = state.playlists.filter((p) => sel.has(p.id)).slice(0, 12);
    else {
      const pick = E.pickPlaylists(state.playlists, { genres: f.genres, meId: meInfo.id, max: 8 });
      chosen = pick.chosen; byName = pick.byName;
      renderMineList(state.playlists, new Set(chosen.map((p) => p.id)), meInfo.id);
    }
    if (!chosen.length) return 'Nenhuma playlist sua foi usada (nenhuma selecionada ou com músicas).';

    const jobs = [];
    chosen.forEach((p) => {
      const pages = Math.max(1, Math.ceil(E.playlistTotal(p) / 50));
      const idx = Array.from({ length: pages }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, 2);
      idx.forEach((i) => jobs.push({ p, offset: i * 50 }));
    });
    prog.total += jobs.length;
    await runPool(jobs, 3, async (job) => {
      if (ctl.stop) return;
      const key = job.p.id + '|' + job.offset;
      try {
        let tracks = itemsCache.get(key);
        if (!tracks) {
          const r = await S.playlistTracks(job.p.id, job.offset, f.market);
          tracks = r.tracks; if (!r.forbidden) itemsCache.set(key, tracks);
        }
        tracks.forEach((t) => cands.push({ track: t, src: 'mine:' + job.p.name, rank: 0 }));
      } catch (e) {
        if (e.fatal) throw e;
        if (e.rate) { ctl.rate = true; ctl.stop = true; }
      }
      tick();
    });
    const names = chosen.slice(0, 4).map((p) => p.name).join(', ') + (chosen.length > 4 ? ' e mais ' + (chosen.length - 4) : '');
    return 'Suas playlists usadas (' + (byName ? 'escolhidas pelo nome' : 'nenhuma combinou com o gênero; usei as maiores') + '): ' + names + '.';
  }

  // opts.keep: mantém as faixas marcadas com ★ e completa o resto
  async function generate(opts) {
    opts = opts || {};
    banner('');
    const f = readFilters();
    f.recentFrom = new Date().getFullYear() - 1;
    if (!f.genres.length && !f.moods.length && !f.decades.length && !f.includeArtists.length && !f.seedArtists.length && !f.useMyPlaylists) {
      banner('Descreva a playlist na caixa de cima (ou escolha ao menos um filtro).', true);
      return;
    }
    saveFilters(f);

    const keep = opts.keep ? state.tracks.filter((t) => state.locked.has(t.id)) : [];
    if (!opts.keep) { state.locked = new Set(); state.removed = new Set(); }
    const keepIds = new Set(keep.map((t) => t.id));
    // o que sobra para buscar (as marcadas já contam no total)
    const fRun = Object.assign({}, f, { size: Math.max(1, f.size - keep.length) });
    fRun.excludeIds = excludeIdsFor(f).concat([...keepIds]);

    const ctl = newRun();
    busy(true, 'Preparando…', 0, '', true);
    const notes = [];
    try {
      const used = new Set();
      const cands = [];
      const prog = { done: 0, total: 0 };
      const tick = () => {
        prog.done++;
        const el = (Date.now() - ctl.t0) / 1000;
        const eta = prog.done >= 4 && el > 2 ? fmtEta((prog.total - prog.done) * (el / prog.done)) : undefined;
        busy(true, null, Math.min(1, prog.done / Math.max(1, prog.total)), eta);
      };

      if (f.useMyPlaylists && f.mineShare > 0) {
        try {
          const n = await gatherMine(f, cands, prog, tick, ctl);
          if (n) notes.push(n);
        } catch (e) {
          if (e.needScope || e.fatal) throw e;
          notes.push('Não consegui ler as suas playlists (' + e.message + '). Montei só com buscas.');
        }
      }
      if (ctl.cancelled) { banner('Cancelado.', true); return; }

      let plan = E.planQueries(fRun, Math.random, used);
      prog.total += plan.length;
      busy(true, 'Buscando músicas…', null, 'estimativa: ' + fmtEta(prog.total * 0.3).replace('faltam ', ''));
      let failed = await collect(plan, f, cands, tick, ctl);
      if (ctl.cancelled) { banner('Cancelado.', true); return; }
      let res = E.curate(cands, fRun);

      // Segunda chance: se faltou música, amplia a busca por gênero (sem vibe nem artistas).
      if (res.tracks.length < fRun.size * 0.8 && !ctl.rate) {
        busy(true, 'Ampliando a busca…');
        const looser = Object.assign({}, fRun, { moods: [], includeArtists: [], seedArtists: [] });
        plan = E.planQueries(looser, Math.random, used);
        prog.total += plan.length;
        failed += await collect(plan, f, cands, tick, ctl);
        if (ctl.cancelled) { banner('Cancelado.', true); return; }
        res = E.curate(cands, fRun);
      }

      if (ctl.rate) notes.push('O Spotify pediu para aguardar (limite de uso); montei com o que deu para buscar. Toque em "Outra versão" daqui a alguns minutos para completar.');
      if (f.languages.length) notes.push('Idiomas: o Spotify não informa o idioma de cada música. Usei artistas desses idiomas e descartei títulos em outros alfabetos; confira a prévia.');
      if (f.avoidHistory && histIds().size) notes.push('Evitei músicas das playlists que você já criou aqui.');

      if (!res.tracks.length && !keep.length) {
        banner(failed || ctl.rate ? 'Não consegui buscar agora. Verifique a conexão e tente de novo.'
          : 'Nenhuma música encontrada com esses filtros. Tente menos filtros (por exemplo, tire a vibe ou a época).', true);
        return;
      }
      const prevOrigin = state.origin, prevSrc = state.src;
      state.tracks = keep.length ? E.mix(keep, res.tracks) : res.tracks;
      state.origin = new Map(res.origin || []); state.src = new Map(res.src || []);
      keep.forEach((t) => { if (prevOrigin.has(t.id)) state.origin.set(t.id, prevOrigin.get(t.id)); if (prevSrc.has(t.id)) state.src.set(t.id, prevSrc.get(t.id)); });
      state.pool = cands; state.used = used; state.notes = notes; state.lastFilters = f; state.openId = null;
      $('plName').value = E.buildName(f);
      renderSaveTo();
      renderPreview(f.size);
      show('viewPreview');
    } catch (e) {
      handleError(e);
    } finally {
      busy(false);
    }
  }

  // ---------- prévia: por que entrou, manter, trocar, evitar artista ----------
  function reasonOf(id) {
    const s = state.src.get(id) || '';
    const v = s.slice(s.indexOf(':') + 1);
    if (s.startsWith('mine:')) return 'Da sua playlist “' + v + '”';
    if (s.startsWith('artist:')) return 'Artista que você pediu';
    if (s.startsWith('seed:')) return 'Sugerido pela IA';
    if (s.startsWith('g:')) return v === '*' ? 'Busca por vibe/época' : 'Busca pelo gênero “' + v + '”';
    return '';
  }
  const artistsOf = (t) => (t.artists || []).map((a) => a.name).join(', ');

  function mini(label, onClick, opts) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mini' + (opts && opts.danger ? ' danger' : ''); b.textContent = label;
    if (opts && opts.pressed != null) b.setAttribute('aria-pressed', opts.pressed ? 'true' : 'false');
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }

  function renderPreview(wanted) {
    if (wanted != null) state.wanted = wanted;
    const ul = $('trackList'); ul.textContent = '';
    state.tracks.forEach((t) => {
      const locked = state.locked.has(t.id);
      const li = document.createElement('li');
      li.className = 'track' + (locked ? ' locked' : '') + (state.openId === t.id ? ' open' : '');
      const img = (t.album && t.album.images && (t.album.images[2] || t.album.images[1] || t.album.images[0])) || null;
      let cover;
      if (img) { cover = document.createElement('img'); cover.src = img.url; cover.alt = ''; cover.loading = 'lazy'; }
      else { cover = document.createElement('div'); cover.className = 'noimg'; }
      const meta = document.createElement('div'); meta.className = 'meta';
      const name = document.createElement('div'); name.className = 'name'; name.textContent = t.name;
      const sub = document.createElement('div'); sub.className = 'sub';
      const addTag = (txt, cls) => { const tag = document.createElement('span'); tag.className = 'tag' + (cls ? ' ' + cls : ''); tag.textContent = txt; sub.appendChild(tag); };
      if (locked) addTag('★', 'mine');
      const kind = state.origin.get(t.id);
      if (kind === 'mine') addTag('Sua', 'mine'); else if (kind === 'new') addTag('Nova', 'new');
      if (t.explicit) addTag('E');
      sub.appendChild(document.createTextNode(artistsOf(t)));
      const why = document.createElement('div'); why.className = 'why'; why.textContent = reasonOf(t.id);
      meta.append(name, sub, why);
      const toggle = () => { state.openId = state.openId === t.id ? null : t.id; renderPreview(); };
      meta.addEventListener('click', toggle);
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '⋯';
      x.setAttribute('aria-label', 'Opções de ' + t.name); x.setAttribute('aria-expanded', state.openId === t.id ? 'true' : 'false');
      x.addEventListener('click', toggle);

      const acts = document.createElement('div'); acts.className = 'acts';
      acts.append(
        mini(locked ? '★ Mantida' : '☆ Manter', () => { locked ? state.locked.delete(t.id) : state.locked.add(t.id); renderPreview(); }, { pressed: locked }),
        mini('↻ Outra parecida', () => swapTrack(t.id)),
        mini('⊘ Sem este artista', () => dislikeArtist(t.id), { danger: true }),
        mini('× Remover', () => removeTrack(t.id), { danger: true })
      );
      li.append(cover, meta, x, acts);
      ul.appendChild(li);
    });
    const n = state.tracks.length;
    const nMine = state.tracks.filter((t) => state.origin.get(t.id) === 'mine').length;
    const nNew = state.tracks.filter((t) => state.origin.get(t.id) === 'new').length;
    const nLock = state.tracks.filter((t) => state.locked.has(t.id)).length;
    const wantedN = state.wanted;
    $('plStats').textContent = n + ' música' + (n === 1 ? '' : 's') +
      (nMine ? ' · ' + nMine + ' das suas playlists' : '') + (nNew ? ' · ' + nNew + ' novas' : '') + (nLock ? ' · ' + nLock + ' mantidas' : '') +
      (wantedN && n < wantedN ? ' (você pediu ' + wantedN + '; os filtros deixaram menos opções)' : '');
    $('btnRegen').textContent = nLock ? 'Outra versão (mantém ' + nLock + ')' : 'Outra versão';
    const notes = $('plNotes');
    notes.hidden = !state.notes.length; notes.textContent = state.notes.join(' ');
    $('btnSave').disabled = n === 0;
  }

  function removeTrack(id) {
    const i = state.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    state.removed.add(id); state.locked.delete(id);
    state.tracks.splice(i, 1);
    renderPreview();
  }

  // mais candidatos para trocas: algumas buscas novas por gênero (sem vibe nem artistas)
  async function moreCandidates(f) {
    const loose = Object.assign({}, f, { moods: [], includeArtists: [], seedArtists: [] });
    const plan = E.planQueries(loose, Math.random, state.used).slice(0, 4);
    if (!plan.length) return false;
    const before = state.pool.length;
    await collect(plan, f, state.pool, () => {}, { stop: false });
    return state.pool.length > before;
  }
  async function findReplacement(track, f) {
    const ff = Object.assign({}, f, { excludeIds: excludeIdsFor(f) });
    let r = E.swap(state.pool, ff, state.tracks, track, state.src.get(track.id));
    if (!r && await moreCandidates(f)) r = E.swap(state.pool, ff, state.tracks, track, state.src.get(track.id));
    return r;
  }
  function putReplacement(idx, old, r) {
    state.removed.add(old.id); state.locked.delete(old.id);
    state.tracks[idx] = r.track;
    state.origin.set(r.track.id, r.kind); state.src.set(r.track.id, r.src);
  }

  async function swapTrack(id) {
    const f = state.lastFilters || readFilters();
    const idx = state.tracks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    busy(true, 'Buscando outra parecida…', 0.4, '', false);
    try {
      const old = state.tracks[idx];
      const r = await findReplacement(old, f);
      if (!r) { banner('Não achei outra opção parecida agora. Tente remover essa ou tocar em "Outra versão".', true); return; }
      banner('');
      putReplacement(idx, old, r);
      state.openId = r.track.id;
    } catch (e) { handleError(e); } finally { busy(false); renderPreview(); }
  }

  async function dislikeArtist(id) {
    const f = state.lastFilters || readFilters();
    const base = state.tracks.find((t) => t.id === id);
    const a = base && base.artists && base.artists[0];
    if (!a) return;
    const key = E.norm(a.name);
    const list = E.parseList($('exArtists').value);
    if (!list.some((x) => E.norm(x) === key)) list.push(a.name);
    $('exArtists').value = list.join(', ');
    f.excludeArtists = list;
    saveFilters(readFilters());
    busy(true, 'Trocando as músicas de ' + a.name + '…', 0.4, '', false);
    let replaced = 0, dropped = 0;
    try {
      const hit = (t) => (t.artists || []).some((x) => E.norm(x.name) === key);
      const targets = state.tracks.filter(hit);
      for (const old of targets) {
        const idx = state.tracks.findIndex((t) => t.id === old.id);
        if (idx < 0) continue;
        const r = await findReplacement(old, f);
        if (r) { putReplacement(idx, old, r); replaced++; }
        else { state.removed.add(old.id); state.locked.delete(old.id); state.tracks.splice(idx, 1); dropped++; }
      }
      banner('Vou evitar “' + a.name + '” (dá para editar em Ajustar filtros > Artistas > Evitar). ' +
        replaced + ' trocada' + (replaced === 1 ? '' : 's') + (dropped ? ', ' + dropped + ' removida' + (dropped === 1 ? '' : 's') + ' sem substituta' : '') + '.', true);
      state.openId = null;
    } catch (e) { handleError(e); } finally { busy(false); renderPreview(); }
  }

  // ---------- salvar ----------
  async function save() {
    const f = state.lastFilters || readFilters();
    const target = $('saveTo').value;
    const hist = loadHist();
    busy(true, 'Salvando no Spotify…', 0.3, '', false);
    try {
      if (target !== 'new') {
        const entry = hist.find((e) => e.id === target);
        if (!entry) throw new Error('Não achei essa playlist no histórico.');
        const fresh = state.tracks.filter((t) => !entry.ids.includes(t.id));
        if (!fresh.length) { banner('Todas essas músicas já estão nessa playlist.', true); return; }
        busy(true, 'Adicionando músicas…', 0.6);
        try { await S.addItems(entry.id, fresh.map((t) => t.uri)); }
        catch (e) {
          if (e.fatal) throw e;
          throw new Error('Não consegui adicionar a “' + entry.name + '” (ela pode ter sido apagada ou alterada no Spotify). ' + e.message);
        }
        entry.ids = fresh.map((t) => t.id).concat(entry.ids); entry.date = Date.now();
        saveHist([entry].concat(hist.filter((e) => e !== entry)));
        $('doneText').textContent = fresh.length + ' músicas adicionadas a “' + entry.name + '”.';
        $('doneLink').href = entry.url || 'https://open.spotify.com/playlist/' + entry.id;
      } else {
        const name = $('plName').value.trim() || E.buildName(f);
        const pl = await S.createPlaylist(name, E.buildDescription(f), !f.isPrivate);
        busy(true, 'Adicionando músicas…', 0.6);
        await S.addItems(pl.id, state.tracks.map((t) => t.uri));
        const url = (pl.external_urls && pl.external_urls.spotify) || 'https://open.spotify.com/playlist/' + pl.id;
        saveHist([{ id: pl.id, name, url, date: Date.now(), ids: state.tracks.map((t) => t.id) }].concat(hist));
        $('doneText').textContent = '“' + name + '” com ' + state.tracks.length + ' músicas já está na sua biblioteca.';
        $('doneLink').href = url;
      }
      show('viewDone');
    } catch (e) {
      handleError(e);
    } finally {
      busy(false);
    }
  }

  function handleError(e) {
    console.error(e);
    if (e && e.needScope) {
      banner(e.message + ' Toque em "Autorizar acesso às minhas playlists" para reconectar uma vez.');
      $('btnReconnect').hidden = false;
      show('viewFilters');
      return;
    }
    banner((e && e.message) || 'Algo deu errado.');
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
    box.append(tag, document.createTextNode('Entendi: ' + r.summary + '.'));
    (r.warnings || []).filter(Boolean).forEach((w) => {
      const s = document.createElement('span'); s.className = 'warn'; s.textContent = w; box.appendChild(s);
    });
  }

  function applyInterpreted(found) {
    const cur = readFilters();
    // pedido novo: zera o conteúdo e os ajustes de quantidade; mantém país, privacidade, ao vivo/explícitas, histórico e artistas a evitar
    const base = {
      genres: [], moods: [], decades: [], languages: [], includeArtists: [], seedArtists: [], excludeArtists: cur.excludeArtists,
      size: 30, maxPerArtist: 0, market: cur.market,
      avoidNoisy: cur.avoidNoisy, noExplicit: cur.noExplicit, isPrivate: cur.isPrivate, avoidHistory: cur.avoidHistory,
      useMyPlaylists: false, mineShare: 40, newShare: 0,
    };
    writeFilters(Object.assign(base, found));
    resetMineSelection();
    saveFilters(readFilters());
  }

  async function interpretRequest(ctl) {
    banner('');
    $('btnReconnect').hidden = true;
    try {
      const r = await N.interpret($('nlText').value, { apiUrl: (window.CONFIG && window.CONFIG.API_URL) || '', curate: $('curateAI').checked });
      if (ctl && ctl.cancelled) return { cancelled: true };
      if (!r.error) applyInterpreted(r.filters);
      showNl(r);
      return r;
    } catch (e) {
      if (ctl && ctl.cancelled) return { cancelled: true };
      const r = { error: 'Não consegui interpretar agora. Use os filtros em "Ajustar filtros manualmente".' };
      showNl(r);
      return r;
    }
  }

  // Um toque: interpreta o pedido (regras locais + IA) e já monta a prévia.
  async function buildFromText() {
    const text = $('nlText').value;
    lsSet(DRAFT, text);
    const btn = $('btnBuild');
    btn.disabled = true; btn.textContent = 'Interpretando…';
    const ctl = newRun();
    busy(true, 'Entendendo o pedido…', 0.1, 'até uns 10 s', true);
    try {
      const r = await interpretRequest(ctl);
      if (r.cancelled) { banner('Cancelado.', true); return; }
      busy(false);
      if (r && !r.error) { rememberPrompt(text); btn.textContent = 'Montando…'; await generate(); }
    } finally {
      busy(false);
      btn.disabled = false; btn.textContent = 'Montar playlist';
    }
  }

  // ---------- início ----------
  async function init() {
    $('size').addEventListener('input', syncLabels);
    $('mineShare').addEventListener('input', syncLabels);
    $('newShare').addEventListener('input', syncLabels);
    $('btnAddGenre').addEventListener('click', addCustomGenre);
    $('customGenre').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomGenre(); } });
    $('btnBuild').addEventListener('click', buildFromText);
    $('nlText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); buildFromText(); } });
    $('nlText').addEventListener('input', () => lsSet(DRAFT, $('nlText').value));
    $('btnReconnect').addEventListener('click', () => { lsSet(DRAFT, $('nlText').value); lsSet(AUTORUN, '1'); S.login(); });
    $('btnGenerate').addEventListener('click', () => generate());
    $('btnRegen').addEventListener('click', () => generate({ keep: true }));
    $('btnBack').addEventListener('click', () => show('viewFilters'));
    $('btnSave').addEventListener('click', save);
    $('btnAgain').addEventListener('click', () => { state.tracks = []; state.locked = new Set(); state.removed = new Set(); show('viewFilters'); });
    $('btnReset').addEventListener('click', () => { writeFilters({}); saveFilters({}); resetMineSelection(); });
    $('btnLogin').addEventListener('click', () => S.login());
    $('btnLogout').addEventListener('click', () => { S.logout(); searchCache.clear(); itemsCache.clear(); state.playlists = null; resetMineSelection(); banner(''); show('viewLogin'); });
    $('busyCancel').addEventListener('click', () => {
      if (run.ctl) { run.ctl.stop = true; run.ctl.cancelled = true; }
      $('busyText').textContent = 'Cancelando…'; $('busyCancel').hidden = true;
    });
    $('btnClearRecents').addEventListener('click', () => { lsDel(PKEY); renderRecents(); });
    $('btnClearHist').addEventListener('click', () => { lsDel(HKEY); refreshHistUi(); banner('Histórico apagado. As playlists no Spotify continuam lá.', true); });
    $('saveTo').addEventListener('change', () => { $('plName').disabled = $('saveTo').value !== 'new'; });

    writeFilters(loadFilters());
    renderPresets(); renderRecents(); refreshHistUi();
    const draft = lsGet(DRAFT); if (draft) $('nlText').value = draft;

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
      S.me().then((u) => { if (u && u.display_name) $('hello').textContent = 'Olá, ' + u.display_name + '! O que vamos ouvir?'; })
        .catch((e) => { if (e.fatal) handleError(e); });
      $('hello').textContent = 'O que vamos ouvir?';
      // voltou da reconexão: continua o pedido que estava em andamento
      if (lsGet(AUTORUN) === '1') {
        lsDel(AUTORUN);
        if (S.hasScope('playlist-read-private') && $('nlText').value.trim()) buildFromText();
      }
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
