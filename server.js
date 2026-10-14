const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

const SHOPEE_API_URL =
  "https://open-api.affiliate.shopee.com.br/graphql";

const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// ==========================================
// ASSINATURA DA API SHOPEE
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
      "Authorization": authorization
    },
    body: payload
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
// RANKING DE PRODUTOS SHOPEE
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

      if (produtos.length === 0) break;

      for (const produto of produtos) {
        if (!ids.has(produto.itemId)) {
          ids.add(produto.itemId);
          todosProdutos.push(produto);
        }
      }

      const pageInfo =
        data?.data?.productOfferV2?.pageInfo;

      if (!pageInfo?.hasNextPage) break;
    }

    todosProdutos.sort(
      (a, b) =>
        Number(b.sales || 0) - Number(a.sales || 0)
    );

    res.json({
      success: true,
      total: todosProdutos.length,
      paginasConsultadas,
      produtos: todosProdutos
    });
  } catch (error) {
    console.error("Erro no ranking:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==========================================
// CARREGAR IMAGENS DOS PRODUTOS
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

    if (!urlImagem) {
      return res.status(400).json({
        success: false,
        error: "Informe a URL da imagem no parâmetro url."
      });
    }

    if (!enderecoDeImagemPermitido(urlImagem)) {
      return res.status(400).json({
        success: false,
        error: "O endereço da imagem não é permitido."
      });
    }

    let enderecoAtual = urlImagem;
    let resposta;

    for (let tentativa = 0; tentativa <= 3; tentativa++) {
      resposta = await fetch(enderecoAtual, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept":
            "image/avif,image/webp,image/png,image/jpeg,image/*"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (
        resposta.status >= 300 &&
        resposta.status < 400
      ) {
        const destino = resposta.headers.get("location");

        if (!destino || tentativa === 3) {
          return res.status(502).json({
            success: false,
            error: "Não foi possível acessar a imagem."
          });
        }

        enderecoAtual = new URL(
          destino,
          enderecoAtual
        ).toString();

        if (!enderecoDeImagemPermitido(enderecoAtual)) {
          return res.status(502).json({
            success: false,
            error: "O destino da imagem não é permitido."
          });
        }

        continue;
      }

      break;
    }

    if (!resposta || !resposta.ok) {
      return res.status(502).json({
        success: false,
        error: "A Shopee não disponibilizou esta imagem."
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

    const tamanhoDeclarado = Number(
      resposta.headers.get("content-length") || 0
    );

    if (tamanhoDeclarado > 8 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: "A imagem é muito grande."
      });
    }

    const buffer = Buffer.from(
      await resposta.arrayBuffer()
    );

    if (
      buffer.length === 0 ||
      buffer.length > 8 * 1024 * 1024
    ) {
      return res.status(413).json({
        success: false,
        error: "A imagem está vazia ou excede o limite permitido."
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
    console.error(
      "Erro ao carregar imagem:",
      error.message
    );

    return res.status(502).json({
      success: false,
      error: "Falha ao carregar a imagem do produto."
    });
  }
});

// ==========================================
// BIBLIOTECA DE VÍDEOS PEXELS
// ==========================================

app.get("/api/videos/pexels", async (req, res) => {
  try {
    if (!PEXELS_API_KEY) {
      return res.status(503).json({
        success: false,
        code: "PEXELS_KEY_MISSING",
        error:
          "Configure PEXELS_API_KEY no Render. " +
          "A busca precisa de uma chave válida do Pexels."
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

    const orientationPermitida = [
      "portrait",
      "landscape",
      "square"
    ];

    const orientation = orientationPermitida.includes(
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
        "Authorization": PEXELS_API_KEY
      },
      signal: AbortSignal.timeout(20000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Pexels API:",
        response.status,
        data
      );

      return res.status(
        response.status === 429 ? 429 : 502
      ).json({
        success: false,
        error:
          response.status === 401
            ? "A chave do Pexels é inválida."
            : response.status === 429
              ? "Limite de buscas do Pexels atingido. Tente mais tarde."
              : "O Pexels não conseguiu realizar a busca."
      });
    }

    const videos = (data.videos || [])
      .map(v => {
        const files = (v.video_files || [])
          .filter(
            f => f.link && f.file_type === "video/mp4"
          )
          .sort(
            (a, b) =>
              (b.width * b.height) -
              (a.width * a.height)
          );

        const file =
          files.find(f => f.width <= 1080) ||
          files[files.length - 1];

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
        data.url ||
        `https://www.pexels.com/search/videos/${encodeURIComponent(query)}/`
    });
  } catch (error) {
    console.error(
      "Erro ao buscar vídeos Pexels:",
      error.message
    );

    return res.status(502).json({
      success: false,
      error:
        "Falha ao consultar vídeos no Pexels. Tente novamente."
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
        }
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      console.error("Erro ao consultar vozes:", dados);

      return res.status(resposta.status).json({
        success: false,
        error:
          "Não foi possível consultar as vozes da ElevenLabs."
      });
    }

    const vozes = (dados.voices || []).map(voz => ({
      voice_id: voz.voice_id,
      name: voz.name,
      category: voz.category || "",
      labels: voz.labels || {}
    }));

    return res.json({
      success: true,
      total: vozes.length,
      vozes
    });
  } catch (error) {
    console.error("Erro nas vozes:", error);

    return res.status(500).json({
      success: false,
      error: "Falha ao consultar as vozes."
    });
  }
});

// ==========================================
// GERAR NARRAÇÃO EM MP3
// ==========================================

app.post("/api/voz/narrar", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "Configure ELEVENLABS_API_KEY no Render."
      });
    }

    const texto = String(
      req.body?.texto || ""
    ).trim();

    const voiceId = String(
      req.body?.voice_id || ""
    ).trim();

    if (!texto) {
      return res.status(400).json({
        success: false,
        error: "Informe o texto da narração."
      });
    }

    if (texto.length > 1200) {
      return res.status(400).json({
        success: false,
        error: "O texto deve ter no máximo 1200 caracteres."
      });
    }

    if (
      !voiceId ||
      !/^[a-zA-Z0-9_-]+$/.test(voiceId)
    ) {
      return res.status(400).json({
        success: false,
        error: "Selecione uma voz válida."
      });
    }

    const resposta = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
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
        })
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
          "A ElevenLabs não conseguiu gerar o áudio. " +
          "Confira sua conta, seus créditos e a voz selecionada."
      });
    }

    const audio = Buffer.from(
      await resposta.arrayBuffer()
    );

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "no-store"
    });

    return res.send(audio);
  } catch (error) {
    console.error(
      "Erro ao gerar narração:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Erro interno ao gerar a narração."
    });
  }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
