
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
// NOVO: CARREGAR IMAGENS DOS PRODUTOS
// ==========================================

// Permite somente endereços conhecidos de imagens
// da Shopee. Redirecionamentos também são verificados.

function enderecoDeImagemPermitido(valor) {
  try {
    const endereco = new URL(valor);

    if (endereco.protocol !== "https:") {
      return false;
    }

    const host = endereco.hostname.toLowerCase();

    const permitido =
      host === "susercontent.com" ||
      host.endsWith(".susercontent.com") ||
      host === "shopee.com.br" ||
      host.endsWith(".shopee.com.br");

    return permitido;
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

    // Segue no máximo três redirecionamentos seguros
    for (let tentativa = 0; tentativa <= 3; tentativa++) {
      resposta = await fetch(enderecoAtual, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*"
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

    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
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
        error: "Não foi possível consultar as vozes da ElevenLabs."
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
          "A ElevenLabs não conseguiu gerar o áudio. Confira sua conta, seus créditos e a voz selecionada."
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
