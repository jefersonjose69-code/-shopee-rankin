const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const SHOPEE_API_URL =
  "https://open-api.affiliate.shopee.com.br/graphql";

const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// ==========================================
// ASSINATURA SHOPEE
// ==========================================

function createSignature(timestamp, payload) {
  const raw =
    SHOPEE_APP_ID +
    timestamp +
    payload +
    SHOPEE_SECRET;

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex");
}

async function shopeeRequest(query) {
  if (!SHOPEE_APP_ID || !SHOPEE_SECRET) {
    throw new Error(
      "Credenciais da Shopee não configuradas no Render."
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query });
  const signature = createSignature(timestamp, payload);

  const authorization =
    `SHA256 Credential=${SHOPEE_APP_ID}, ` +
    `Timestamp=${timestamp}, ` +
    `Signature=${signature}`;

  const response = await fetch(SHOPEE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization
    },
    body: payload,
    signal: AbortSignal.timeout(25000)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopee HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  if (data.errors) {
    throw new Error(
      `Shopee API: ${JSON.stringify(data.errors)}`
    );
  }

  return data;
}

// ==========================================
// PÁGINA PRINCIPAL
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// RANKING DE PRODUTOS
// ==========================================

app.get("/api/produtos", async (req, res) => {
  try {
    const todosProdutos = [];
    const ids = new Set();
    let paginasConsultadas = 0;

    for (let pagina = 1; pagina <= 10; pagina++) {
      const query = `
        {
          productOfferV2(
            sortType: 2
            page: ${pagina}
            limit: 50
          ) {
            nodes {
              productName
              itemId
              commissionRate
              commission
              sales
              priceMin
              priceMax
              imageUrl
              shopName
              productLink
              offerLink
              ratingStar
              priceDiscountRate
            }
            pageInfo {
              page
              limit
              hasNextPage
            }
          }
        }
      `;

      const data = await shopeeRequest(query);
      paginasConsultadas++;

      const produtos =
        data?.data?.productOfferV2?.nodes || [];

      for (const produto of produtos) {
        const id = String(produto.itemId || "");

        if (id && !ids.has(id)) {
          ids.add(id);
          todosProdutos.push(produto);
        }
      }

      const pageInfo =
        data?.data?.productOfferV2?.pageInfo;

      if (!pageInfo?.hasNextPage || produtos.length === 0) {
        break;
      }
    }

    todosProdutos.sort(
      (a, b) => Number(b.sales || 0) - Number(a.sales || 0)
    );

    res.json({
      success: true,
      total: todosProdutos.length,
      paginasConsultadas,
      produtos: todosProdutos
    });
  } catch (error) {
    console.error("Erro no ranking:", error.message);

    res.status(500).json({
      success: false,
      error: error.message || "Não foi possível carregar os produtos."
    });
  }
});

// ==========================================
// PROXY SEGURO PARA IMAGENS DA SHOPEE
// ==========================================

function enderecoDeImagemPermitido(valor) {
  try {
    const endereco = new URL(valor);

    if (endereco.protocol !== "https:") {
      return false;
    }

    const host = endereco.hostname.toLowerCase();

    return (
      host === "susercontent.com" ||
      host.endsWith(".susercontent.com") ||
      host === "shopee.com.br" ||
      host.endsWith(".shopee.com.br")
    );
  } catch {
    return false;
  }
}

app.get("/api/imagem", async (req, res) => {
  try {
    const urlImagem = String(req.query.url || "");

    if (!urlImagem || !enderecoDeImagemPermitido(urlImagem)) {
      return res.status(400).json({
        success: false,
        error: "Endereço de imagem inválido ou não permitido."
      });
    }

    let enderecoAtual = urlImagem;
    let resposta;

    for (let tentativa = 0; tentativa <= 3; tentativa++) {
      resposta = await fetch(enderecoAtual, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (resposta.status >= 300 && resposta.status < 400) {
        const destino = resposta.headers.get("location");

        if (!destino || tentativa === 3) {
          return res.status(502).json({
            success: false,
            error: "Não foi possível acessar a imagem."
          });
        }

        enderecoAtual = new URL(destino, enderecoAtual).toString();

        if (!enderecoDeImagemPermitido(enderecoAtual)) {
          return res.status(502).json({
            success: false,
            error: "Redirecionamento de imagem não permitido."
          });
        }

        continue;
      }

      break;
    }

    if (!resposta || !resposta.ok) {
      return res.status(502).json({
        success: false,
        error: "A imagem não está disponível."
      });
    }

    const tipo = (
      resposta.headers.get("content-type") || ""
    ).split(";")[0].trim().toLowerCase();

    const tiposPermitidos = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif"
    ];

    if (!tiposPermitidos.includes(tipo)) {
      return res.status(502).json({
        success: false,
        error: "O endereço não retornou uma imagem válida."
      });
    }

    const buffer = Buffer.from(await resposta.arrayBuffer());

    if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: "Imagem vazia ou maior que o limite de 8 MB."
      });
    }

    res.set({
      "Content-Type": tipo,
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });

    return res.send(buffer);
  } catch (error) {
    console.error("Erro ao carregar imagem:", error.message);

    return res.status(502).json({
      success: false,
      error: "Falha ao carregar a imagem do produto."
    });
  }
});

// ==========================================
// BUSCAR VÍDEOS GRATUITOS DO PEXELS
// ==========================================

app.get("/api/videos/pexels", async (req, res) => {
  try {
    if (!PEXELS_API_KEY) {
      return res.status(503).json({
        success: false,
        code: "PEXELS_KEY_MISSING",
        error: "Configure PEXELS_API_KEY nas variáveis do Render."
      });
    }

    const query = String(req.query.q || "")
      .trim()
      .slice(0, 120);

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Digite um tema para buscar vídeos."
      });
    }

    const perPage = Math.max(
      1,
      Math.min(12, Number(req.query.per_page) || 8)
    );

    const orientacoes = ["portrait", "landscape", "square"];

    const orientation = orientacoes.includes(
      String(req.query.orientation || "portrait")
    )
      ? String(req.query.orientation || "portrait")
      : "portrait";

    const url = new URL(
      "https://api.pexels.com/v1/videos/search"
    );

    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("orientation", orientation);
    url.searchParams.set("locale", "pt-BR");

    const response = await fetch(url, {
      headers: {
        Authorization: PEXELS_API_KEY
      },
      signal: AbortSignal.timeout(20000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Erro Pexels:", response.status, data);

      return res.status(
        response.status === 429 ? 429 : 502
      ).json({
        success: false,
        error:
          response.status === 401
            ? "A chave do Pexels é inválida."
            : response.status === 429
              ? "Limite de buscas atingido. Tente novamente mais tarde."
              : "Não foi possível pesquisar vídeos no Pexels."
      });
    }

    const videos = (data.videos || [])
      .map(v => {
        const files = (v.video_files || [])
          .filter(f => {
            return (
              f.link &&
              f.file_type === "video/mp4" &&
              f.width &&
              f.height
            );
          })
          .sort((a, b) => {
            const aScore =
              Math.abs(a.width - 720) +
              Math.abs(a.height - 1280);

            const bScore =
              Math.abs(b.width - 720) +
              Math.abs(b.height - 1280);

            return aScore - bScore;
          });

        const file =
          files.find(f => f.width <= 1080) ||
          files[0];

        return {
          id: v.id,
          url: v.url,
          image: v.image,
          duration: v.duration,
          width: v.width,
          height: v.height,
          photographer: v.user?.name || "Criador Pexels",
          photographer_url:
            v.user?.url || "https://www.pexels.com/",
          video_file: file?.link || ""
        };
      })
      .filter(v => v.video_file);

    return res.json({
      success: true,
      total: data.total_results || videos.length,
      query,
      videos,
      pexels_url:
        `https://www.pexels.com/search/videos/${encodeURIComponent(query)}/`
    });
  } catch (error) {
    console.error("Erro Pexels:", error.message);

    return res.status(502).json({
      success: false,
      error: "Falha ao consultar o Pexels."
    });
  }
});

// ==========================================
// CONSULTAR VOZES ELEVENLABS
// ==========================================

app.get("/api/voz/vozes", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "Configure ELEVENLABS_API_KEY no Render."
      });
    }

    const resposta = await fetch(
      "https://api.elevenlabs.io/v1/voices",
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY
        },
        signal: AbortSignal.timeout(20000)
      }
    );

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      console.error("Erro ElevenLabs:", resposta.status, dados);

      return res.status(502).json({
        success: false,
        error: "Não foi possível consultar as vozes da ElevenLabs."
      });
    }

    const vozes = (dados.voices || []).map(voz => ({
      voice_id: voz.voice_id,
      name: voz.name,
      category: voz.category || "",
      labels: voz.labels || {}
    }));

    res.json({
      success: true,
      total: vozes.length,
      vozes
    });
  } catch (error) {
    console.error("Erro nas vozes:", error.message);

    res.status(502).json({
      success: false,
      error: "Falha ao consultar as vozes."
    });
  }
});

// ==========================================
// GERAR NARRAÇÃO MP3
// ==========================================

app.post("/api/voz/narrar", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "Configure ELEVENLABS_API_KEY no Render."
      });
    }

    const texto = String(req.body?.texto || "").trim();
    const voiceId = String(req.body?.voice_id || "").trim();

    if (!texto) {
      return res.status(400).json({
        success: false,
        error: "Digite o texto da narração."
      });
    }

    if (texto.length > 1200) {
      return res.status(400).json({
        success: false,
        error: "A narração deve ter no máximo 1200 caracteres."
      });
    }

    if (!voiceId || !/^[a-zA-Z0-9_-]+$/.test(voiceId)) {
      return res.status(400).json({
        success: false,
        error: "Selecione uma voz válida."
      });
    }

    const resposta = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" +
        encodeURIComponent(voiceId) +
        "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: texto,
          model_id: "eleven_multilingual_v2",
          language_code: "pt",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75
          }
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    if (!resposta.ok) {
      const detalhe = await resposta.text();

      console.error(
        "Erro ElevenLabs:",
        resposta.status,
        detalhe
      );

      return res.status(502).json({
        success: false,
        error:
          "A ElevenLabs não gerou o áudio. Confira sua conta, " +
          "os créditos disponíveis e a voz selecionada."
      });
    }

    const audio = Buffer.from(await resposta.arrayBuffer());

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "no-store"
    });

    return res.send(audio);
  } catch (error) {
    console.error("Erro ao gerar narração:", error.message);

    res.status(502).json({
      success: false,
      error: "Erro ao gerar a narração."
    });
  }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
