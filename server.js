const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SHOPEE_API_URL =
  "https://open-api.affiliate.shopee.com.br/graphql";

const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;

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
    throw new Error("Credenciais da Shopee não configuradas.");
  }

  const timestamp = Math.floor(Date.now() / 1000);

  const payload = JSON.stringify({
    query: query
  });

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

/*
  IMPORTANTE:
  O index.html fica na raiz do projeto.
  Esta linha faz o Render entregar a página.
*/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/produtos", async (req, res) => {
  try {
    const query = `
      {
        productOfferV2(
          sortType: 2
          page: 1
          limit: 10
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

    const produtos =
      data?.data?.productOfferV2?.nodes || [];

    const unicos = [];
    const ids = new Set();

    for (const produto of produtos) {
      if (!ids.has(produto.itemId)) {
        ids.add(produto.itemId);
        unicos.push(produto);
      }
    }

    unicos.sort(
      (a, b) =>
        Number(b.sales || 0) -
        Number(a.sales || 0)
    );

    res.json({
      success: true,
      total: unicos.length,
      produtos: unicos
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Servidor rodando na porta ${PORT}`
  );
});
