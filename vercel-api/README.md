# Função de IA (Vercel) — mantém a chave do Gemini fora do app

Esta pasta é um projeto Vercel separado do app. Ele expõe `POST /api/interpret`, que recebe o texto do pedido, consulta o Gemini e devolve **só filtros** (gêneros, vibes, épocas, artistas, quantidade...). A chave fica em variável de ambiente da Vercel e nunca vai para o celular nem para o GitHub.

## Passo a passo

### 1. Colocar esta pasta no seu projeto da Vercel
Escolha **uma** das opções:
- **Repositório novo** só com o conteúdo desta pasta (`api/interpret.js` + `package.json` na raiz) e importe na Vercel; **ou**
- No repositório do app, deixe esta pasta como `vercel-api/` e, no projeto da Vercel, vá em *Settings → General → Root Directory* e defina `vercel-api`.

### 2. Variáveis de ambiente (*Settings → Environment Variables*)
| Nome | Valor |
|---|---|
| `GEMINI_API_KEY` | sua chave do Gemini (Google AI Studio) |
| `ALLOWED_ORIGINS` | só a origem do app, sem caminho: `https://SEUUSUARIO.github.io` (várias: separe por vírgula; para testar local: `,http://127.0.0.1:5500`) |
| `GEMINI_MODEL` | *(opcional)* padrão `gemini-3.5-flash-lite`; se quiser mais qualidade: `gemini-3.8-flash` |

Marque *Production*. **Depois de salvar, faça um novo deploy** (as variáveis só valem para deploys novos).

### 3. Testar
```bash
curl -X POST https://SEU-PROJETO.vercel.app/api/interpret \
  -H "Origin: https://SEUUSUARIO.github.io" -H "Content-Type: application/json" \
  -d '{"text":"quero ouvir Djavan dos anos 80"}'
```
Resposta esperada: `{"filters":{"genres":["mpb"],"includeArtists":["Djavan"],"decades":["80s"]}}`.

Sem o cabeçalho `Origin` correto a resposta é `403` — é o comportamento certo.

### 4. Ligar o app
No `config.js` do app:
```js
API_URL: 'https://SEU-PROJETO.vercel.app/api/interpret',
```

## Se algo falhar
- **Resposta HTML pedindo login da Vercel / 401**: *Settings → Deployment Protection* está bloqueando. Use a proteção padrão (que não cobre o domínio de produção) ou desative para Production.
- **403 `origin_not_allowed`**: `ALLOWED_ORIGINS` diferente da origem do app (confira `https`, usuário, sem barra e sem `/repositorio`).
- **500 `server_not_configured`**: falta `GEMINI_API_KEY` ou faltou redeploy.
- **502 `ai_unavailable`**: veja *Logs* do projeto na Vercel (erro do Gemini, modelo indisponível). Troque `GEMINI_MODEL`.
- **429**: limite por IP (20 pedidos / 10 min) ou cota do Gemini.

## Segurança — o que protege e o que não protege
- A chave **nunca** sai da Vercel; o app só envia o texto (até 200 caracteres).
- CORS só aceita a origem do seu app e há limite de pedidos por IP. **Isso não é à prova de abuso**: alguém pode chamar a URL fora do navegador forjando o cabeçalho `Origin`, e o limite por IP é em memória (por instância). Por isso, no Google AI Studio/Cloud defina **cota diária e alerta de gasto** para a chave.
- A resposta do Gemini passa por um esquema fechado, por filtragem aqui e por nova validação no app (`nlu.js`). A IA nunca decide privacidade da playlist nem país.
- Nunca cole a chave no código, no `config.js` ou em chats. Se ela vazar, revogue e crie outra.
- Os pedidos viram texto enviado ao Gemini. No nível gratuito da API o Google pode usar os dados para melhorar produtos — confira os termos vigentes.
