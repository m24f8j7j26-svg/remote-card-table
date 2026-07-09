const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const MAX_BODY = 2 * 1024 * 1024;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function makeRoomCode(prefix) {
  let code;
  do {
    code = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  } while (rooms.has(code));
  return code;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function cleanRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff) rooms.delete(code);
  }
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return true;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    const game = body.state && body.state.game;
    const code = makeRoomCode(game === "handfoot" ? "CARDS" : "SPADES");
    rooms.set(code, { state: body.state, updatedAt: Date.now() });
    sendJson(res, 201, { room: code });
    return true;
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/state$/);
  if (match && req.method === "GET") {
    cleanRooms();
    const room = rooms.get(decodeURIComponent(match[1]).toUpperCase());
    if (!room) {
      sendJson(res, 404, { error: "room not found" });
      return true;
    }
    room.updatedAt = Date.now();
    sendJson(res, 200, { state: room.state });
    return true;
  }

  if (match && req.method === "PUT") {
    const code = decodeURIComponent(match[1]).toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      sendJson(res, 404, { error: "room not found" });
      return true;
    }
    const body = await readJson(req);
    room.state = body.state;
    room.updatedAt = Date.now();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const fullPath = path.normalize(path.join(ROOT, requested));
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (await handleApi(req, res, url)) return;
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Remote Card Table listening on ${PORT}`);
});
