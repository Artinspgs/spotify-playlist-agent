// Testes da engine com dados simulados. Rode: node test.js
const assert = require('assert');
const E = require('./engine.js');

let n = 0;
const rng = () => E.mulberry32(42);
function mk(id, name, artist, extra) {
  return Object.assign({
    id, uri: 'spotify:track:' + id, name, type: 'track', explicit: false,
    artists: [{ id: 'a_' + artist, name: artist }], album: { name: 'Album ' + id, images: [] },
  }, extra || {});
}
function test(title, fn) { fn(); n++; console.log('ok -', title); }

test('planQueries: monta consultas com gênero, vibe e década, sem repetir', () => {
  const used = new Set();
  const plan = E.planQueries({ genres: ['rock', 'mpb'], moods: ['treino'], decades: ['90s'], size: 30 }, E.mulberry32(1), used);
  assert.ok(plan.length >= 6 && plan.length <= 24);
  plan.forEach((p) => {
    assert.ok(/genre:"(rock|mpb)"/.test(p.q), p.q);
    assert.ok(p.q.includes('year:1990-1999'), p.q);
    assert.ok(p.offset % 10 === 0 && p.offset <= 190);
  });
  const keys = plan.map((p) => p.q + '|' + p.offset);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('planQueries: artistas incluídos viram 3 páginas cada', () => {
  const plan = E.planQueries({ includeArtists: ['Djavan'], size: 20 }, E.mulberry32(2), new Set());
  const a = plan.filter((p) => p.src === 'artist:Djavan');
  assert.deepStrictEqual(a.map((p) => p.offset), [0, 10, 20]);
});

test('planQueries: aspas no gênero não quebram a consulta', () => {
  const plan = E.planQueries({ genres: ['rock"; DROP'], size: 10 }, E.mulberry32(3), new Set());
  assert.ok(!plan[0].q.includes('";'));
});

test('planQueries: sem filtro nenhum não inventa busca; só vibe usa palavras-chave', () => {
  assert.strictEqual(E.planQueries({ size: 10 }, E.mulberry32(4), new Set()).length, 0);
  const plan = E.planQueries({ moods: ['treino'], size: 20 }, E.mulberry32(4), new Set());
  assert.ok(plan.length > 0 && plan.every((p) => !p.q.includes('genre:')));
});

test('planQueries: com gênero/época a vibe NÃO entra na busca (evita faixas aleatórias)', () => {
  const plan = E.planQueries({ genres: ['rock'], moods: ['treino'], decades: ['2000s'], size: 30 }, E.mulberry32(1), new Set());
  plan.forEach((p) => assert.ok(!/workout|gym|treino|energy|power/.test(p.q), p.q));
});

test('planQueries: artistas sugeridos pela IA => 1 página cada, com época, sem buscas genéricas', () => {
  const plan = E.planQueries({ seedArtists: ['Charlie Brown Jr.', 'Skank'], genres: ['rock'], decades: ['2000s'], size: 30 }, E.mulberry32(1), new Set());
  assert.deepStrictEqual(plan.map((p) => p.src), ['seed:Charlie Brown Jr.', 'seed:Skank']);
  plan.forEach((p) => { assert.strictEqual(p.offset, 0); assert.ok(p.q.includes('year:2000-2009')); });
});

test('planQueries: décadas não contíguas viram uma faixa única nas buscas por artista', () => {
  const plan = E.planQueries({ includeArtists: ['Djavan'], decades: ['80s', '2000s'], size: 20 }, E.mulberry32(1), new Set());
  assert.ok(plan[0].q.includes('year:1980-2009'));
});

test('curate: remove duplicadas, ao vivo/remix, explícitas e artistas excluídos', () => {
  const c = [
    { src: 'g:rock', track: mk('1', 'Hit', 'A') },
    { src: 'g:rock', track: mk('1', 'Hit', 'A') },                       // mesmo id
    { src: 'g:rock', track: mk('2', 'Hit (Remastered 2011)', 'A') },     // mesma música normalizada
    { src: 'g:rock', track: mk('3', 'Canção (Ao Vivo)', 'B') },          // ao vivo
    { src: 'g:rock', track: mk('4', 'Outra - Remix', 'C') },             // remix
    { src: 'g:rock', track: mk('5', 'Palavrão', 'D', { explicit: true }) },
    { src: 'g:rock', track: mk('6', 'Vetada', 'Ed Sheeran Fan') },
    { src: 'g:rock', track: mk('7', 'Boa', 'E') },
    { src: 'g:rock', track: mk('8', 'Indisponível', 'F', { is_playable: false }) },
    { src: 'g:rock', track: null },
  ];
  const r = E.curate(c, { size: 10, avoidNoisy: true, noExplicit: true, excludeArtists: ['ed sheeran fan'], maxPerArtist: 5 }, E.mulberry32(5));
  const ids = r.tracks.map((t) => t.id).sort();
  assert.deepStrictEqual(ids, ['1', '7']);
});

test('curate: respeita o limite por artista e o tamanho pedido', () => {
  const c = [];
  for (let i = 0; i < 40; i++) c.push({ src: 'g:pop', track: mk('x' + i, 'Faixa ' + i, 'Art' + (i % 4)) });
  const r = E.curate(c, { size: 8, maxPerArtist: 2 }, E.mulberry32(6));
  assert.strictEqual(r.tracks.length, 8);
  const counts = {};
  r.tracks.forEach((t) => (counts[t.artists[0].name] = (counts[t.artists[0].name] || 0) + 1));
  Object.values(counts).forEach((v) => assert.ok(v <= 2));
});

test('curate: equilibra gêneros (round-robin)', () => {
  const c = [];
  for (let i = 0; i < 30; i++) c.push({ src: 'g:rock', track: mk('r' + i, 'Rock ' + i, 'R' + i) });
  for (let i = 0; i < 30; i++) c.push({ src: 'g:samba', track: mk('s' + i, 'Samba ' + i, 'S' + i) });
  const r = E.curate(c, { size: 20, maxPerArtist: 1 }, E.mulberry32(7));
  const rock = r.tracks.filter((t) => t.id.startsWith('r')).length;
  assert.ok(rock >= 9 && rock <= 11, 'rock=' + rock);
});

test('curate: artista sugerido pela IA também só vale se for mesmo ele', () => {
  const c = [
    { src: 'seed:Skank', track: mk('k1', 'Garota Nacional', 'Skank') },
    { src: 'seed:Skank', track: mk('k2', 'Parecida', 'Banda Qualquer') },
  ];
  const r = E.curate(c, { size: 5, maxPerArtist: 2 }, E.mulberry32(8));
  assert.deepStrictEqual(r.tracks.map((t) => t.id), ['k1']);
});

test('curate: "Paralamas do Sucesso" casa com "Os Paralamas do Sucesso"', () => {
  const c = [{ src: 'seed:Paralamas do Sucesso', track: mk('p1', 'Lanterna dos Afogados', 'Os Paralamas do Sucesso') },
             { src: 'seed:Paralamas do Sucesso', track: mk('p2', 'Outra', 'Os Paralamas Cover Band') }];
  const r = E.curate(c, { size: 5, maxPerArtist: 2 }, E.mulberry32(13));
  assert.deepStrictEqual(r.tracks.map((t) => t.id), ['p1']);
});

test('curate: resultados melhor posicionados na busca têm preferência', () => {
  const c = [];
  for (let i = 0; i < 20; i++) c.push({ src: 'g:rock', rank: i * 5, track: mk('z' + i, 'Faixa ' + i, 'Art' + i) });
  const r = E.curate(c, { size: 5, maxPerArtist: 1 }, E.mulberry32(11));
  r.tracks.forEach((t) => assert.ok(+t.id.slice(1) < 8, t.id)); // só das primeiras posições
});

test('curate: artista pedido pelo usuário pode passar do limite por artista (até 5)', () => {
  const c = [];
  for (let i = 0; i < 12; i++) c.push({ src: 'artist:Djavan', track: mk('dj' + i, 'Canção ' + i, 'Djavan') });
  const r = E.curate(c, { size: 10, maxPerArtist: 2 }, E.mulberry32(12));
  assert.strictEqual(r.tracks.length, 5);
});

test('curate: artista pedido só entra se for mesmo o artista (não feat. aleatório)', () => {
  const c = [
    { src: 'artist:Djavan', track: mk('d1', 'Oceano', 'Djavan') },
    { src: 'artist:Djavan', track: mk('d2', 'Outra coisa', 'Outro Cantor') },
  ];
  const r = E.curate(c, { size: 5, maxPerArtist: 3 }, E.mulberry32(8));
  assert.deepStrictEqual(r.tracks.map((t) => t.id), ['d1']);
});

test('curate: nunca o mesmo artista duas vezes seguidas quando há alternativa', () => {
  const c = [];
  for (let i = 0; i < 6; i++) c.push({ src: 'g:x', track: mk('p' + i, 'P' + i, 'P' + (i % 2)) });
  for (let i = 0; i < 6; i++) c.push({ src: 'g:x', track: mk('q' + i, 'Q' + i, 'Q' + (i % 3)) });
  const r = E.curate(c, { size: 12, maxPerArtist: 4 }, E.mulberry32(9));
  for (let i = 1; i < r.tracks.length; i++) {
    assert.notStrictEqual(r.tracks[i].artists[0].id, r.tracks[i - 1].artists[0].id);
  }
});

test('parseList / buildName / buildDescription', () => {
  assert.deepStrictEqual(E.parseList(' Djavan, djavan ;Caetano\n'), ['Djavan', 'Caetano']);
  assert.strictEqual(E.buildName({ genres: ['rock'], moods: ['treino'], decades: ['90s'] }), 'Rock • Treino • 90s');
  assert.strictEqual(E.buildName({}), 'Minha playlist');
  assert.ok(E.buildDescription({ genres: ['rock'] }).length <= 300);
});

test('curate 200: cotas de suas playlists e novas, filtro de alfabeto', () => {
  const c = [];
  const mk = (id, name, art, year) => ({ id, uri: 'spotify:track:' + id, name, artists: [{ id: art, name: art }], album: { release_date: year + '-01-01', images: [] }, explicit: false });
  for (let i = 0; i < 120; i++) c.push({ src: 'mine:Rap', rank: 0, track: mk('m' + i, 'Mine ' + i, 'MA' + (i % 30), 2015) });
  for (let i = 0; i < 160; i++) c.push({ src: 'seed:X', rank: i, track: mk('n' + i, 'New ' + i, 'NA' + (i % 40), 2026) });
  for (let i = 0; i < 100; i++) c.push({ src: 'g:pop', rank: i, track: mk('o' + i, 'Other ' + i, 'OA' + (i % 50), 2010) });
  c.push({ src: 'g:pop', rank: 0, track: mk('jp', '日本語の歌', 'JP', 2020) });
  const f = { size: 200, languages: ['pt', 'en'], useMyPlaylists: true, mineShare: 40, newShare: 30, recentFrom: 2025, seedArtists: ['X'] };
  const r = E.curate(c, f, E.mulberry32(3));
  assert.ok(r.tracks.length >= 150 && r.tracks.length <= 200);
  assert.ok(!r.tracks.some((t) => t.id === 'jp'));
  const nm = r.tracks.filter((t) => r.origin.get(t.id) === 'mine').length;
  assert.ok(nm >= 40, 'minhas: ' + nm);
  assert.ok(new Set(r.tracks.map((t) => t.id)).size === r.tracks.length);
});

test('pickPlaylists: só próprias, por nome do gênero', () => {
  const pl = [
    { id: '1', name: 'Rap Nacional', owner: { id: 'me' }, items: { total: 30 } },
    { id: '2', name: 'Outra', owner: { id: 'x' }, items: { total: 99 } },
    { id: '3', name: 'Vazia', owner: { id: 'me' }, items: { total: 0 } },
    { id: '4', name: 'Pop 2020', owner: { id: 'me' }, items: { total: 10 } },
  ];
  const r = E.pickPlaylists(pl, { meId: 'me', genres: ['rap', 'pop'] });
  assert.deepStrictEqual(r.chosen.map((p) => p.id).sort(), ['1', '4']);
  assert.ok(r.byName);
});

test('curate: excludeIds e mapa de origem (src) por faixa', () => {
  const mk = (id, art) => ({ id, uri: 'u' + id, name: 'T' + id, artists: [{ id: art, name: art }], album: { release_date: '2020-01-01', images: [] } });
  const c = [];
  for (let i = 0; i < 10; i++) c.push({ src: 'seed:A' + (i % 2), rank: i, track: mk('x' + i, 'A' + (i % 2)) });
  const r = E.curate(c, { size: 8, excludeIds: ['x0', 'x1'], maxPerArtist: 10 }, E.mulberry32(1));
  assert.ok(!r.tracks.some((t) => t.id === 'x0' || t.id === 'x1'));
  r.tracks.forEach((t) => assert.ok(/^seed:A[01]$/.test(r.src.get(t.id))));
});

test('swap: troca por outra da mesma origem, respeitando limites e ids', () => {
  const mk = (id, art) => ({ id, uri: 'u' + id, name: 'Faixa ' + id, artists: [{ id: art, name: art }], album: { release_date: '2015-01-01', images: [] } });
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push({ src: 'seed:Foo', rank: i, track: mk('f' + i, 'Foo') });
  for (let i = 0; i < 6; i++) pool.push({ src: 'seed:Bar', rank: i, track: mk('b' + i, 'Bar') });
  const cur = [pool[0].track, pool[1].track, pool[6].track];
  const r = E.swap(pool, { maxPerArtist: 3 }, cur, pool[0].track, 'seed:Foo', E.mulberry32(2));
  assert.ok(r && r.track.artists[0].name === 'Foo' && !cur.some((t) => t.id === r.track.id));
  assert.strictEqual(r.src, 'seed:Foo');
  // artista no limite (2 de Foo mantendo cap 2) => cai para outra origem
  const r2 = E.swap(pool, { maxPerArtist: 2 }, cur, pool[6].track, 'seed:Bar', E.mulberry32(2));
  assert.ok(r2 && r2.track.artists[0].name === 'Bar');
  // sem candidatos
  assert.strictEqual(E.swap(pool.slice(0, 2), {}, cur, pool[0].track, 'seed:Foo'), null);
  // artista evitado nunca volta
  const r3 = E.swap(pool, { excludeArtists: ['Foo'] }, cur, pool[6].track, 'seed:Bar', E.mulberry32(3));
  assert.ok(r3 && r3.track.artists[0].name === 'Bar');
  assert.strictEqual(E.mix([pool[0].track], [pool[6].track, pool[7].track]).length, 3);
});

console.log('\n' + n + ' testes passaram');
