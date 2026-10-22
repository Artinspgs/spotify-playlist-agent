/*
 * spotify.js — login (OAuth Authorization Code + PKCE, sem backend) e chamadas
 * da Web API que o app usa. Endpoints conforme o guia de migração de fev/2026:
 *   GET  /search                       (limit máx. 10)
 *   POST /me/playlists                 (substitui /users/{id}/playlists)
 *   POST /playlists/{id}/items         (substitui /tracks)
 *   GET  /me/playlists, GET /playlists/{id}/items   (ler as playlists do usuário: só as dele/colaborativas)
 */
(function () {
  'use strict';
  const API = 'https://api.spotify.com/v1';
  const AUTH = 'https://accounts.spotify.com/authorize';
  const TOKEN = 'https://accounts.spotify.com/api/token';
  const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private playlist-read-collaborative';
  const LS = {
    tok: 'spa_tokens', ver: 'spa_verifier', state: 'spa_state',
  };

  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const clientId = () => (window.CONFIG && window.CONFIG.CLIENT_ID) || '';
  const configured = () => clientId() && !clientId().startsWith('COLE_');

  const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const a = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(a, (x) => chars[x % chars.length]).join('');
  };

  const readTok = () => { try { return JSON.parse(localStorage.getItem(LS.tok)); } catch (e) { return null; } };
  const saveTok = (t) => localStorage.setItem(LS.tok, JSON.stringify(t));
  const isLoggedIn = () => !!readTok();
  // permissões concedidas no último login (logins antigos não têm as de leitura de playlists)
  const hasScope = (name) => { const t = readTok(); return !!(t && String(t.scope || '').split(/\s+/).includes(name)); };
  const logout = () => { localStorage.removeItem(LS.tok); };

  async function login() {
    const verifier = rand(96);
    const state = rand(16);
    localStorage.setItem(LS.ver, verifier);
    localStorage.setItem(LS.state, state);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const p = new URLSearchParams({
      client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
      scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge, state,
    });
    location.href = AUTH + '?' + p;
  }

  async function tokenRequest(body) {
    const r = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || 'Falha no login');
    return j;
  }

  // Chamar no carregamento: finaliza o login se voltamos do Spotify com ?code=
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (q.get('error')) {
      history.replaceState({}, '', redirectUri());
      throw new Error(q.get('error') === 'access_denied' ? 'Login cancelado.' : 'Erro no login: ' + q.get('error'));
    }
    const code = q.get('code');
    if (!code) return false;
    const okState = q.get('state') === localStorage.getItem(LS.state);
    const verifier = localStorage.getItem(LS.ver);
    history.replaceState({}, '', redirectUri());
    if (!okState || !verifier) throw new Error('Sessão de login inválida. Tente entrar de novo.');
    const j = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: clientId(), code_verifier: verifier,
    });
    saveTok({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + j.expires_in * 1000, scope: j.scope || '' });
    localStorage.removeItem(LS.ver); localStorage.removeItem(LS.state);
    return true;
  }

  async function accessToken(force) {
    let t = readTok();
    if (!t) throw fatal('Você não está conectado.');
    if (force || Date.now() > t.exp - 60000) {
      try {
        const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() });
        t = { access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + j.expires_in * 1000, scope: j.scope || t.scope || '' };
        saveTok(t);
      } catch (e) {
        logout();
        throw fatal('Sua sessão expirou. Entre novamente.');
      }
    }
    return t.access;
  }

  function fatal(msg) { const e = new Error(msg); e.fatal = true; return e; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // O Spotify limita as chamadas numa janela de 30s. Ao receber 429, TODAS as chamadas esperam juntas.
  let cooldownUntil = 0, nextSlot = 0;
  const GAP_MS = 110; // ritmo mínimo entre chamadas (~9 por segundo)
  async function pace() {
    const now = Date.now();
    const wait = Math.max(cooldownUntil - now, nextSlot - now, 0);
    nextSlot = Math.max(now, nextSlot) + GAP_MS;
    if (wait > 0) await sleep(wait);
  }

  async function api(path, opts) {
    opts = opts || {};
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await pace();
      const token = await accessToken(false);
      const url = API + path + (opts.params ? '?' + new URLSearchParams(opts.params) : '');
      const r = await fetch(url, {
        method: opts.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (r.status === 429) {
        const wait = Math.min(parseInt(r.headers.get('Retry-After') || '2', 10) || 2, 20);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait * 1000);
        if (attempt === 3) { const e = new Error('O Spotify pediu para aguardar (limite de uso). Tente de novo em alguns minutos.'); e.rate = true; throw e; }
        continue;
      }
      if (r.status === 401 && !refreshed) { refreshed = true; await accessToken(true); continue; }
      if (r.status === 401) { logout(); throw fatal('Sua sessão expirou. Entre novamente.'); }
      if (r.status === 403 && opts.soft403) return { forbidden: true };
      if (r.status === 403) {
        throw fatal('O Spotify recusou o acesso (403). Em modo de desenvolvimento só entram até 5 pessoas cadastradas: ' +
          'quem administra o app precisa adicionar o e-mail desta conta em "User Management" no Dashboard do Spotify. ' +
          'Confira também se a conta dona do app tem Premium ativo.');
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro ' + r.status);
      return j;
    }
  }

  let meCache = null;
  const me = async () => (meCache = meCache || await api('/me'));
  const search = (q, offset, market) =>
    api('/search', { params: { q, type: 'track', limit: 10, offset: offset || 0, market: market || 'BR' } });
  const createPlaylist = (name, description, isPublic) =>
    api('/me/playlists', { method: 'POST', body: { name, description, public: !!isPublic } });
  // Todas as playlists do usuário (até 200). Devolve só metadados.
  async function listMyPlaylists() {
    const out = [];
    for (let offset = 0; offset < 200; offset += 50) {
      const j = await api('/me/playlists', { params: { limit: 50, offset } });
      (j.items || []).forEach((p) => p && out.push(p));
      if (!j.next || !(j.items || []).length) break;
    }
    return out;
  }
  // Uma página (até 50) de faixas de uma playlist. Só funciona para playlists do usuário ou colaborativas.
  async function playlistTracks(id, offset, market) {
    const j = await api('/playlists/' + encodeURIComponent(id) + '/items',
      { params: { limit: 50, offset: offset || 0, market: market || 'BR' }, soft403: true });
    if (j.forbidden) return { forbidden: true, tracks: [], total: 0 };
    const tracks = (j.items || []).map((e) => e && !e.is_local && (e.item || e.track)).filter((t) => t && t.type === 'track' && t.id);
    return { tracks, total: typeof j.total === 'number' ? j.total : 0 };
  }

  async function addItems(playlistId, uris) {
    for (let i = 0; i < uris.length; i += 100) {
      await api('/playlists/' + playlistId + '/items', { method: 'POST', body: { uris: uris.slice(i, i + 100) } });
    }
  }

  window.Spotify = { configured, redirectUri, login, logout, isLoggedIn, hasScope, handleRedirect, me, search, createPlaylist, addItems, listMyPlaylists, playlistTracks };
})();
