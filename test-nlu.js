// Testes do interpretador (regras locais, validação, fluxo com IA) e da função da Vercel.
// Rode: node test-nlu.js
const assert = require('assert');
const N = require('./nlu.js');

let passed = 0;
const queue = [];
function test(title, fn) { queue.push({ title, fn }); }

// ---------- regras locais ----------
test('exemplo do pedido: rock para correr, anos 2000, sem músicas ao vivo', () => {
  const r = N.parseLocal('Rock para correr, anos 2000, sem músicas ao vivo');
  assert.deepStrictEqual(r.filters, { genres: ['rock'], moods: ['treino'], decades: ['2000s'], avoidNoisy: true });
  assert.ok(r.complete);
});

test('anos soltos: intervalo, lista, ano único, "novos"', () => {
  assert.deepStrictEqual(N.parseLocal('brasileiro novos 1990 2026').filters.decades, ['90s', '2000s', '2010s', '2020s']);
  assert.deepStrictEqual(N.parseLocal('rock de 1990 a 2005').filters.decades, ['90s', '2000s']);
  assert.deepStrictEqual(N.parseLocal('mpb 1980 e 2000').filters.decades, ['80s', '2000s']);
  assert.deepStrictEqual(N.parseLocal('pop 2005').filters.decades, ['2000s']);
  const r = N.parseLocal('funk 1990-2010 com 40 músicas').filters;
  assert.deepStrictEqual(r.decades, ['90s', '2000s', '2010s']); assert.strictEqual(r.size, 40);
  // "novas" não é mais uma década: vira uma cota de lançamentos recentes
  const nv = N.parseLocal('músicas novas de pop').filters;
  assert.strictEqual(nv.newShare, 100); assert.ok(!nv.decades);
});

test('erro da IA mostra o motivo (HTTP, timeout, rede) — com e sem filtros parciais', async () => {
  const http = async () => ({ ok: false, status: 502, json: async () => ({ error: 'ai_unavailable', detail: 'timeout' }) });
  let r = await N.interpret('quero ouvir Djavan', { apiUrl: 'x', fetch: http });            // nada entendido localmente => erro
  assert.ok(r.error.includes('HTTP 502') && r.error.includes('timeout'));
  r = await N.interpret('brasileiro novos 1990 2026', { apiUrl: 'x', curate: true, fetch: http });  // algo entendido => aviso com o motivo
  assert.ok(!r.error && r.filters.decades.length === 4 && r.warnings[0].includes('HTTP 502'));
  const net = async () => { throw new TypeError('Failed to fetch'); };
  r = await N.interpret('quero ouvir Djavan', { apiUrl: 'x', fetch: net });
  assert.ok(r.error.includes('sem conexão'));
  const abort = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };
  r = await N.interpret('quero ouvir Djavan', { apiUrl: 'x', fetch: abort });
  assert.ok(r.error.includes('demorou demais'));
});

test('décadas: lista, intervalo, formas soltas', () => {
  assert.deepStrictEqual(N.parseLocal('mpb anos 70 e 80').filters.decades, ['70s', '80s']);
  assert.deepStrictEqual(N.parseLocal('jazz anos 60 a 80').filters.decades, ['60s', '70s', '80s']);
  assert.deepStrictEqual(N.parseLocal('rock anos 90, 2000 e 2010').filters.decades, ['90s', '2000s', '2010s']);
  assert.deepStrictEqual(N.parseLocal("pop 80's").filters.decades, ['80s']);
  assert.deepStrictEqual(N.parseLocal('pop 2000s').filters.decades, ['2000s']);
});

test('quantidade e por artista não se confundem', () => {
  const r = N.parseLocal('funk pra treinar, 40 músicas, máximo 1 por artista').filters;
  assert.strictEqual(r.size, 40); assert.strictEqual(r.maxPerArtist, 1);
  const r2 = N.parseLocal('rock com 2 músicas por artista').filters;
  assert.strictEqual(r2.maxPerArtist, 2); assert.strictEqual(r2.size, undefined);
});

test('"anos 2000, 30 músicas" não vira década 30', () => {
  const r = N.parseLocal('pop anos 2000, 30 músicas').filters;
  assert.deepStrictEqual(r.decades, ['2000s']); assert.strictEqual(r.size, 30);
});

test('ao vivo: negado => avoidNoisy true; pedido => false', () => {
  assert.strictEqual(N.parseLocal('samba sem ao vivo').filters.avoidNoisy, true);
  assert.strictEqual(N.parseLocal('samba sem versões ao vivo nem remix').filters.avoidNoisy, true);
  assert.strictEqual(N.parseLocal('sertanejo com ao vivo').filters.avoidNoisy, false);
});

test('explícitas, privacidade, gêneros compostos', () => {
  assert.strictEqual(N.parseLocal('pop sem palavrão').filters.noExplicit, true);
  assert.strictEqual(N.parseLocal('rock playlist pública').filters.isPrivate, false);
  assert.deepStrictEqual(N.parseLocal('pop rock').filters.genres, ['pop rock']);
  assert.deepStrictEqual(N.parseLocal('k-pop e hip hop').filters.genres.sort(), ['hip hop', 'k-pop']);
  assert.deepStrictEqual(N.parseLocal('música eletrônica').filters.genres, ['electronic']);
});

test('sem entender tudo => incompleto (vai para a IA)', () => {
  const a = N.parseLocal('sertanejo universitário');
  assert.ok(!a.complete); assert.deepStrictEqual(a.leftover, ['universitario']);
  const b = N.parseLocal('quero ouvir Djavan');
  assert.ok(!b.complete && !N.hasContent(b.filters));
});

// ---------- validação ----------
test('sanitize: descarta campos desconhecidos e valores fora do limite', () => {
  const { filters, warnings } = N.sanitize({
    genres: ['Rock', 'rock', 'hip-hop', 'x"; DROP', 123, 'a'.repeat(80)],
    moods: ['TREINO', 'inexistente'], decades: ['2000s', '1990', '80s', '1800s'],
    includeArtists: ['Djavan', 'Fulano <script>', 'Djavan'], excludeArtists: ['Beltrano'],
    size: 9999, maxPerArtist: 4, avoidNoisy: 'true', noExplicit: true,
    isPrivate: false, market: 'br', hack: 'x', __proto__: { polluted: 1 },
  });
  assert.deepStrictEqual(filters.genres, ['rock', 'hip hop']);
  assert.deepStrictEqual(filters.moods, ['treino']);
  assert.deepStrictEqual(filters.decades, ['80s', '90s', '2000s']);
  assert.deepStrictEqual(filters.includeArtists, ['Djavan', 'Fulano script']); // símbolos perigosos viram espaço
  assert.deepStrictEqual(filters.excludeArtists, ['Beltrano']);
  assert.strictEqual(filters.size, 200);          // 9999 => limite máximo
  assert.strictEqual(filters.maxPerArtist, 3);
  assert.strictEqual(filters.avoidNoisy, undefined);   // string não é booleano
  assert.strictEqual(filters.noExplicit, true);
  assert.strictEqual(filters.isPrivate, false);         // vindo de regra local, permitido
  assert.strictEqual(filters.market, 'BR');
  assert.ok(!('hack' in filters) && !('polluted' in filters));
  assert.ok(warnings.length >= 2);
});

test('sanitize: resposta da IA nunca muda privacidade nem país', () => {
  const { filters } = N.sanitize({ genres: ['rock'], isPrivate: false, market: 'US' }, { fromAI: true });
  assert.ok(!('isPrivate' in filters) && !('market' in filters));
});

test('sanitize: tamanho vira múltiplo de 5 dentro de 10..100; lixo vira vazio', () => {
  assert.strictEqual(N.sanitize({ size: 33 }).filters.size, 35);
  assert.strictEqual(N.sanitize({ size: 2 }).filters.size, 10);
  assert.deepStrictEqual(N.sanitize(null).filters, {});
  assert.deepStrictEqual(N.sanitize([1, 2]).filters, {});
  assert.deepStrictEqual(N.sanitize('rock').filters, {});
});

test('artista incluído e excluído ao mesmo tempo: fica só como excluído', () => {
  const f = N.sanitize({ includeArtists: ['Fulano'], excludeArtists: ['fulano'] }).filters;
  assert.ok(!f.includeArtists); assert.deepStrictEqual(f.excludeArtists, ['fulano']);
});

// ---------- orquestração ----------
const okFetch = (filters, spy) => async (url, opts) => {
  if (spy) spy.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, json: async () => ({ filters }) };
};

test('interpret: pedido simples NÃO chama a IA', async () => {
  const calls = [];
  const r = await N.interpret('Rock para correr, anos 2000', { apiUrl: 'https://x/api', fetch: okFetch({}, calls) });
  assert.strictEqual(r.source, 'local'); assert.strictEqual(calls.length, 0);
  assert.ok(r.summary.includes('rock'));
});

test('interpret: pedido com artista chama a IA e valida a resposta', async () => {
  const calls = [];
  const ai = { genres: ['mpb'], includeArtists: ['Djavan'], decades: ['80s'], size: 500, isPrivate: false, evil: 1 };
  const r = await N.interpret('quero ouvir Djavan dos anos 80', { apiUrl: 'https://x/api', fetch: okFetch(ai, calls) });
  assert.strictEqual(r.source, 'ai'); assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].body, { text: 'quero ouvir Djavan dos anos 80' }); // só o texto sai do app
  assert.deepStrictEqual(r.filters.includeArtists, ['Djavan']);
  assert.strictEqual(r.filters.size, undefined);        // 500 não aparece no pedido => descartado
  assert.ok(!('isPrivate' in r.filters) && !('evil' in r.filters));
});

test('IA que inventa padrões (size 10, noExplicit false) não contamina os filtros', async () => {
  const ai = { includeArtists: ['Djavan'], size: 10, noExplicit: false };   // resposta real observada
  const r = await N.interpret('quero ouvir Djavan dos anos 80', { apiUrl: 'x', fetch: okFetch(ai) });
  assert.deepStrictEqual(r.filters, { decades: ['80s'], includeArtists: ['Djavan'] });
});

test('IA não pode incluir artista que o pedido não cita; tolera erro leve de digitação', async () => {
  let r = await N.interpret('algo parecido com Djavan', { apiUrl: 'x', fetch: okFetch({ genres: ['mpb'], includeArtists: ['Caetano Veloso'] }) });
  assert.deepStrictEqual(r.filters, { genres: ['mpb'] });
  r = await N.interpret('quero ouvir djavn', { apiUrl: 'x', fetch: okFetch({ includeArtists: ['Djavan'] }) });
  assert.deepStrictEqual(r.filters.includeArtists, ['Djavan']);
});

test('IA: booleanos e números só valem com evidência no texto', async () => {
  const ai = { genres: ['jazz'], size: 30, avoidNoisy: true, noExplicit: true, maxPerArtist: 2, decades: ['90s'] };
  let r = await N.interpret('jazz de bar', { apiUrl: 'x', fetch: okFetch(ai) });
  assert.deepStrictEqual(r.filters, { genres: ['jazz'] });
  r = await N.interpret('jazz de bar sem palavrão, 30 músicas da década de 90 e só ao vivo nada de repetir artista demais',
    { apiUrl: 'x', fetch: okFetch(ai) });
  assert.strictEqual(r.filters.size, 30); assert.strictEqual(r.filters.noExplicit, true);
});

test('interpret: regras locais explícitas prevalecem sobre a IA', async () => {
  const ai = { genres: ['sertanejo'], size: 80, avoidNoisy: false };
  const r = await N.interpret('sertanejo universitário 30 músicas sem ao vivo', { apiUrl: 'x', fetch: okFetch(ai) });
  assert.strictEqual(r.filters.size, 30); assert.strictEqual(r.filters.avoidNoisy, true);
});

test('interpret: IA fora do ar => aplica o parcial local e avisa', async () => {
  const bad = async () => { throw new Error('rede'); };
  const r = await N.interpret('sertanejo universitário', { apiUrl: 'x', fetch: bad });
  assert.strictEqual(r.source, 'local-partial'); assert.deepStrictEqual(r.filters.genres, ['sertanejo']);
  assert.ok(r.warnings[0].includes('universitario'));
});

test('interpret: limite 429 => mensagem própria; nada reconhecido => erro', async () => {
  const lim = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const r = await N.interpret('quero ouvir Djavan', { apiUrl: 'x', fetch: lim });
  assert.ok(r.error && r.error.includes('limite'));
});

test('interpret: sem IA configurada e sem entender => erro útil; vazio => erro', async () => {
  const r = await N.interpret('quero ouvir Djavan', {});
  assert.ok(r.error);
  assert.ok((await N.interpret('   ', {})).error);
});

test('interpret: IA devolve {} (pedido fora de música) => erro, não filtros vazios', async () => {
  const r = await N.interpret('qual a capital da França', { apiUrl: 'x', fetch: okFetch({}) });
  assert.ok(r.error);
});

test('texto é limitado a 400 caracteres', async () => {
  const calls = [];
  await N.interpret('quero ouvir ' + 'Fulano '.repeat(100), { apiUrl: 'x', fetch: okFetch({ genres: ['pop'] }, calls) });
  assert.ok(calls[0].body.text.length <= 400);
});

test('curadoria: pedido simples + IA => regras locais mandam, IA só acrescenta artistas sugeridos', async () => {
  const calls = [];
  const ai = { genres: ['pop'], decades: ['80s'], suggestedArtists: ['Charlie Brown Jr.', 'Skank', 'Skank', 'AC/DC', 'x"; DROP', 'Fulano'], excludeArtists: ['Fulano'] };
  const r = await N.interpret('Rock para correr, anos 2000', { apiUrl: 'x', curate: true, fetch: okFetch(ai, calls) });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(r.source, 'ai');
  assert.deepStrictEqual(r.filters.genres, ['rock']);            // a IA não troca o que as regras entenderam
  assert.deepStrictEqual(r.filters.decades, ['2000s']);
  assert.deepStrictEqual(r.filters.seedArtists, ['Charlie Brown Jr.', 'Skank', 'AC/DC', 'Fulano']);   // sem repetidos nem lixo
  assert.ok(!r.filters.excludeArtists);                          // a IA não pode vetar artista que o usuário não citou
});

test('curadoria: limite de 40 sugeridos; vetados pelo usuário saem da lista', async () => {
  const many = Array.from({ length: 60 }, (_, i) => 'Banda ' + String.fromCharCode(65 + (i % 26)) + i);
  const ai = { suggestedArtists: many.concat(['Skank']) };
  const r = await N.interpret('rock anos 90 sem Skank', { apiUrl: 'x', curate: true, fetch: okFetch(Object.assign(ai, { excludeArtists: ['Skank'] })) });
  assert.strictEqual(r.filters.seedArtists.length, 40);
  assert.ok(!r.filters.seedArtists.includes('Skank'));
});

test('curadoria: sem a opção ligada, pedido simples não chama a IA', async () => {
  const calls = [];
  const r = await N.interpret('Rock para correr, anos 2000', { apiUrl: 'x', curate: false, fetch: okFetch({}, calls) });
  assert.strictEqual(calls.length, 0); assert.strictEqual(r.source, 'local');
});

test('curadoria: IA fora do ar => segue só com gênero e época e avisa', async () => {
  const bad = async () => { throw new Error('rede'); };
  const r = await N.interpret('Rock para correr, anos 2000', { apiUrl: 'x', curate: true, fetch: bad });
  assert.strictEqual(r.source, 'local'); assert.deepStrictEqual(r.filters.genres, ['rock']);
  assert.ok(r.warnings[0].includes('sem artistas sugeridos'));
});

test('sugeridos só são aceitos vindos da IA (nunca de regras locais)', () => {
  assert.ok(!N.sanitize({ genres: ['rock'], suggestedArtists: ['Skank'] }).filters.seedArtists);
  assert.deepStrictEqual(N.sanitize({ suggestedArtists: ['Skank'] }, { fromAI: true }).filters.seedArtists, ['Skank']);
});

test('seu pedido de exemplo (200 músicas, pt+en, minhas playlists, novas) é entendido localmente', () => {
  const r = N.parseLocal('Quero musicas seomente musicas em portugues e ingles, qualquer data, quero uma playlist com 200 musicas, do genero hiphop e rap e pop pode pesquisar as minhas playlist e pegar musicas deles e novas');
  assert.deepStrictEqual(r.filters, { genres: ['hip hop', 'rap', 'pop'], size: 200, languages: ['pt', 'en'], useMyPlaylists: true, mineShare: 40, newShare: 30 });
});

test('idiomas: português, inglês, brasileiro; "rock nacional" não vira idioma', () => {
  assert.deepStrictEqual(N.parseLocal('pop em português e inglês').filters.languages, ['pt', 'en']);
  assert.deepStrictEqual(N.parseLocal('funk brasileiro').filters.languages, ['pt']);
  assert.ok(!N.parseLocal('rock nacional anos 80').filters.languages);
  assert.deepStrictEqual(N.parseLocal('rap japonês e coreano').filters.languages, ['ja', 'ko']);
});

test('novas: sozinha = só novas (100); misturada = 30; com suas playlists = 30', () => {
  assert.strictEqual(N.parseLocal('rap só lançamentos').filters.newShare, 100);
  assert.strictEqual(N.parseLocal('pop e novas').filters.newShare, 30);
  assert.strictEqual(N.parseLocal('pop com algumas novas').filters.newShare, 30);
  const f = N.parseLocal('pop com minhas playlists, músicas novas').filters;
  assert.strictEqual(f.newShare, 30); assert.strictEqual(f.useMyPlaylists, true);
  assert.ok(!N.parseLocal('crie uma playlist nova de rock').filters.newShare);     // singular não conta
});

test('"minhas playlists": reconhece variações e usa 40% por padrão', () => {
  ['usar as minhas playlists', 'pega das minhas músicas', 'da minha biblioteca', 'meus favoritos'].forEach((c) => {
    const f = N.parseLocal('rock ' + c).filters;
    assert.strictEqual(f.useMyPlaylists, true, c); assert.strictEqual(f.mineShare, 40, c);
  });
});

test('validação dos campos novos: idiomas, porcentagens e ancoragem', async () => {
  const s = N.sanitize({ languages: ['PT', 'inglês', 'klingon', 'ja'], useMyPlaylists: true, mineShare: 77, newShare: 130 });
  assert.deepStrictEqual(s.filters.languages, ['pt', 'en', 'ja']);
  assert.strictEqual(s.filters.mineShare, 75); assert.strictEqual(s.filters.newShare, 100);
  assert.ok(!N.sanitize({ useMyPlaylists: 'sim' }).filters.useMyPlaylists);                 // só booleano de verdade
  // a IA não pode ativar o que o pedido não menciona
  const ai = { genres: ['rock'], languages: ['en'], useMyPlaylists: true, mineShare: 50, newShare: 40 };
  const r = await N.interpret('rock dos anos 90', { apiUrl: 'x', curate: true, fetch: okFetch(ai) });
  assert.ok(!r.filters.languages && !r.filters.useMyPlaylists && !r.filters.newShare && !r.filters.mineShare);
});

test('IA completa o que as regras não pegaram (idioma) quando o pedido menciona', async () => {
  const ai = { languages: ['en'], suggestedArtists: ['Eminem'] };
  const r = await N.interpret('quero rap americano em english', { apiUrl: 'x', curate: true, fetch: okFetch(ai) });
  assert.deepStrictEqual(r.filters.languages, ['en']); assert.deepStrictEqual(r.filters.seedArtists, ['Eminem']);
});

test('tamanho de até 200 é aceito; acima disso é limitado', () => {
  assert.strictEqual(N.parseLocal('rap 200 músicas').filters.size, 200);
  assert.strictEqual(N.sanitize({ size: 250 }).filters.size, 200);
});

// ---------- função da Vercel ----------
function mockRes() {
  const r = { code: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const geminiReply = (obj) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });

test('função: bloqueia origem não permitida e responde preflight', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.ALLOWED_ORIGINS = 'https://user.github.io/';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  let res = mockRes(); await h({ method: 'POST', headers: { origin: 'https://evil.com' }, body: { text: 'rock' } }, res);
  assert.strictEqual(res.code, 403); assert.ok(!res.headers['Access-Control-Allow-Origin']);
  res = mockRes(); await h({ method: 'OPTIONS', headers: { origin: 'https://user.github.io' } }, res);
  assert.strictEqual(res.code, 204); assert.strictEqual(res.headers['Access-Control-Allow-Origin'], 'https://user.github.io');
});

test('função: chama o Gemini com a chave no header, filtra a resposta e nunca devolve a chave', async () => {
  process.env.GEMINI_API_KEY = 'SEGREDO123'; process.env.ALLOWED_ORIGINS = 'https://user.github.io';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { seen.push({ url, opts }); return geminiReply({ genres: ['mpb'], includeArtists: ['Djavan'], decades: ['80s', 'xx'], size: 5000, hack: 'x', isPrivate: false, useMyPlaylists: true }); };
  try {
    const res = mockRes();
    await h({ method: 'POST', headers: { origin: 'https://user.github.io', 'x-forwarded-for': '1.1.1.1' }, body: { text: 'quero Djavan anos 80' } }, res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.filters, { genres: ['mpb'], decades: ['80s'], includeArtists: ['Djavan'], size: 200, useMyPlaylists: true });
    assert.ok(!JSON.stringify(res.body).includes('SEGREDO123'));
    assert.strictEqual(seen[0].opts.headers['x-goog-api-key'], 'SEGREDO123');
    assert.ok(!seen[0].url.includes('SEGREDO123'));            // chave nunca na URL
    const body = JSON.parse(seen[0].opts.body);
    assert.strictEqual(body.generationConfig.temperature, 0);
    assert.ok(body.contents[0].parts[0].text.includes('quero Djavan anos 80'));
  } finally { global.fetch = realFetch; }
});

test('função: registro mínimo não guarda o texto nem o IP, e o teto diário bloqueia', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.ALLOWED_ORIGINS = 'https://user.github.io'; process.env.DAILY_LIMIT = '2';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  const realFetch = global.fetch, realLog = console.log, lines = [];
  console.log = (l) => lines.push(String(l));
  global.fetch = async () => geminiReply({ genres: ['rock'] });
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await h({ method: 'POST', headers: { origin: 'https://user.github.io', 'x-forwarded-for': '9.9.9.' + i }, body: { text: 'frase secreta de teste ' + i } }, res);
      codes.push(res.code);
    }
    assert.deepStrictEqual(codes, [200, 200, 429]);
    const all = lines.join('\n');
    assert.ok(!all.includes('secreta') && !all.includes('9.9.9'));
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.err, 'daily_limit'); assert.strictEqual(last.status, 429); assert.ok(typeof last.ms === 'number');
  } finally { global.fetch = realFetch; console.log = realLog; delete process.env.DAILY_LIMIT; }
});

test('função: repassa artistas sugeridos (até 40, limpos)', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.ALLOWED_ORIGINS = 'https://user.github.io';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  const realFetch = global.fetch;
  const names = Array.from({ length: 60 }, (_, i) => 'Banda ' + i);
  global.fetch = async () => geminiReply({ genres: ['rock'], suggestedArtists: names.concat([42, null]) });
  try {
    const res = mockRes();
    await h({ method: 'POST', headers: { origin: 'https://user.github.io', 'x-forwarded-for': '7.7.7.7' }, body: { text: 'rock anos 2000' } }, res);
    assert.strictEqual(res.body.filters.suggestedArtists.length, 40);
  } finally { global.fetch = realFetch; }
});

test('função: valida entrada (tipo, tamanho, método) e limita pedidos por IP', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.ALLOWED_ORIGINS = 'https://user.github.io';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  const realFetch = global.fetch; global.fetch = async () => geminiReply({ genres: ['rock'] });
  const mk = (body, ip, method) => ({ method: method || 'POST', headers: { origin: 'https://user.github.io', 'x-forwarded-for': ip }, body });
  try {
    let res = mockRes(); await h(mk({ text: 123 }, '2.2.2.2'), res); assert.strictEqual(res.code, 400);
    res = mockRes(); await h(mk({ text: 'a'.repeat(401) }, '2.2.2.2'), res); assert.strictEqual(res.code, 400);
    res = mockRes(); await h(mk({}, '2.2.2.2', 'GET'), res); assert.strictEqual(res.code, 405);
    let last;
    for (let i = 0; i < 25; i++) { last = mockRes(); await h(mk({ text: 'rock' }, '3.3.3.3'), last); }
    assert.strictEqual(last.code, 429);
  } finally { global.fetch = realFetch; }
});

test('função: erro do Gemini vira 502 genérico (sem vazar detalhes); 429 vira ai_quota', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.ALLOWED_ORIGINS = 'https://user.github.io';
  delete require.cache[require.resolve('./vercel-api/api/interpret.js')];
  const h = require('./vercel-api/api/interpret.js');
  const realFetch = global.fetch, realErr = console.error; console.error = () => {};
  const mk = (ip) => ({ method: 'POST', headers: { origin: 'https://user.github.io', 'x-forwarded-for': ip }, body: { text: 'rock' } });
  try {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'detalhe interno' } }) });
    let res = mockRes(); await h(mk('4.4.4.4'), res);
    assert.strictEqual(res.code, 502); assert.strictEqual(res.body.error, 'ai_unavailable');
    assert.ok(res.body.detail.includes('gemini_500') && !JSON.stringify(res.body).includes('"k"'));
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
    res = mockRes(); await h(mk('5.5.5.5'), res);
    assert.strictEqual(res.code, 429); assert.deepStrictEqual(res.body, { error: 'ai_quota' });
    // erro de esquema (400) => tenta de novo sem esquema e funciona
    let n = 0;
    global.fetch = async (u, o) => (++n === 1 ? { ok: false, status: 400, json: async () => ({ error: { message: 'schema' } }) } : geminiReply({ genres: ['jazz'] }));
    res = mockRes(); await h(mk('6.6.6.6'), res);
    assert.strictEqual(res.code, 200); assert.deepStrictEqual(res.body.filters, { genres: ['jazz'] });
  } finally { global.fetch = realFetch; console.error = realErr; }
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log('ok -', t.title); }
    catch (e) { console.log('FALHOU -', t.title, '\n   ', e.message); process.exitCode = 1; }
  }
  console.log('\n' + passed + '/' + queue.length + ' testes passaram');
})();
