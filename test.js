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

test('planQueries: sem nenhum filtro ainda gera consulta válida', () => {
  const plan = E.planQueries({ size: 10 }, E.mulberry32(4), new Set());
  assert.ok(plan.length > 0 && plan[0].q.length > 0);
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

console.log('\n' + n + ' testes passaram');
