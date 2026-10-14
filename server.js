
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

const SHOPEE_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    message: "Shopee Ranking API funcionando",
    servicos: {
      shopee: Boolean(SHOPEE_APP_ID && SHOPEE_SECRET),
      pexels: Boolean(PEXELS_API_KEY),
      narracao: Boolean(ELEVENLABS_API_KEY)
    }
  });
});

/* =====================================================
   SHOPEE — BUSCA E RANKING DE PRODUTOS
===================================================== */

app.get("/api/produtos", async (req, res) => {
  try {
    if (!SHOPEE_APP_ID || !SHOPEE_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Configure SHOPEE_APP_ID e SHOPEE_SECRET no Render."
      });
    }

    const produtos = [];
    const maxPaginas = 10;

    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const queryPagina = `
        query {
          productOfferV2(
            listType: 0,
            sortType: 2,
            page: ${pagina},
            limit: 50
          ) {
            nodes {
              productName
              itemId
              shopId
              productLink
              offerLink
              imageUrl
              priceMin
              priceMax
              commissionRate
              commission
              sales
              ratingStar
              shopName
            }
            pageInfo {
              page
              limit
              hasNextPage
            }
          }
        }
      `;

      const body = JSON.stringify({ query: queryPagina });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signature = crypto
        .createHash("sha256")
        .update(
          `${SHOPEE_APP_ID}${timestamp}${body}${SHOPEE_SECRET}`
        )
        .digest("hex");

      const authorization =
        `SHA256 Credential=${SHOPEE_APP_ID},` +
        `Timestamp=${timestamp},Signature=${signature}`;

      const response = await fetch(SHOPEE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization
        },
        body
      });

      const resultado = await response.json();

      if (!response.ok || resultado.errors) {
        console.error(
          "Erro Shopee:",
          JSON.stringify(resultado.errors || resultado).slice(0, 1500)
        );

        if (produtos.length === 0) {
          return res.status(502).json({
            success: false,
            error: "A Shopee não retornou os produtos.",
            detalhes: resultado.errors || resultado
          });
        }

        break;
      }

      const dados = resultado.data?.productOfferV2;
      const itens = dados?.nodes || [];

      produtos.push(...itens);

      if (!dados?.pageInfo?.hasNextPage || itens.length === 0) {
        break;
      }
    }

    const produtosUnicos = Array.from(
      new Map(
        produtos.map((p) => [
          `${p.shopId || ""}-${p.itemId || p.productName}`,
          p
        ])
      ).values()
    );

    produtosUnicos.sort(
      (a, b) => Number(b.sales || 0) - Number(a.sales || 0)
    );

    res.json({
      success: true,
      total: produtosUnicos.length,
      produtos: produtosUnicos
    });
  } catch (error) {
    console.error("Erro na API Shopee:", error);

    res.status(500).json({
      success: false,
      error: "Erro ao buscar produtos da Shopee.",
      detalhes: error.message
    });
  }
});

/* =====================================================
   PROXY DE IMAGENS DOS PRODUTOS
===================================================== */

app.get("/api/imagem", async (req, res) => {
  try {
    const url = new URL(String(req.query.url || ""));

    const hostPermitido =
      /(^|\.)susercontent\.com$/i.test(url.hostname) ||
      /(^|\.)shopee\.com\.br$/i.test(url.hostname);

    if (url.protocol !== "https:" || !hostPermitido) {
      return res.status(400).send("URL de imagem não permitida.");
    }

    const upstream = await fetch(url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).send("Não foi possível carregar a imagem.");
    }

    const finalUrl = new URL(upstream.url);
    const finalHostPermitido =
      /(^|\.)susercontent\.com$/i.test(finalUrl.hostname) ||
      /(^|\.)shopee\.com\.br$/i.test(finalUrl.hostname);

    if (finalUrl.protocol !== "https:" || !finalHostPermitido) {
      return res.status(400).send("Redirecionamento não permitido.");
    }

    const contentType = upstream.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      return res.status(415).send("O endereço não retornou uma imagem.");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("Erro ao carregar imagem:", error.message);
    res.status(500).send("Erro ao carregar imagem.");
  }
});

/* =====================================================
   PEXELS — PESQUISA DE VÍDEOS GRATUITOS
===================================================== */

app.get("/api/videos/pexels", async (req, res) => {
  try {
    if (!PEXELS_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Configure PEXELS_API_KEY no Render."
      });
    }

    const q = String(req.query.q || "shopping product").slice(0, 120);
    const perPage = Math.min(
      15,
      Math.max(1, Number(req.query.per_page) || 8)
    );

    const orientacaoPermitida = ["landscape", "portrait", "square"];
    const orientacao = orientacaoPermitida.includes(
      String(req.query.orientation)
    )
      ? String(req.query.orientation)
      : "portrait";

    const parametros = new URLSearchParams({
      query: q,
      per_page: String(perPage),
      orientation: orientacao
    });

    const resposta = await fetch(
      `https://api.pexels.com/videos/search?${parametros}`,
      {
        headers: {
          Authorization: PEXELS_API_KEY
        },
        signal: AbortSignal.timeout(20000)
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      console.error("Erro Pexels:", resposta.status, dados);

      return res.status(resposta.status).json({
        success: false,
        error: "Não foi possível pesquisar vídeos no Pexels."
      });
    }

    const videos = (dados.videos || []).map((video) => {
      const arquivos = (video.video_files || [])
        .filter((arquivo) => {
          try {
            const u = new URL(arquivo.link);
            return (
              u.protocol === "https:" &&
              /(^|\.)pexels\.com$/i.test(u.hostname) &&
              u.hostname.toLowerCase() === "videos.pexels.com"
            );
          } catch {
            return false;
          }
        })
        .sort((a, b) => {
          const aScore = (a.width || 0) <= 1080 ? 1 : 0;
          const bScore = (b.width || 0) <= 1080 ? 1 : 0;
          return bScore - aScore;
        });

      const arquivo = arquivos[0];

      return {
        id: video.id,
        duracao: video.duration,
        largura: video.width,
        altura: video.height,
        fotografo: video.user?.name || "",
        pagina: video.url,
        preview: video.image,
        video_file: arquivo?.link || null,
        largura_video: arquivo?.width || null,
        altura_video: arquivo?.height || null
      };
    }).filter((video) => video.video_file);

    res.json({
      success: true,
      total: videos.length,
      videos
    });
  } catch (error) {
    console.error("Erro Pexels:", error.message);

    res.status(500).json({
      success: false,
      error: "Erro ao pesquisar vídeos gratuitos.",
      detalhes: error.message
    });
  }
});

/* =====================================================
   PEXELS — PROXY PARA REPRODUÇÃO DOS VÍDEOS
===================================================== */

app.get("/api/video-pexels", async (req, res) => {
  try {
    const url = new URL(String(req.query.url || ""));

    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "videos.pexels.com"
    ) {
      return res.status(400).send("URL de vídeo não permitida.");
    }

    const headers = {};

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(url.toString(), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30000)
    });

    const finalUrl = new URL(upstream.url);

    if (
      finalUrl.protocol !== "https:" ||
      finalUrl.hostname.toLowerCase() !== "videos.pexels.com"
    ) {
      return res.status(400).send("Redirecionamento não permitido.");
    }

    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).send(
        "Não foi possível carregar o vídeo."
      );
    }

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "video/mp4"
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    res.status(upstream.status === 206 ? 206 : 200);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("Erro no proxy de vídeo:", error.message);

    if (!res.headersSent) {
      res.status(500).send("Erro ao carregar o vídeo.");
    }
  }
});

/* =====================================================
   ELEVENLABS — LISTA DE VOZES
===================================================== */

app.get("/api/voz/vozes", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({
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

    const dados = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        success: false,
        error: "Não foi possível carregar as vozes."
      });
    }

    const vozes = (dados.voices || []).map((voz) => ({
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
    console.error("Erro ao listar vozes:", error.message);

    res.status(500).json({
      success: false,
      error: "Erro ao carregar as vozes."
    });
  }
});

/* =====================================================
   ELEVENLABS — GERAR NARRAÇÃO
===================================================== */

app.post("/api/voz/narrar", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Configure ELEVENLABS_API_KEY no Render."
      });
    }

    const texto = String(req.body?.texto || "").trim();
    const voiceId = String(req.body?.voice_id || "").trim();

    if (!texto || !voiceId) {
      return res.status(400).json({
        success: false,
        error: "Informe o texto e o ID da voz."
      });
    }

    if (texto.length > 5000) {
      return res.status(400).json({
        success: false,
        error: "O texto deve ter no máximo 5000 caracteres."
      });
    }

    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(voiceId)) {
      return res.status(400).json({
        success: false,
        error: "ID de voz inválido."
      });
    }

    const resposta = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        body: JSON.stringify({
          text: texto,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75
          }
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    if (!resposta.ok) {
      const detalhes = await resposta.text();

      console.error(
        "Erro ElevenLabs:",
        resposta.status,
        detalhes.slice(0, 1000)
      );

      return res.status(resposta.status).json({
        success: false,
        error: "Não foi possível gerar a narração. Verifique a conta e os créditos disponíveis."
      });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    Readable.fromWeb(resposta.body).pipe(res);
  } catch (error) {
    console.error("Erro na narração:", error.message);

    res.status(500).json({
      success: false,
      error: "Erro ao gerar narração.",
      detalhes: error.message
    });
  }
});

/* =====================================================
   INICIALIZAÇÃO
===================================================== */

app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
