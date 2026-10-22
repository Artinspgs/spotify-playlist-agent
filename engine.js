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

  // ---------- 1) planejar as buscas ----------
  function planQueries(f, rng, usedKeys) {
    rng = rng || Math.random;
    usedKeys = usedKeys || new Set();
    const size = f.size || 30;
    const budget = Math.max(6, Math.min(24, Math.ceil(size / 3) + 2));

    const genres = (f.genres && f.genres.length ? f.genres : [null]).map((g) => g && cleanQueryValue(g));
    const decades = (f.decades && f.decades.length ? f.decades : [])
      .map((d) => DECADES[d]).filter(Boolean);
    const kws = [];
    (f.moods || []).forEach((m) => MOODS[m] && kws.push(...MOODS[m].keywords));

    const plan = [];

    // Artistas pedidos: 3 páginas cada (30 faixas) — a 1ª página costuma ter os maiores hits.
    (f.includeArtists || []).forEach((raw) => {
      const a = cleanQueryValue(raw);
      if (!a) return;
      [0, 10, 20].forEach((offset) => {
        const key = `artist:"${a}"|${offset}`;
        if (usedKeys.has(key)) return;
        usedKeys.add(key);
        plan.push({ q: `artist:"${a}"`, offset, src: 'artist:' + a });
      });
    });

    let i = 0, guard = 0, made = 0;
    while (made < budget && guard++ < budget * 12) {
      const g = genres[i % genres.length];
      const d = decades.length ? decades[Math.floor(i / genres.length) % decades.length] : null;
      i++;
      const kw = kws.length ? kws[Math.floor(rng() * kws.length)] : null;
      const parts = [];
      if (kw) parts.push(kw);
      if (g) parts.push(`genre:"${g}"`);
      if (d) parts.push(`year:${d[0]}-${d[1]}`);
      if (!parts.length) parts.push('year:1960-2029');
      const q = parts.join(' ');
      const maxSlot = kw ? 9 : 19; // palavras-chave estreitam o resultado
      const offset = Math.floor(rng() * (maxSlot + 1)) * 10;
      const key = `${q}|${offset}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      plan.push({ q, offset, src: g ? 'g:' + g : 'g:*' });
      made++;
    }
    return plan;
  }

  // ---------- 2) curar os candidatos ----------
  function primaryArtist(t) {
    const a = (t.artists && t.artists[0]) || {};
    return a.id || norm(a.name);
  }

  function curate(cands, f, rng) {
    rng = rng || Math.random;
    const size = f.size || 30;
    const cap = Math.max(1, f.maxPerArtist || 2);
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
      if (c.src.startsWith('artist:') && !an.includes(norm(c.src.slice(7)))) continue;

      if (seenId.has(t.id)) continue;
      const key = norm(t.name) + '|' + (an[0] || '');
      if (seenKey.has(key)) continue;
      seenId.add(t.id); seenKey.add(key);
      pool.push({ track: t, src: c.src });
    }

    // baldes por origem; artistas pedidos primeiro
    const buckets = new Map();
    pool.forEach((p) => {
      if (!buckets.has(p.src)) buckets.set(p.src, []);
      buckets.get(p.src).push(p.track);
    });
    const keys = [...buckets.keys()];
    const artistKeys = keys.filter((k) => k.startsWith('artist:'));
    const otherKeys = shuffle(keys.filter((k) => !k.startsWith('artist:')), rng);
    for (const k of keys) buckets.set(k, shuffle(buckets.get(k), rng));

    const perArtist = new Map();
    const picked = [];
    const tryPick = (t) => {
      const pa = primaryArtist(t);
      if ((perArtist.get(pa) || 0) >= cap) return false;
      perArtist.set(pa, (perArtist.get(pa) || 0) + 1);
      picked.push(t);
      return true;
    };

    for (const k of artistKeys) {
      const list = buckets.get(k);
      while (list.length && picked.length < size) {
        const t = list.shift();
        if (!tryPick(t)) { /* artista já no limite */ }
      }
    }
    let progress = true;
    while (picked.length < size && progress) {
      progress = false;
      for (const k of otherKeys) {
        const list = buckets.get(k);
        while (list.length) {
          const t = list.shift();
          if (tryPick(t)) { progress = true; break; }
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
