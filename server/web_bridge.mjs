import fs from "node:fs";
import http from "node:http";

const ALLOWED_APP_TOOLS = new Set([
  "app_list_decks",
  "app_get_slide",
  "app_crop_selection",
  "app_set_slide_priority",
]);

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export async function startWebBridge(core, { port = 4173, uiHtmlPath }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        let html = fs.readFileSync(uiHtmlPath, "utf8");
        html = html.replace(
          "</head>",
          `<script>window.__PPT_READER_WEB_MODE__=true;</script></head>`,
        );
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tool") {
        const body = await readJsonBody(req);
        const name = body.name;
        const args = body.arguments || {};
        if (!ALLOWED_APP_TOOLS.has(name)) {
          sendJson(res, 403, { error: `Tool not allowed: ${name}` });
          return;
        }

        let sc;
        if (name === "app_list_decks") {
          sc = await core.listDecks();
        } else if (name === "app_get_slide") {
          const slide = await core.getSlide(args);
          const { base64, pngPath, textSnippet, ...publicSlide } = slide;
          sc = publicSlide;
        } else if (name === "app_crop_selection") {
          sc = await core.cropSelection(args);
        } else if (name === "app_set_slide_priority") {
          sc = await core.setSlidePriority(args);
        }
        sendJson(res, 200, { structuredContent: sc });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ask") {
        const body = await readJsonBody(req);
        const saved = core.savePendingQuestion(body);
        sendJson(res, 200, { ok: true, savedAt: saved.savedAt });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("Web bridge error:", err);
      sendJson(res, 500, { error: err.message });
    }
  });

  async function listenOn(targetPort) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : targetPort);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(targetPort, "127.0.0.1");
    });
  }

  let actualPort;
  try {
    actualPort = await listenOn(port);
  } catch (err) {
    if (err && err.code === "EADDRINUSE" && port !== 0) {
      actualPort = await listenOn(0);
    } else {
      throw err;
    }
  }

  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close,
  };
}
