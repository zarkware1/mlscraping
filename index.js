const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET || "";

function fetchUrl(url, cookies) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectCount) => {
      if (redirectCount > 10) {
        return reject(new Error("Too many redirects"));
      }

      const parsed = new URL(currentUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8",
          "cache-control": "no-cache",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "upgrade-insecure-requests": "1",
          ...(cookies ? { cookie: cookies } : {}),
        },
      };

      const req = https.request(options, (res) => {
        // Segue redirects manualmente para capturar a URL final
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers["location"];
          if (location) {
            const nextUrl = location.startsWith("http")
              ? location
              : `https://${parsed.hostname}${location}`;
            console.log(`Redirect ${redirectCount + 1}: ${currentUrl} → ${nextUrl}`);
            // Drena o body antes de redirecionar
            res.resume();
            return doRequest(nextUrl, redirectCount + 1);
          }
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: data,
            finalUrl: currentUrl, // URL final após todos os redirects
          })
        );
      });

      req.on("error", reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
      req.end();
    };

    doRequest(url, 0);
  });
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
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
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
      console.log(`[${new Date().toISOString()}] Status: ${resultado.status} | FinalUrl: ${resultado.finalUrl} | Size: ${resultado.body.length}`);

      res.writeHead(200);
      res.end(JSON.stringify({
        html: resultado.body,
        status: resultado.status,
        finalUrl: resultado.finalUrl,
      }));
    } catch (err) {
      console.error("Erro:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`ML Proxy rodando na porta ${PORT}`);
});
