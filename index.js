const http = require("http");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET || "";

// Teste em andamento: o ML bloqueava requisições HTTP cruas (módulo https do
// Node) mesmo com cookies válidos — não dava pra saber se era a FAIXA de IP
// do Railway/datacenter, ou o fingerprint de conexão (o handshake TLS do
// Node não é igual ao de um Chrome de verdade, algo que sistemas anti-bot
// sofisticados detectam independente do IP). Trocado pra um Chromium real
// via Playwright — se isso já bastar, evita o custo de proxy residencial.
// PROXY_CHEAP_CREDENTIALS continua opcional (formato "host:port:username:
// password") caso o navegador real sozinho não seja suficiente.
function buildProxyConfig() {
  const raw = process.env.PROXY_CHEAP_CREDENTIALS || "";
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length < 4) {
    console.warn("PROXY_CHEAP_CREDENTIALS mal formatada — esperado host:port:username:password");
    return undefined;
  }
  const [host, port, username, ...passwordParts] = parts;
  const password = passwordParts.join(":");
  return { server: `http://${host}:${port}`, username, password };
}
const proxyConfig = buildProxyConfig();

// Um browser só, reaproveitado entre requisições (lançar Chromium do zero a
// cada fetch custa ~1-2s); cada requisição ganha seu próprio context
// (cookies isoladas), fechado ao final — bem mais barato que fechar o
// browser inteiro.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      proxy: proxyConfig,
    });
  }
  return browserPromise;
}

// O cookie chega como header cru ("ssid=x; _csrf=y; ..."); Playwright exige
// objetos estruturados por cookie.
function parseCookieHeader(cookieHeader, domain) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return null;
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain,
        path: "/",
      };
    })
    .filter(Boolean);
}

async function fetchUrl(url, cookieHeader) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1366, height: 768 },
  });
  try {
    if (cookieHeader) {
      // Bug real: usar o subdomínio exato da URL (ex: "produto.mercadolivre.
      // com.br") como domínio do cookie fazia a sessão não valer mais depois
      // de um redirect pra outro subdomínio (ex: "www.mercadolivre.com.br/
      // gz/account-verification") — igual um navegador de verdade, o
      // Playwright só manda a cookie se o domínio bater. O código antigo
      // (fetch cru) não tinha esse problema porque simplesmente grudava o
      // mesmo header Cookie em toda requisição, sem checar domínio nenhum.
      // Como esse serviço só lida com o Mercado Livre, fixa no domínio raiz
      // — cobre todos os subdomínios (www, produto, etc.) de uma vez.
      const cookies = parseCookieHeader(cookieHeader, ".mercadolivre.com.br");
      if (cookies.length > 0) await context.addCookies(cookies);
    }
    const page = await context.newPage();
    // Trick comum de stealth: navigator.webdriver=true denuncia automação
    // pra qualquer site que cheque isso via JS.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    let status = 0;
    // Bater direto numa URL de produto, sem Referer nenhum, se parece com
    // "alguém digitou essa URL exata na barra de endereço" — padrão raro
    // pra usuário real, comum pra scraper. Um clique real (ou "abrir em
    // nova aba") sempre carrega um Referer da página de origem; replicando
    // isso aqui como se tivéssemos vindo da home do ML.
    const response = await page
      .goto(url, { waitUntil: "networkidle", timeout: 30000, referer: "https://www.mercadolivre.com.br/" })
      .catch(() => null);
    if (response) status = response.status();
    const html = await page.content();

    return { status, body: html, finalUrl: page.url() };
  } finally {
    await context.close();
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Proxy-Secret");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        upstreamProxy: !!proxyConfig,
        engine: "playwright-chromium",
      })
    );
    return;
  }

  // Confirma o IP de saída atual (e se o browser real está de pé) sem
  // precisar rodar todo o fluxo de scraping do ML.
  if (req.method === "GET" && req.url === "/whoami") {
    try {
      const resultado = await fetchUrl("https://api.ipify.org?format=json", "");
      const bodyText = resultado.body.replace(/<[^>]+>/g, "").trim();
      res.writeHead(200);
      res.end(JSON.stringify({ upstreamProxy: !!proxyConfig, ip: JSON.parse(bodyText) }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method !== "POST" || req.url !== "/fetch") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const secret = req.headers["x-proxy-secret"];
  if (SECRET && secret !== SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { url, cookies } = JSON.parse(body);
      if (!url) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "url é obrigatória" }));
        return;
      }

      console.log(`[${new Date().toISOString()}] Fetch: ${url.slice(0, 80)}`);
      const resultado = await fetchUrl(url, cookies);
      console.log(
        `[${new Date().toISOString()}] Status: ${resultado.status} | FinalUrl: ${resultado.finalUrl} | Size: ${resultado.body.length}`
      );

      res.writeHead(200);
      res.end(
        JSON.stringify({
          html: resultado.body,
          status: resultado.status,
          finalUrl: resultado.finalUrl,
        })
      );
    } catch (err) {
      console.error("Erro:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`ML Proxy (Playwright/Chromium) rodando na porta ${PORT}`);
});

process.on("SIGTERM", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
  }
  process.exit(0);
});
