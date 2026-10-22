/*
 * engine.js — lógica pura (sem rede, sem DOM) para montar playlists.
 *
 * Por que isso existe: desde nov/2024 o Spotify removeu /recommendations e
 * /audio-features para apps novos, e em fev/2026 limitou a busca a 10 itens
 * por chamada. Então a "inteligência" fica aqui: planejamos várias buscas
 * (gênero + clima + década), juntamos os candidatos e curamos o resultado
 * (sem duplicadas, limite por artista, sem versões ao vivo/remix etc.).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Gêneros sugeridos (o usuário também pode digitar qualquer outro).
  const GENRES = [
    'pop', 'rock', 'hip hop', 'rap', 'trap', 'r&b', 'sertanejo', 'mpb', 'pagode',
    'samba', 'forro', 'funk', 'bossa nova', 'axe', 'gospel', 'electronic', 'house',
    'techno', 'edm', 'indie', 'alternative', 'metal', 'punk', 'jazz', 'blues',
    'classical', 'reggae', 'country', 'latin', 'k-pop', 'lo-fi', 'soul', 'disco',
  ];

  // "Vibe" -> palavras-chave buscadas em título/álbum/artista.
  // É uma aproximação: o Spotify não expõe mais energia/valência.
  const MOODS = {
    animado:   { label: 'Animado',        keywords: ['feliz', 'alegria', 'happy', 'good vibes', 'sunshine'] },
    relaxar:   { label: 'Relaxar',        keywords: ['relax', 'chill', 'calma', 'suave', 'acoustic'] },
    foco:      { label: 'Foco / Estudo',  keywords: ['focus', 'study', 'foco', 'concentração', 'instrumental'] },
    treino:    { label: 'Treino',         keywords: ['workout', 'gym', 'treino', 'power', 'energy'] },
    festa:     { label: 'Festa',          keywords: ['party', 'festa', 'dance', 'balada', 'night'] },
    romantico: { label: 'Romântico',      keywords: ['love', 'amor', 'romantic', 'paixão', 'coração'] },
    triste:    { label: 'Triste',         keywords: ['sad', 'saudade', 'sofrência', 'chorar', 'solidão'] },
    estrada:   { label: 'Estrada',        keywords: ['road', 'estrada', 'viagem', 'drive', 'highway'] },
  };

  const DECADES = {
    '60s': [1960, 1969], '70s': [1970, 1979], '80s': [1980, 1989], '90s': [1990, 1999],
    '2000s': [2000, 2009], '2010s': [2010, 2019], '2020s': [2020, 2029],
  };

  const NOISY = /\b(ao vivo|live|remix|karaok[eê]|karaoke|sped up|slowed|reverb|8d|cover|tribute|tributo|playback)\b/i;

  // Idiomas: o Spotify NÃO informa o idioma de uma faixa. O que dá para fazer com segurança é
// (1) pedir à IA artistas que cantam nesses idiomas e (2) descartar títulos em outros alfabetos.
  const LANGS = { pt: 'Português', en: 'English', es: 'Español', fr: 'Français', it: 'Italiano', de: 'Deutsch', ja: '日本語', ko: '한국어' };
  const SCRIPTS = {
    cyr: '\\u0400-\\u04FF', heb: '\\u0590-\\u05FF', ara: '\\u0600-\\u06FF\\u0750-\\u077F',
    dev: '\\u0900-\\u097F', tha: '\\u0E00-\\u0E7F', jpn: '\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF', kor: '\\uAC00-\\uD7AF\\u1100-\\u11FF',
  };
  function blockedScripts(langs) {
    if (!langs || !langs.length) return null;
    const allow = new Set();
    if (langs.includes('ja')) allow.add('jpn');
    if (langs.includes('ko')) allow.add('kor');
    const parts = Object.keys(SCRIPTS).filter((k) => !allow.has(k)).map((k) => SCRIPTS[k]);
    return new RegExp('[' + parts.join('') + ']');
  }

  // Quais playlists do usuário combinam com os gêneros pedidos (pelo NOME da playlist).
  const GENRE_WORDS = {
    'hip hop': ['hip hop', 'hiphop', 'rap', 'trap'], rap: ['rap', 'hip hop', 'hiphop', 'trap'], trap: ['trap', 'rap'],
    'r&b': ['r b', 'rnb', 'soul'], pop: ['pop'], rock: ['rock'], 'pop rock': ['pop rock', 'rock', 'pop'],
    sertanejo: ['sertanejo', 'sertanejas', 'sertaneja'], mpb: ['mpb'], pagode: ['pagode'], samba: ['samba'], funk: ['funk'],
    electronic: ['electronic', 'eletronica', 'edm', 'house', 'techno'], 'lo-fi': ['lo fi', 'lofi'], 'k-pop': ['k pop', 'kpop'],
  };
  function playlistScore(name, genres) {
    const n = ' ' + norm(name) + ' ';
    let score = 0;
    (genres || []).forEach((g) => {
      const words = GENRE_WORDS[g] || [norm(g)];
      if (words.some((w) => w && n.includes(' ' + w + ' '))) score++;
    });
    return score;
  }
  const playlistTotal = (p) =>
    (p.items && typeof p.items.total === 'number' ? p.items.total : p.tracks && typeof p.tracks.total === 'number' ? p.tracks.total : 0);

  function pickPlaylists(playlists, opts) {
    opts = opts || {};
    const max = opts.max || 8;
    const eligible = (playlists || []).filter((p) => p && p.id &&
      ((p.owner && p.owner.id === opts.meId) || p.collaborative) && playlistTotal(p) > 0 &&
      !/playlist agent/i.test(String(p.description || ''))); // ignora as geradas por este app
    const scored = eligible.map((p) => ({ p, s: playlistScore(p.name, opts.genres) }));
    const matched = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || playlistTotal(b.p) - playlistTotal(a.p));
    if (matched.length) return { chosen: matched.slice(0, max).map((x) => x.p), byName: true };
    const biggest = eligible.slice().sort((a, b) => playlistTotal(b) - playlistTotal(a)).slice(0, Math.min(max, 6));
    return { chosen: biggest, byName: false };
  }

  // ---------- utilidades ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function parseList(str) {
    const seen = new Set();
    return String(str || '')
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  }

  function cleanQueryValue(s) {
    return String(s).replace(/["\\]/g, ' ').trim();
  }

  // "Paralamas do Sucesso" casa com "Os Paralamas do Sucesso" (palavras inteiras, nos dois sentidos).
  function nameMatches(artistNorm, wantedNorm) {
    if (!artistNorm || !wantedNorm) return false;
    if (artistNorm === wantedNorm) return true;
    const a = ' ' + artistNorm + ' ', w = ' ' + wantedNorm + ' ';
    return a.includes(w) || w.includes(a);
  }

  // ---------- 1) planejar as buscas ----------
  // Faixa de anos que cobre as décadas escolhidas, ex.: " year:1990-1999".
  function yearClause(decadeKeys) {
    const rs = (decadeKeys || []).map((d) => DECADES[d]).filter(Boolean);
    if (!rs.length) return '';
    return ' year:' + Math.min(...rs.map((r) => r[0])) + '-' + Math.max(...rs.map((r) => r[1]));
  }

  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const recentFromYear = (f) => f.recentFrom || (new Date().getFullYear() - 1);

  function planQueries(f, rng, usedKeys) {
    rng = rng || Math.random;
    usedKeys = usedKeys || new Set();
    const size = f.size || 30;
    const plan = [];
    const push = (q, offset, src) => {
      const key = q + '|' + offset;
      if (usedKeys.has(key)) return;
      usedKeys.add(key);
      plan.push({ q, offset, src });
    };

    const genres = (f.genres && f.genres.length ? f.genres : []).map(cleanQueryValue).filter(Boolean);
    const decKeys = (f.decades || []).filter((d) => DECADES[d]);
    const yr = yearClause(decKeys);
    const included = (f.includeArtists || []).map(cleanQueryValue).filter(Boolean);
    const seeds = (f.seedArtists || []).map(cleanQueryValue).filter(Boolean).slice(0, 40);
    const newShare = clampPct(f.newShare);
    const y0 = recentFromYear(f);
    const recentYr = ' year:' + y0 + '-' + Math.max(y0, new Date().getFullYear());

    // Artistas pedidos pelo usuário: 3 páginas cada (as primeiras costumam ter os maiores sucessos).
    included.forEach((a) => [0, 10, 20].forEach((o) => push('artist:"' + a + '"' + yr, o, 'artist:' + a)));
    // Artistas sugeridos pela IA: 1ª página de cada (a mais relevante).
    seeds.forEach((a) => push('artist:"' + a + '"' + yr, 0, 'seed:' + a));
    // "Músicas novas": busca recente para parte dos artistas (proporcional ao pedido, sorteados).
    if (seeds.length && newShare > 0) {
      const n = Math.ceil(seeds.length * Math.min(1, newShare / 50));
      shuffle(seeds, rng).slice(0, n).forEach((a) => push('artist:"' + a + '"' + recentYr, 0, 'seed:' + a));
    }

    // Buscas por gênero/época. Com artistas sugeridos pela IA elas só entram como reforço (2ª rodada).
    const hasGenreOrDecade = genres.length > 0 || decKeys.length > 0;
    const artistDriven = included.length > 0 || seeds.length > 0;
    let budget = Math.max(6, Math.min(24, Math.ceil(size / 3) + 2));
    if (seeds.length || (artistDriven && !hasGenreOrDecade)) budget = 0;

    // Sem artistas e com "novas": lançamentos recentes por gênero.
    if (!seeds.length && newShare > 0) genres.forEach((g) => [0, 10].forEach((o) => push('genre:"' + g + '"' + recentYr, o, 'g:' + g)));

    // Sem gênero, época nem artistas, a "vibe" vira palavra-chave (último recurso, é imprecisa).
    const kws = [];
    if (!hasGenreOrDecade && !artistDriven) (f.moods || []).forEach((m) => MOODS[m] && kws.push(...MOODS[m].keywords));

    const decRanges = decKeys.map((d) => DECADES[d]);
    const gList = genres.length ? genres : [null];
    let i = 0, guard = 0, made = 0;
    while (made < budget && guard++ < budget * 12) {
      const g = gList[i % gList.length];
      const d = decRanges.length ? decRanges[Math.floor(i / gList.length) % decRanges.length] : null;
      i++;
      const kw = kws.length ? kws[Math.floor(rng() * kws.length)] : null;
      const parts = [];
      if (kw) parts.push(kw);
      if (g) parts.push('genre:"' + g + '"');
      if (d) parts.push('year:' + d[0] + '-' + d[1]);
      if (!parts.length) break;
      // páginas iniciais são bem mais relevantes: sorteio puxado para offsets baixos (0..90)
      const offset = Math.floor(rng() * rng() * 10) * 10;
      const q = parts.join(' ');
      const before = plan.length;
      push(q, offset, g ? 'g:' + g : 'g:*');
      if (plan.length > before) made++;
    }
    return plan;
  }

  // ---------- 2) curar os candidatos ----------
  function primaryArtist(t) {
    const a = (t.artists && t.artists[0]) || {};
    return a.id || norm(a.name);
  }

  const SPREAD = 8; // mistura leve entre as primeiras posições, sem ir buscar o fundo da lista

  /**
   * cands: [{ track, src, rank }]   src: 'artist:X' | 'seed:X' | 'g:genero' | 'mine:Playlist'
   * Devolve { tracks, found, origin } — origin: Map(trackId -> 'mine' | 'new' | 'other')
   */
  function curate(cands, f, rng) {
    rng = rng || Math.random;
    const size = f.size || 30;
    const mineShare = clampPct(f.mineShare), newShare = clampPct(f.newShare);
    const recentFrom = recentFromYear(f);
    const blocked = blockedScripts(f.languages);
    const excl = (f.excludeArtists || []).map(norm).filter(Boolean);
    const exId = new Set(f.excludeIds || []);
    const seenId = new Set(), seenKey = new Set();
    const pool = [];
    const isRecent = (t) => parseInt(String((t.album && t.album.release_date) || '').slice(0, 4), 10) >= recentFrom;

    for (const c of cands) {
      const t = c && c.track;
      if (!t || !t.id || !t.uri || !t.name) continue;
      if (t.type && t.type !== 'track') continue;
      if (t.is_playable === false) continue;
      if (exId.has(t.id)) continue;
      if (f.noExplicit && t.explicit) continue;

      const an = (t.artists || []).map((a) => norm(a.name));
      if (excl.some((e) => an.some((x) => x === e || (' ' + x + ' ').includes(' ' + e + ' ')))) continue;
      if (f.avoidNoisy && NOISY.test(t.name + ' ' + ((t.album && t.album.name) || ''))) continue;
      if (blocked && blocked.test(t.name + ' ' + (t.artists || []).map((a) => a.name).join(' ') + ' ' + ((t.album && t.album.name) || ''))) continue;
      // artista pedido/sugerido: só vale se o artista da faixa for mesmo ele (nada de "feat." aleatório)
      if ((c.src.startsWith('artist:') || c.src.startsWith('seed:')) &&
          !an.some((x) => nameMatches(x, norm(c.src.slice(c.src.indexOf(':') + 1))))) continue;

      if (seenId.has(t.id)) continue;
      const key = norm(t.name) + '|' + (an[0] || '');
      if (seenKey.has(key)) continue;
      seenId.add(t.id); seenKey.add(key);
      pool.push({ track: t, src: c.src, rank: c.rank || 0, kind: c.src.startsWith('mine:') ? 'mine' : isRecent(t) ? 'new' : 'other' });
    }

    // baldes por origem, ordenados pela posição na busca (com um pouco de sorteio)
    const buckets = new Map();
    pool.forEach((p) => {
      if (!buckets.has(p.src)) buckets.set(p.src, []);
      buckets.get(p.src).push({ t: p.track, kind: p.kind, s: p.src, k: p.rank + rng() * SPREAD });
    });
    for (const [k, list] of buckets) buckets.set(k, list.sort((x, y) => x.k - y.k));
    const keys = [...buckets.keys()];
    const artistKeys = shuffle(keys.filter((k) => k.startsWith('artist:')), rng);
    const mineKeys = shuffle(keys.filter((k) => k.startsWith('mine:')), rng);
    const otherKeys = shuffle(keys.filter((k) => !k.startsWith('artist:') && !k.startsWith('mine:')), rng);

    // limite por artista: o escolhido pelo usuário, ou automático (cresce com listas grandes)
    const nSeeds = keys.filter((k) => k.startsWith('seed:')).length;
    const cap = f.maxPerArtist > 0 ? f.maxPerArtist
      : nSeeds ? Math.min(6, Math.max(2, Math.ceil((size * (1 - mineShare / 100)) / Math.max(8, nSeeds)))) : 2;
    const capExplicit = Math.max(cap, 5); // artistas pedidos pelo usuário podem aparecer mais vezes
    const capMine = Math.max(cap, 4);     // suas playlists: mais folga

    const perArtist = new Map();
    const picked = [];
    const origin = new Map();
    const srcMap = new Map();
    const tryPick = (t, limit) => {
      const pa = primaryArtist(t);
      if ((perArtist.get(pa) || 0) >= limit) return false;
      perArtist.set(pa, (perArtist.get(pa) || 0) + 1);
      picked.push(t);
      return true;
    };
    const takeFrom = (list, pred, limit) => {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!pred(it)) continue;
        if (tryPick(it.t, limit)) { list.splice(i, 1); origin.set(it.t.id, it.kind); srcMap.set(it.t.id, it.s); return true; }
      }
      return false;
    };
    // revezando entre as origens até pegar "need" faixas (ou acabar o que dá)
    const roundRobin = (ks, pred, need, limit) => {
      const goal = Math.min(size, picked.length + need);
      let progress = true;
      while (picked.length < goal && progress) {
        progress = false;
        for (const k of ks) {
          if (picked.length >= goal) break;
          if (takeFrom(buckets.get(k), pred, limit)) progress = true;
        }
      }
    };
    const any = () => true;

    // 1) artistas pedidos pelo usuário
    for (const k of artistKeys) {
      const list = buckets.get(k);
      while (list.length && picked.length < size) { const it = list.shift(); if (tryPick(it.t, capExplicit)) { origin.set(it.t.id, it.kind); srcMap.set(it.t.id, it.s); } }
    }
    // 2) das suas playlists (cota)
    if (mineShare > 0) roundRobin(mineKeys, any, Math.round(size * mineShare / 100), capMine);
    // 3) músicas novas (cota, contando as que já entraram)
    if (newShare > 0) {
      const have = picked.filter(isRecent).length;
      roundRobin(otherKeys, (it) => it.kind === 'new', Math.max(0, Math.round(size * newShare / 100) - have), cap);
    }
    // 4) o resto: artistas sugeridos e gêneros, revezando
    roundRobin(otherKeys, any, size - picked.length, cap);
    // 5) se faltou, completa com suas playlists
    roundRobin(mineKeys, any, size - picked.length, capMine);
    // 6) ainda faltou: relaxa o limite por artista (mantém quem combina com o pedido, em vez de buscar gênero solto)
    roundRobin(otherKeys.concat(mineKeys), any, size - picked.length, cap + 3);

    return { tracks: spread(shuffle(picked, rng)), found: pool.length, origin, src: srcMap };
  }

  // Troca UMA faixa por outra parecida, usando os candidatos já buscados.
  // Prefere: mesma origem (mesmo artista sugerido/gênero/playlist) > mesmo tipo (suas/novas/outras) > qualquer uma.
  // Respeita filtros, artistas a evitar, ids a evitar e o limite por artista da playlist atual.
  function swap(cands, f, current, track, srcOfTrack, rng) {
    rng = rng || Math.random;
    const taken = new Set((current || []).map((t) => t.id));
    taken.add(track.id);
    (f.excludeIds || []).forEach((id) => taken.add(id));
    const cap = f.maxPerArtist > 0 ? f.maxPerArtist : 3;
    const counts = new Map();
    (current || []).forEach((t) => { if (t.id !== track.id) { const a = primaryArtist(t); counts.set(a, (counts.get(a) || 0) + 1); } });
    const recentFrom = recentFromYear(f);
    const isRecent = (t) => parseInt(String((t.album && t.album.release_date) || '').slice(0, 4), 10) >= recentFrom;
    const kindOf = (c) => (c.src.startsWith('mine:') ? 'mine' : isRecent(c.track) ? 'new' : 'other');
    const myKind = srcOfTrack && srcOfTrack.startsWith('mine:') ? 'mine' : isRecent(track) ? 'new' : 'other';
    const usable = (cands || []).filter((c) => c && c.track && c.src && !taken.has(c.track.id) && (counts.get(primaryArtist(c.track)) || 0) < cap);
    const tiers = [
      usable.filter((c) => c.src === srcOfTrack),
      usable.filter((c) => kindOf(c) === myKind),
      usable,
    ];
    const g = Object.assign({}, f, { size: 1, mineShare: 0, newShare: 0, maxPerArtist: 100, excludeIds: [...taken] });
    for (const tier of tiers) {
      if (!tier.length) continue;
      const r = curate(tier, g, rng);
      if (r.tracks.length) { const t = r.tracks[0]; return { track: t, kind: r.origin.get(t.id), src: r.src.get(t.id) }; }
    }
    return null;
  }

  const mix = (a, b, rng) => spread(shuffle(a.concat(b), rng || Math.random));

  // evita o mesmo artista duas vezes seguidas
  function spread(list) {
    const out = list.slice();
    for (let i = 1; i < out.length; i++) {
      if (primaryArtist(out[i]) === primaryArtist(out[i - 1])) {
        for (let j = i + 1; j < out.length; j++) {
          if (primaryArtist(out[j]) !== primaryArtist(out[i - 1]) &&
              (i + 1 >= out.length || primaryArtist(out[j]) !== primaryArtist(out[i + 1]))) {
            [out[i], out[j]] = [out[j], out[i]];
            break;
          }
        }
      }
    }
    return out;
  }

  // ---------- 3) nome e descrição ----------
  function buildName(f) {
    const bits = [];
    (f.genres || []).slice(0, 2).forEach((g) => bits.push(g.replace(/^./, (c) => c.toUpperCase())));
    (f.moods || []).slice(0, 1).forEach((m) => MOODS[m] && bits.push(MOODS[m].label));
    (f.decades || []).slice(0, 2).forEach((d) => bits.push(d));
    if (!bits.length && (f.includeArtists || []).length) bits.push('Mix ' + f.includeArtists[0]);
    return bits.length ? bits.join(' • ') : 'Minha playlist';
  }

  function buildDescription(f) {
    const parts = [];
    if ((f.genres || []).length) parts.push('Gêneros: ' + f.genres.join(', '));
    if ((f.moods || []).length) parts.push('Vibe: ' + f.moods.map((m) => (MOODS[m] ? MOODS[m].label : m)).join(', '));
    if ((f.decades || []).length) parts.push('Épocas: ' + f.decades.join(', '));
    if ((f.languages || []).length) parts.push('Idiomas: ' + f.languages.map((l) => LANGS[l] || l).join(', '));
    return ('Criada pelo Playlist Agent. ' + parts.join(' · ')).slice(0, 300);
  }

  return { GENRES, MOODS, DECADES, LANGS, NOISY, mulberry32, norm, parseList, planQueries, curate, buildName, buildDescription, pickPlaylists, playlistScore, playlistTotal, blockedScripts, swap, mix };
});
