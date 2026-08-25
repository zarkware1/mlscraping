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
// Confirmado necessário: todo teste de IP de datacenter (Railway/GCP/AWS)
// caiu no muro de captcha; o mesmo teste de um IP residencial passou direto.
// PROXY_CHEAP_CREDENTIALS aceita dois formatos, pra colar direto o que o
// painel do Proxy-Cheap mostrar sem precisar reformatar:
//   - "usuario:senha@host:porta"  (formato padrão de URL de proxy)
//   - "host:porta:usuario:senha"  (formato alternativo, tipo lista/CSV)
function buildProxyConfig() {
  const raw = process.env.PROXY_CHEAP_CREDENTIALS || "";
  if (!raw) return undefined;

  const atFormat = raw.match(/^([^:@]+):([^@]+)@([^:@]+):(\d+)$/);
  if (atFormat) {
    const [, username, password, host, port] = atFormat;
    return { server: `http://${host}:${port}`, username, password };
  }

  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, username, ...passwordParts] = parts;
    return { server: `http://${host}:${port}`, username, password: passwordParts.join(":") };
  }

  console.warn("PROXY_CHEAP_CREDENTIALS em formato não reconhecido — esperado usuario:senha@host:porta ou host:porta:usuario:senha");
  return undefined;
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
    const page = await context.newPage();
    // Trick comum de stealth: navigator.webdriver=true denuncia automação
    // pra qualquer site que cheque isso via JS.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    if (cookieHeader) {
      // Achado testando manualmente num navegador real: uma aba anônima
      // "limpa" já tem cookies de apoio próprios (_d2id, sessão do Hotjar,
      // etc.) antes de logar — só depois entram ssid/_csrf/etc. Um ssid
      // "sozinho", sem NENHUM cookie de apoio, é um padrão mais estranho
      // ainda do que um _d2id de dispositivo errado. Visita a home primeiro
      // pra deixar o próprio site gerar esses cookies de apoio, igual uma
      // sessão anônima real, e só DEPOIS aplica as 5 cookies de identidade.
      await page.goto("https://www.mercadolivre.com.br/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      const cookies = parseCookieHeader(cookieHeader, ".mercadolivre.com.br");
      if (cookies.length > 0) await context.addCookies(cookies);
    }

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

    // Bug real: pra respostas JSON puras (ex: a API do relatório do ML, usada
    // por ml-sync-relatorio), o Chrome embrulha automaticamente o corpo num
    // visualizador HTML (<html><body><pre>{...}</pre>) — page.content() devolve
    // esse DOM decorado, não o JSON cru, o que quebra todo consumidor que
    // espera JSON.parse(html) funcionar. Só usa o DOM renderizado (com JS já
    // executado) pra HTML de verdade; pra JSON/texto, lê o corpo puro da
    // resposta.
    const contentType = response ? response.headers()["content-type"] || "" : "";
    const isRawBody = /application\/json|text\/plain/i.test(contentType);
    const html = isRawBody && response ? await response.text() : await page.content();

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
