# Playlist Agent — playlists no Spotify por filtros (app de celular)

App web instalável (PWA), em português, que monta playlists a partir de **gênero, vibe, época, artistas** e salva direto na sua conta do Spotify. Não tem servidor nem banco de dados: tudo roda no navegador do celular e o login usa OAuth PKCE (sem segredo guardado).

## O que ele faz

- **Pedido em linguagem natural** (novo): escreva "Rock para correr, anos 2000, sem músicas ao vivo" e os filtros são preenchidos sozinhos (veja a seção abaixo).
- Filtros: gêneros (e qualquer gênero digitado), vibe (animado, relaxar, foco, treino, festa, romântico, triste, estrada), décadas (60s–2020s), artistas a incluir/evitar, quantidade (10–100), máximo por artista, país/catálogo, sem explícitas, evitar ao vivo/remix/karaokê, playlist privada ou pública.
- Mostra uma **prévia** (capas, nomes) onde você remove faixas, renomeia a playlist ou pede "Outra versão".
- Salva no Spotify e abre a playlist no app.

## Pedido em linguagem natural

Fluxo: **texto → interpretador → validação → filtros do app → (engine, prévia, edição, salvar, como antes)**.

1. **Regras locais (grátis, sem internet):** entendem gêneros, vibes ("correr" → Treino), épocas ("anos 80 e 90", "anos 60 a 80"), quantidade, "sem ao vivo/remix", "sem palavrão", máx. por artista e playlist pública/privada.
2. **IA (Gemini, só quando precisa):** pedidos com artistas ou termos que as regras não conhecem ("Djavan dos anos 80", "sertanejo universitário"). A chamada passa pela função da Vercel em `vercel-api/` (guia próprio lá) — a chave não fica no app.
3. **Validação (`nlu.js › sanitize`):** só campos permitidos, valores válidos e limites seguros (10–100 músicas, até 5 gêneros e 5 artistas por lista, textos sem símbolos perigosos). A resposta da IA nunca muda privacidade nem país.
   **Curadoria com IA** (caixa marcada por padrão): a IA sugere de 12 a 15 artistas reais do estilo, e o app busca *esses artistas* no Spotify (na época pedida) em vez de buscar só por gênero. Isso evita músicas de artistas aleatórios. Os nomes aparecem em "Sugeridos pela IA" e você pode editar ou apagar. Artistas que o Spotify não encontrar são ignorados.
4. Os filtros aparecem nos chips/campos, você ajusta o que quiser e toca em **Gerar prévia** — o resto do app não mudou.

Sem `API_URL` no `config.js`, tudo continua funcionando só com as regras locais.

## Limitações do Spotify (importante)

Pesquisei a documentação atual (guia de migração de fev/2026). O que muda para este projeto:

| Mudança do Spotify | Efeito aqui |
|---|---|
| `/recommendations` e `/audio-features` removidos para apps novos (nov/2024) | Não dá para pedir "músicas parecidas" nem filtrar por energia/BPM. A engine monta a playlist com **buscas** (gênero + palavras da vibe + década) e curadoria própria. |
| Busca limitada a 10 resultados por chamada (fev/2026) | O app faz várias buscas (até ~24) com páginas diferentes e junta tudo. |
| Campo `popularity` removido | Não há ordenação por popularidade. |
| Modo Desenvolvimento: dono do app precisa de **Premium**; até **5 usuários** autorizados | Você (e até 4 pessoas) usam o app. Para abrir ao público seria preciso pedir "Extended Quota" ao Spotify (hoje só para organizações). |

A "vibe" é aproximada por palavras em títulos/álbuns. Funciona bem para clima geral, não é perfeita.

## Passo a passo para colocar no ar

### 1. Criar o app no Spotify
1. Entre em https://developer.spotify.com/dashboard com sua conta Premium e clique em **Create app**.
2. Em "Which API/SDKs…" marque **Web API**.
3. Em **Redirect URIs** coloque o endereço final do app (passo 3), com a barra no fim. Exemplo: `https://seunome.github.io/playlist-agent/`
   - Para testar no computador use `http://127.0.0.1:5500/` (o Spotify não aceita `localhost`).
4. Em **Settings → User Management**, adicione o nome e o e-mail da sua conta Spotify (e de quem mais for usar, máx. 5).
5. Copie o **Client ID** e cole em `config.js`.

### 2. Testar no computador (opcional)
```bash
node test.js && node test-nlu.js   # testes da engine, do interpretador e da função da Vercel
python3 -m http.server 5500 --bind 127.0.0.1
# abra http://127.0.0.1:5500/ (registre essa URL no Dashboard)
```

### 3. Publicar com HTTPS (grátis)
Qualquer hospedagem estática serve: **GitHub Pages**, Netlify, Vercel ou Cloudflare Pages. Envie todos os arquivos desta pasta. Depois volte ao Dashboard e confira que o Redirect URI é **exatamente** o endereço publicado.

### 4. Instalar no celular
- **Android (Chrome):** abra o endereço → menu ⋮ → *Instalar app*.
- **iPhone (Safari):** abra o endereço → Compartilhar → *Adicionar à Tela de Início*.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html`, `style.css` | Interface mobile |
| `app.js` | Liga a interface à engine e ao Spotify |
| `engine.js` | Planeja as buscas e cura o resultado (testável sem rede) |
| `nlu.js` | Pedido em linguagem natural: regras locais, chamada à IA e validação |
| `vercel-api/` | Função da Vercel que guarda a chave do Gemini (veja o README dela) |
| `spotify.js` | Login PKCE e chamadas à Web API (`/search`, `/me/playlists`, `/playlists/{id}/items`) |
| `config.js` | **Seu Client ID** e o endereço da função de IA (`API_URL`) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalação como app |
| `test.js`, `test-nlu.js` | Testes da engine, do interpretador e da função da Vercel |

## Problemas comuns

- **"Falta configurar"**: o `config.js` ainda está com o texto de exemplo.
- **INVALID_CLIENT / redirect_uri**: o endereço no Dashboard não é idêntico ao aberto no navegador (barra final, http vs https).
- **403 do Spotify**: seu e-mail não está em User Management, ou o Premium do dono do app venceu.
- **Poucas músicas**: filtros demais ao mesmo tempo (ex.: gênero raro + vibe + década). Tire um deles.
- **Playlists de sertanejo/pagode vazias com "evitar ao vivo" ligado**: esses gêneros têm muitos álbuns ao vivo; desligue essa opção.

## Próximos passos possíveis

1. Atualizar uma playlist existente (adicionar mais músicas / trocar faixas).
2. Salvar "receitas" de filtros favoritas.
3. Enriquecer com outra fonte de dados (por exemplo, Last.fm para "artistas similares" e tags de humor), já que o Spotify fechou essas informações.
