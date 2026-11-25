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

const MAX_HOLD_SECONDS = 55;

export async function startWebBridge(
  core,
  { port = 4173, uiHtmlPath, strictPort = false, instanceId = "" },
) {
  // Long-poll waiters (e.g. scripts/wait_question.mjs run in the background by Claude Code).
  const waiters = new Set();

  function pendingSince(sinceMs) {
    const p = core.getPendingQuestion({ markConsumed: false });
    if (!p.found || p.consumed) return null;
    const savedMs = Date.parse(p.savedAt);
    if (Number.isFinite(sinceMs) && !(savedMs > sinceMs)) return null;
    return publicQuestion(p);
  }

  function publicQuestion(p) {
    return {
      found: true,
      text: p.text,
      question: p.question,
      deck: p.deck,
      page: p.page,
      cropId: p.cropId || "",
      savedAt: p.savedAt,
    };
  }

  function notifyWaiters(entry) {
    for (const w of [...waiters]) w.resolve(publicQuestion(entry));
  }

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
        sendJson(res, 200, { ok: true, instanceId });
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
        const listeners = waiters.size;
        const saved = core.savePendingQuestion(body);
        notifyWaiters(saved);
        sendJson(res, 200, { ok: true, savedAt: saved.savedAt, listeners });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/wait") {
        const sinceRaw = url.searchParams.get("since");
        const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
        const holdSec = Math.min(
          MAX_HOLD_SECONDS,
          Math.max(0, Number(url.searchParams.get("hold") ?? 25) || 0),
        );
        const ready = pendingSince(sinceMs);
        if (ready || holdSec === 0) {
          sendJson(res, 200, ready || { found: false });
          return;
        }
        await new Promise((resolve) => {
          const waiter = {
            resolve: (payload) => {
              if (!waiters.has(waiter)) return;
              waiters.delete(waiter);
              clearTimeout(timer);
              if (!res.writableEnded) sendJson(res, 200, payload);
              resolve();
            },
          };
          const timer = setTimeout(() => waiter.resolve({ found: false }), holdSec * 1000);
          waiters.add(waiter);
          // res "close" fires when the client disconnects (req "close" fires as soon as a GET body is read).
          res.on("close", () => {
            if (waiters.has(waiter)) {
              waiters.delete(waiter);
              clearTimeout(timer);
              resolve();
            }
          });
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/listeners") {
        sendJson(res, 200, { listeners: waiters.size });
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
    // strictPort：端口被占就直接报错，不换随机端口（自启抢占固定端口时用）
    if (err && err.code === "EADDRINUSE" && port !== 0 && !strictPort) {
      actualPort = await listenOn(0);
    } else {
      throw err;
    }
  }

  const close = async () => {
    for (const w of [...waiters]) w.resolve({ found: false, closing: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close,
  };
}
