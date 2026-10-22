/*
 * nlu.js — pedido em linguagem natural -> filtros do app.
 *
 * Fluxo:
 *   1) parseLocal():  regras gratuitas em português (sem rede)
 *   2) callAI():      só quando as regras não bastam; chama a função da Vercel (que guarda a chave do Gemini)
 *   3) sanitize():    VALIDAÇÃO — só campos permitidos, valores válidos, limites seguros
 *                     (vale para regras locais e, principalmente, para a resposta da IA)
 * O resultado alimenta os mesmos filtros/chips que já existiam; engine, prévia e salvamento não mudam.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.NLU = factory(root.Engine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const MAX_TEXT = 200;
  const DECADE_ORDER = ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'];
  const MARKETS = ['BR', 'PT', 'US', 'GB', 'MX', 'AR', 'ES', 'DE', 'FR', 'JP'];
  const PER_ARTIST = [1, 2, 3, 5, 10];
  const LIMITS = { size: [10, 100], genres: 5, artists: 5, seeds: 15 };

  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cleanStr = (s) =>
    String(s).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f"\\`<>{}\[\]|^~]/g, ' ').replace(/\s+/g, ' ').trim();

  // =====================================================================
  // 3) VALIDAÇÃO
  // =====================================================================

  // ---------- "ancoragem": da IA só vale o que o pedido realmente diz ----------
  // Modelos às vezes preenchem campos com valores padrão ou inventam artistas.
  const words = (s) => fold(cleanStr(s)).replace(/[^a-z0-9&]+/g, ' ').trim().split(' ').filter(Boolean);
  function lev1(a, b) { // iguais, ou diferem por 1 letra (palavras com 4+ letras)
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }
  const KEYS = ['genres', 'moods', 'decades', 'includeArtists', 'excludeArtists', 'suggestedArtists', 'size', 'maxPerArtist', 'avoidNoisy', 'noExplicit'];
  function ground(raw, text) {
    const t = fold(text), tw = words(text);
    const nums = (t.match(/\d+/g) || []).map(Number);
    const out = {};
    KEYS.forEach((k) => { if (raw[k] !== undefined) out[k] = raw[k]; });
    const seen = (name) => { const nw = words(name); return nw.length > 0 && nw.every((w) => tw.some((x) => lev1(x, w))); };
    ['includeArtists', 'excludeArtists'].forEach((k) => {
      if (Array.isArray(out[k])) out[k] = out[k].filter((a) => typeof a === 'string' && seen(a));
    });
    if (!nums.includes(Math.round(Number(out.size)))) delete out.size;
    if (!/artista/.test(t)) delete out.maxPerArtist;
    if (!/ao vivo|live|remix|karaok|acustic|cover/.test(t)) delete out.avoidNoisy;
    if (!/palavr|explicit|crianc|famil|limp|adult|pesad|educad/.test(t)) delete out.noExplicit;
    if (!/\d|decad|recente|atual|nostalg|retro|antig|classic/.test(t)) delete out.decades;
    return out;
  }

  const GENRE_ALIAS = {
    hiphop: 'hip hop', 'hip-hop': 'hip hop', rnb: 'r&b', 'r and b': 'r&b',
    eletronica: 'electronic', eletronico: 'electronic', electronica: 'electronic',
    lofi: 'lo-fi', 'lo fi': 'lo-fi', kpop: 'k-pop', 'k pop': 'k-pop',
    classica: 'classical', classico: 'classical', erudita: 'classical',
    alternativo: 'alternative', alternativa: 'alternative', latina: 'latin', latino: 'latin',
    sertaneja: 'sertanejo',
  };
  const GENRE_RE = /^[a-z0-9][a-z0-9 &'\-]{1,29}$/;
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'&!$+\-\/]{0,59}$/u;

  function asList(v) { return Array.isArray(v) ? v.slice(0, 20) : typeof v === 'string' ? [v] : []; }

  function toDecade(n) {
    n = String(n);
    if (n.length === 4) {
      const y = +n; if (y < 1960 || y > 2029) return null;
      const s = Math.floor(y / 10) * 10; return s >= 2000 ? s + 's' : (s % 100) + 's';
    }
    if (n.length === 2) return { 60: '60s', 70: '70s', 80: '80s', 90: '90s', '00': '2000s', 10: '2010s', 20: '2020s' }[n] || null;
    return null;
  }

  /**
   * Aceita QUALQUER objeto e devolve só o que o app permite.
   * opts.fromAI: a IA nunca muda privacidade nem país (decisões do usuário).
   */
  function sanitize(raw, opts) {
    opts = opts || {};
    const f = {}, warnings = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { filters: f, warnings: ['Resposta inválida.'] };
    if (opts.fromAI && typeof opts.text === 'string') raw = ground(raw, opts.text);

    // gêneros
    const genres = [];
    asList(raw.genres).forEach((g) => {
      if (typeof g !== 'string') return;
      let s = fold(cleanStr(g)).replace(/\s+/g, ' ').trim();
      s = GENRE_ALIAS[s] || s;
      if (GENRE_RE.test(s)) { if (!genres.includes(s)) genres.push(s); }
      else if (s) warnings.push('Gênero ignorado: "' + s.slice(0, 30) + '"');
    });
    if (genres.length) f.genres = genres.slice(0, LIMITS.genres);

    // vibes
    const moods = [];
    asList(raw.moods).forEach((m) => {
      const k = fold(cleanStr(m));
      if (Engine.MOODS[k] && !moods.includes(k)) moods.push(k);
    });
    if (moods.length) f.moods = moods;

    // décadas
    const decades = [];
    asList(raw.decades).forEach((d) => {
      let k = fold(cleanStr(d)).replace(/['\s]/g, '');
      if (/^\d{4}s?$/.test(k)) k = toDecade(k.slice(0, 4)) || k;
      else if (/^\d{2}s$/.test(k)) k = toDecade(k.slice(0, 2)) || k;
      if (DECADE_ORDER.includes(k) && !decades.includes(k)) decades.push(k);
    });
    if (decades.length) f.decades = DECADE_ORDER.filter((k) => decades.includes(k));

    // artistas
    const clean = (list, max) => {
      const out = [];
      asList(list).forEach((a) => {
        if (typeof a !== 'string') return;
        const s = cleanStr(a);
        if (NAME_RE.test(s) && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
        else if (s) warnings.push('Artista ignorado: "' + s.slice(0, 30) + '"');
      });
      return out.slice(0, max || LIMITS.artists);
    };
    const inc = clean(raw.includeArtists);
    const exc = clean(raw.excludeArtists);
    const excLower = exc.map((x) => x.toLowerCase());
    const inc2 = inc.filter((x) => !excLower.includes(x.toLowerCase()));
    if (inc2.length) f.includeArtists = inc2;
    if (exc.length) f.excludeArtists = exc;
    if (opts.fromAI) { // artistas sugeridos pela IA (curadoria): só da IA, sem repetir, sem os vetados
      const banned = exc.concat(inc2).map((x) => x.toLowerCase());
      const seeds = clean(raw.suggestedArtists, LIMITS.seeds).filter((x) => !banned.includes(x.toLowerCase()));
      if (seeds.length) f.seedArtists = seeds;
    }

    // números
    if (raw.size != null && raw.size !== '') {
      const n = Math.round(Number(raw.size));
      if (Number.isFinite(n)) {
        const c = Math.min(LIMITS.size[1], Math.max(LIMITS.size[0], n));
        if (c !== n) warnings.push('Quantidade ajustada para ' + c + ' (limite de ' + LIMITS.size[0] + ' a ' + LIMITS.size[1] + ').');
        f.size = Math.min(LIMITS.size[1], Math.max(LIMITS.size[0], Math.round(c / 5) * 5));
      }
    }
    if (raw.maxPerArtist != null && raw.maxPerArtist !== '') {
      const n = Number(raw.maxPerArtist);
      if (Number.isFinite(n) && n >= 1) f.maxPerArtist = PER_ARTIST.reduce((b, x) => (Math.abs(x - n) < Math.abs(b - n) ? x : b), PER_ARTIST[0]);
    }

    // booleanos (só true/false de verdade)
    if (typeof raw.avoidNoisy === 'boolean') f.avoidNoisy = raw.avoidNoisy;
    if (typeof raw.noExplicit === 'boolean') f.noExplicit = raw.noExplicit;
    if (!opts.fromAI) {
      if (typeof raw.isPrivate === 'boolean') f.isPrivate = raw.isPrivate;
      if (typeof raw.market === 'string' && MARKETS.includes(raw.market.toUpperCase())) f.market = raw.market.toUpperCase();
    }
    return { filters: f, warnings };
  }

  const hasContent = (f) =>
    !!(f && ((f.genres && f.genres.length) || (f.moods && f.moods.length) || (f.decades && f.decades.length) ||
      (f.includeArtists && f.includeArtists.length)));

  // =====================================================================
  // 1) REGRAS LOCAIS
  // =====================================================================
  const GENRE_RULES = [
    ['pop rock', 'pop rock'], ['rock nacional', 'rock'], ['hip ?-?hop', 'hip hop'], ['trap', 'trap'], ['rap', 'rap'],
    ['r&b|rnb|r and b', 'r&b'], ['sertanej[oa]s?', 'sertanejo'], ['mpb', 'mpb'], ['pagode', 'pagode'], ['samba', 'samba'],
    ['forro', 'forro'], ['funk', 'funk'], ['bossa nova', 'bossa nova'], ['axe', 'axe'], ['gospel', 'gospel'],
    ['eletronic[oa]s?|electronic[a]?', 'electronic'], ['edm', 'edm'], ['house', 'house'], ['techno', 'techno'],
    ['indie', 'indie'], ['alternativ[oa]s?', 'alternative'], ['metal', 'metal'], ['punk', 'punk'], ['jazz', 'jazz'],
    ['blues', 'blues'], ['classic[ao]s?|classical|erudit[ao]s?', 'classical'], ['reggae', 'reggae'], ['country', 'country'],
    ['latin[oa]s?', 'latin'], ['k-?pop', 'k-pop'], ['lo-?fi', 'lo-fi'], ['soul', 'soul'], ['disco', 'disco'],
    ['pop', 'pop'], ['rock', 'rock'],
  ];
  const MOOD_RULES = {
    treino: 'correr|corrida|correndo|treino|treinar|treinando|academia|malhar|malhacao|exercicios?|workout|gym|caminhada|pedalar|ciclismo',
    foco: 'estudar|estudo|estudando|foco|focar|concentrar|concentracao|trabalhar|trabalho|leitura',
    relaxar: 'relaxar|relaxante|relax|calma|calmo|calmas|calmos|chill|tranquil[oa]s?|dormir|sono|descansar|meditar|meditacao',
    festa: 'festa|festas|balada|baladas|dancar|danca|dancante|party|churrasco|resenha',
    animado: 'animad[oa]s?|alegre|alegres|feliz|felizes|pra cima|para cima|good vibes',
    romantico: 'romantic[oa]s?|romance|amor|namorad[oa]s?|namorar|jantar a dois|casal|apaixonad[oa]s?|paixao',
    triste: 'trist[ea]s?|saudade|saudades|sofrencia|chorar|fossa|melancoli[ac][oa]s?|dor de cotovelo',
    estrada: 'estrada|viagem|viajar|road ?trip|dirigir|dirigindo|carro|rodovia',
  };
  const STOP = new Set(('a o as os um uma uns umas de do da dos das no na nos nas em para pra pro por com e ou que me meu minha minhas meus ' +
    'quero queria gostaria crie criar cria faca fazer monte montar gere gerar preciso playlist playlists musica musicas faixa faixas som sons ' +
    'tipo estilo bem bom boa boas bons mais so apenas somente tambem favor sem nada nao anos ano mix lista ouvir tocar escutar ai aqui qualquer ' +
    'algumas alguns varias varios ate entre seu sua esse essa esta este isso ser seja tenha tem maximo minimo max min cada ' +
    'pra mim').split(' '));

  const PRE = '(^|[^a-z0-9])';
  const POST = '(?![a-z0-9])';

  // remove do texto o trecho que casou e devolve se achou
  function take(t, src, cb) {
    const re = new RegExp(PRE + '(?:' + src + ')' + POST, 'g');
    let found = false;
    const out = t.replace(re, (m, pre) => { found = true; if (cb) cb(m); return pre + ' '; });
    return [out, found];
  }

  function extractDecades(t) {
    const found = [];
    const spans = [];
    const head = new RegExp(PRE + "(?:anos|decadas?(?:\\s+de|\\s+dos\\s+anos)?)\\s*'?(\\d{2,4})'?s?" + POST, 'g');
    const tail = /^\s*(,|e|ou|a|ate)\s*'?(\d{2,4})'?s?(?![a-z0-9])/;
    let m;
    while ((m = head.exec(t))) {
      const first = toDecade(m[2]);
      if (!first) continue;
      const start = m.index + m[1].length;
      let end = head.lastIndex;
      let prev = first;
      found.push(first);
      for (;;) {
        const tm = tail.exec(t.slice(end));
        if (!tm) break;
        const d = toDecade(tm[2]);
        if (!d) break;
        if (tm[1] === 'a' || tm[1] === 'ate') {
          const i = DECADE_ORDER.indexOf(prev), j = DECADE_ORDER.indexOf(d);
          if (i >= 0 && j > i) DECADE_ORDER.slice(i + 1, j + 1).forEach((x) => found.push(x)); else found.push(d);
        } else found.push(d);
        prev = d; end += tm[0].length;
      }
      spans.push([start, end]);
      head.lastIndex = end;
    }
    for (let i = spans.length - 1; i >= 0; i--) t = t.slice(0, spans[i][0]) + ' ' + t.slice(spans[i][1]);

    // formas soltas: "90s", "80's", "2000s"
    const bare = new RegExp(PRE + "'?(\\d{2}|\\d{4})'?s" + POST, 'g');
    t = t.replace(bare, (all, pre, n) => { const d = toDecade(n); if (d) { found.push(d); return pre + ' '; } return all; });
    return [t, found];
  }

  const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, dez: 10 };

  function parseLocal(text) {
    let t = fold(text);
    const f = {};
    let hit;

    // ao vivo / remix / karaokê
    const NOISE = '(?:ao vivo|live|remix(?:es)?|karaoke)';
    const filler = '(?:(?:as|os|a|o|nenhuma|nenhum|musicas?|faixas?|versoes|versao|gravacoes|de|com)\\s+){0,3}';
    [t, hit] = take(t, '(?:sem|nada de|nao quero|nao gosto de|evit(?:ar|e|em)|exceto|menos)\\s+' + filler + NOISE +
      '(?:\\s*(?:,|e|ou)\\s*' + NOISE + ')*');
    if (hit) f.avoidNoisy = true;
    else { [t, hit] = take(t, '(?:quero\\s+|pode\\s+ter\\s+|com\\s+)?' + NOISE); if (hit) f.avoidNoisy = false; }

    // explícitas
    [t, hit] = take(t, '(?:sem|nada de|evit(?:ar|e))\\s+(?:(?:musicas?|conteudo|letras?|as|os)\\s+){0,2}(?:palavra(?:o|oes)|explicit[oa]s?|adulto|pesad[oa]s?)');
    if (hit) f.noExplicit = true;
    [t, hit] = take(t, '(?:para|pra)\\s+(?:as\\s+)?(?:criancas?|familia)');
    if (hit) f.noExplicit = true;

    // máx. por artista
    [t, hit] = take(t, '(?:sem repetir (?:o )?artistas?|artistas? (?:diferentes|variados)|varios artistas)');
    if (hit) f.maxPerArtist = 1;
    [t, hit] = take(t, '(\\d+|um|uma|dois|duas|tres|cinco|dez)\\s+(?:musicas?\\s+|faixas?\\s+)?por\\s+artista', (m) => {
      const w = /(\d+|um|uma|dois|duas|tres|cinco|dez)\s+(?:musicas?\s+|faixas?\s+)?por/.exec(m);
      if (w) f.maxPerArtist = /^\d+$/.test(w[1]) ? +w[1] : NUM_WORDS[w[1]];
    });

    // épocas
    let decs;
    [t, decs] = extractDecades(t);
    [t, hit] = take(t, 'recentes?|atuais|atual');
    if (hit) decs.push('2020s');
    if (decs.length) f.decades = decs;

    // quantidade
    [t, hit] = take(t, '(\\d{1,3})\\s*(?:musicas?|faixas?|sons?|cancoes|songs?)', (m) => {
      const n = /(\d{1,3})/.exec(m); if (n) f.size = +n[1];
    });

    // privacidade
    [t, hit] = take(t, '(?:playlist\\s+)?publica'); if (hit) f.isPrivate = false;
    [t, hit] = take(t, '(?:playlist\\s+)?privada'); if (hit) f.isPrivate = true;

    // gêneros (os de várias palavras primeiro)
    const genres = [];
    GENRE_RULES.forEach(([src, canon]) => {
      [t, hit] = take(t, src);
      if (hit && !genres.includes(canon)) genres.push(canon);
    });
    if (genres.length) f.genres = genres;

    // vibes
    const moods = [];
    Object.keys(MOOD_RULES).forEach((k) => {
      [t, hit] = take(t, MOOD_RULES[k]);
      if (hit) moods.push(k);
    });
    if (moods.length) f.moods = moods;

    const leftover = t.split(/[^a-z0-9&']+/).filter((w) => w && !STOP.has(w));
    const s = sanitize(f);
    return { filters: s.filters, warnings: s.warnings, leftover, complete: hasContent(s.filters) && leftover.length === 0 };
  }

  // =====================================================================
  // 2) IA (via função da Vercel)
  // =====================================================================
  async function callAI(apiUrl, text, fetchFn, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 12000) : null;
    try {
      const r = await (fetchFn || fetch)(apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: ctrl ? ctrl.signal : undefined,
      });
      if (r.status === 429) { const e = new Error('limite'); e.rate = true; throw e; }
      if (!r.ok) throw new Error('ia_' + r.status);
      const j = await r.json();
      return sanitize(j && j.filters, { fromAI: true, text });
    } finally { if (timer) clearTimeout(timer); }
  }

  // =====================================================================
  // Orquestração
  // =====================================================================
  const cleanText = (t) => String(t || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  function merge(local, ai) {
    const out = Object.assign({}, local);
    ['genres', 'moods', 'decades', 'includeArtists', 'excludeArtists'].forEach((k) => { if (ai[k] && ai[k].length) out[k] = ai[k]; });
    // números/booleanos: o que as regras pegaram de forma explícita tem prioridade
    ['size', 'maxPerArtist', 'avoidNoisy', 'noExplicit'].forEach((k) => { if (out[k] === undefined && ai[k] !== undefined) out[k] = ai[k]; });
    return withSeeds(out, ai);
  }

  function withSeeds(out, ai) {
    const banned = (out.excludeArtists || []).concat(out.includeArtists || []).map((x) => x.toLowerCase());
    const seeds = (ai.seedArtists || []).filter((x) => !banned.includes(x.toLowerCase()));
    if (seeds.length) out.seedArtists = seeds;
    return out;
  }

  function summarize(f) {
    const p = [];
    if (f.genres) p.push(f.genres.join(', '));
    if (f.moods) p.push(f.moods.map((m) => Engine.MOODS[m].label).join(', '));
    if (f.decades) p.push(f.decades.join(', '));
    if (f.includeArtists) p.push('artistas: ' + f.includeArtists.join(', '));
    if (f.excludeArtists) p.push('evitar: ' + f.excludeArtists.join(', '));
    if (f.seedArtists) p.push('IA sugeriu ' + f.seedArtists.length + ' artistas');
    if (f.avoidNoisy === true) p.push('sem ao vivo/remix');
    if (f.avoidNoisy === false) p.push('ao vivo permitido');
    if (f.noExplicit) p.push('sem explícitas');
    if (f.size) p.push(f.size + ' músicas');
    if (f.maxPerArtist) p.push('máx. ' + f.maxPerArtist + ' por artista');
    if (f.isPrivate === false) p.push('pública');
    if (f.isPrivate === true) p.push('privada');
    return p.join(' · ');
  }

  async function interpret(text, opts) {
    opts = opts || {};
    const clean = cleanText(text);
    if (!clean) return { error: 'Escreva o que você quer ouvir.' };

    const local = parseLocal(clean);
    const curate = !!(opts.curate && opts.apiUrl);
    if (local.complete && !curate) return { filters: local.filters, source: 'local', summary: summarize(local.filters), warnings: local.warnings };

    const missing = local.leftover.length ? 'Não entendi: "' + local.leftover.slice(0, 6).join(' ') + '".' : '';
    if (opts.apiUrl) {
      try {
        const ai = await callAI(opts.apiUrl, clean, opts.fetch, opts.timeoutMs);
        // regras locais completas: elas mandam; da IA só vêm os artistas sugeridos
        const merged = local.complete ? withSeeds(Object.assign({}, local.filters), ai.filters) : merge(local.filters, ai.filters);
        if (hasContent(merged)) {
          return { filters: merged, source: local.complete && !merged.seedArtists ? 'local' : 'ai', summary: summarize(merged), warnings: local.warnings.concat(ai.warnings) };
        }
        return { error: 'Não consegui transformar esse pedido em filtros. Tente citar um gênero, vibe, época ou artista.' };
      } catch (e) {
        const why = e && e.rate ? 'A IA atingiu o limite de uso agora.' : 'A IA não respondeu agora.';
        if (local.complete) {
          return { filters: local.filters, source: 'local', summary: summarize(local.filters),
            warnings: [why + ' Usei só gênero e época, sem artistas sugeridos.'].concat(local.warnings) };
        }
        if (hasContent(local.filters)) {
          return { filters: local.filters, source: 'local-partial', summary: summarize(local.filters),
            warnings: [why + ' Apliquei só o que entendi pelas regras. ' + missing].concat(local.warnings) };
        }
        return { error: why + ' Tente de novo em instantes ou use os filtros abaixo.' };
      }
    }
    if (hasContent(local.filters)) {
      return { filters: local.filters, source: 'local-partial', summary: summarize(local.filters),
        warnings: ['A IA não está configurada. ' + missing].concat(local.warnings) };
    }
    return { error: 'Não entendi. Tente algo como "Rock para correr, anos 2000" ou use os filtros abaixo.' };
  }

  return { MAX_TEXT, LIMITS, sanitize, parseLocal, interpret, summarize, hasContent, cleanText };
});
