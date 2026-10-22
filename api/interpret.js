
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Chave do Gemini não configurada."
    });
  }

  try {
    const { prompt } = req.body || {};

    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1000) {
      return res.status(400).json({
        error: "Envie um pedido de até 1000 caracteres."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{
              text: `Converta pedidos de playlists em filtros para um aplicativo Spotify.
Retorne apenas JSON com exatamente estes campos:
{
 "genres": [],
 "moods": [],
 "decades": [],
 "includeArtists": [],
 "excludeArtists": [],
 "size": 30,
 "maxPerArtist": 2,
 "market": "BR",
 "avoidNoisy": true,
 "noExplicit": false,
 "isPrivate": true
}
Gêneros: texto livre, por exemplo mpb, rock, jazz, pop.
moods: somente animado, relaxar, foco, treino, festa, romantico, triste, estrada.
decades: somente 60s, 70s, 80s, 90s, 2000s, 2010s, 2020s.
includeArtists e excludeArtists: nomes de artistas.
size: inteiro de 10 a 100.
maxPerArtist: inteiro de 1 a 5.
market: código de país de duas letras, use BR se não especificado.
avoidNoisy: false se pedir versões ao vivo/remixes; caso contrário true.
noExplicit: true se pedir para evitar músicas explícitas; caso contrário false.
isPrivate: true por padrão.
Não invente preferências. Campos de lista devem ser arrays.`
            }]
          },
          contents: [{
            parts: [{ text: prompt.trim() }]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data.error?.status || response.status);
      return res.status(502).json({
        error: "Falha ao consultar o Gemini."
      });
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!text) {
      return res.status(502).json({
        error: "Resposta vazia do Gemini."
      });
    }

    const f = JSON.parse(text);

    const allowedMoods = [
      "animado", "relaxar", "foco", "treino",
      "festa", "romantico", "triste", "estrada"
    ];
    const allowedDecades = [
      "60s", "70s", "80s", "90s",
      "2000s", "2010s", "2020s"
    ];

    if (
      !Array.isArray(f.genres) ||
      !Array.isArray(f.moods) ||
      !Array.isArray(f.decades) ||
      !Array.isArray(f.includeArtists) ||
      !Array.isArray(f.excludeArtists) ||
      !Number.isInteger(f.size) || f.size < 10 || f.size > 100 ||
      !Number.isInteger(f.maxPerArtist) ||
      f.maxPerArtist < 1 || f.maxPerArtist > 5 ||
      typeof f.market !== "string" ||
      !/^[A-Z]{2}$/.test(f.market) ||
      typeof f.avoidNoisy !== "boolean" ||
      typeof f.noExplicit !== "boolean" ||
      typeof f.isPrivate !== "boolean"
    ) {
      return res.status(502).json({
        error: "O Gemini retornou filtros inválidos."
      });
    }

    f.moods = f.moods.filter(m => allowedMoods.includes(m));
    f.decades = f.decades.filter(d => allowedDecades.includes(d));

    f.genres = f.genres.filter(x => typeof x === "string").slice(0, 10);
    f.includeArtists = f.includeArtists.filter(x => typeof x === "string").slice(0, 20);
    f.excludeArtists = f.excludeArtists.filter(x => typeof x === "string").slice(0, 20);

    return res.status(200).json({ filters: f });
  } catch (error) {
    console.error("Interpretation error:", error.message);
    return res.status(502).json({
      error: "Não foi possível interpretar o pedido."
    });
  }
}
