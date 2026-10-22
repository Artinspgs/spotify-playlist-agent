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
    const seeds = (f.seedArtists || []).map(cleanQueryValue).filter(Boolean).slice(0, 24);

    // Artistas pedidos pelo usuário: 3 páginas cada (as primeiras costumam ter os maiores sucessos).
    included.forEach((a) => [0, 10, 20].forEach((o) => push('artist:"' + a + '"' + yr, o, 'artist:' + a)));
    // Artistas sugeridos pela IA: só a 1ª página de cada (a mais relevante).
    seeds.forEach((a) => push('artist:"' + a + '"' + yr, 0, 'seed:' + a));

    // Buscas por gênero/época. Com artistas sugeridos pela IA elas só entram como reforço (2ª rodada).
    const hasGenreOrDecade = genres.length > 0 || decKeys.length > 0;
    const artistDriven = included.length > 0 || seeds.length > 0;
    let budget = Math.max(6, Math.min(24, Math.ceil(size / 3) + 2));
    if (seeds.length || (artistDriven && !hasGenreOrDecade)) budget = 0;

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

  function curate(cands, f, rng) {
    rng = rng || Math.random;
    const size = f.size || 30;
    const cap = Math.max(1, f.maxPerArtist || 2);
    const capExplicit = Math.max(cap, 5); // artistas pedidos pelo usuário podem aparecer mais vezes
    const excl = (f.excludeArtists || []).map(norm).filter(Boolean);
    const seenId = new Set(), seenKey = new Set();
    const pool = [];

    for (const c of cands) {
      const t = c && c.track;
      if (!t || !t.id || !t.uri || !t.name) continue;
      if (t.type && t.type !== 'track') continue;
      if (t.is_playable === false) continue;
      if (f.noExplicit && t.explicit) continue;

      const an = (t.artists || []).map((a) => norm(a.name));
      if (excl.some((e) => an.some((x) => x === e || (' ' + x + ' ').includes(' ' + e + ' ')))) continue;
      if (f.avoidNoisy && NOISY.test(t.name + ' ' + ((t.album && t.album.name) || ''))) continue;
      // artista pedido/sugerido: só vale se o artista da faixa for mesmo ele (nada de "feat." aleatório)
      if ((c.src.startsWith('artist:') || c.src.startsWith('seed:')) &&
          !an.some((x) => nameMatches(x, norm(c.src.slice(c.src.indexOf(':') + 1))))) continue;

      if (seenId.has(t.id)) continue;
      const key = norm(t.name) + '|' + (an[0] || '');
      if (seenKey.has(key)) continue;
      seenId.add(t.id); seenKey.add(key);
      pool.push({ track: t, src: c.src, rank: c.rank || 0 });
    }

    // baldes por origem, ordenados pela posição na busca (com um pouco de sorteio)
    const buckets = new Map();
    pool.forEach((p) => {
      if (!buckets.has(p.src)) buckets.set(p.src, []);
      buckets.get(p.src).push({ t: p.track, k: p.rank + rng() * SPREAD });
    });
    for (const [k, list] of buckets) buckets.set(k, list.sort((x, y) => x.k - y.k).map((x) => x.t));
    const keys = [...buckets.keys()];
    const artistKeys = shuffle(keys.filter((k) => k.startsWith('artist:')), rng);
    const otherKeys = shuffle(keys.filter((k) => !k.startsWith('artist:')), rng);
    // (artistas pedidos: todos primeiro; sugeridos e gêneros: revezando)

    const perArtist = new Map();
    const picked = [];
    const tryPick = (t, limit) => {
      const pa = primaryArtist(t);
      if ((perArtist.get(pa) || 0) >= limit) return false;
      perArtist.set(pa, (perArtist.get(pa) || 0) + 1);
      picked.push(t);
      return true;
    };

    // 1) artistas pedidos primeiro
    // (artistas sugeridos pela IA entram junto com os gêneros, no revezamento abaixo)
    for (const k of artistKeys) {
      const list = buckets.get(k);
      while (list.length && picked.length < size) tryPick(list.shift(), capExplicit);
    }
    // 2) sugeridos pela IA e gêneros, revezando entre as origens
    let progress = true;
    while (picked.length < size && progress) {
      progress = false;
      for (const k of otherKeys) {
        const list = buckets.get(k);
        while (list.length) {
          if (tryPick(list.shift(), cap)) { progress = true; break; }
        }
        if (picked.length >= size) break;
      }
    }

    return { tracks: spread(shuffle(picked, rng)), found: pool.length };
  }

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
    return ('Criada pelo Playlist Agent. ' + parts.join(' · ')).slice(0, 300);
  }

  return { GENRES, MOODS, DECADES, NOISY, mulberry32, norm, parseList, planQueries, curate, buildName, buildDescription };
});
