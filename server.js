import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.get("/health", (_, res) => res.send("OK"));

// simple 4-char room code generator
function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/O/1/0 to avoid confusion
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

app.get("/api/new-room", (_req, res) => {
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  rooms.set(code, { spectators: new Set(), performers: new Set() });
  res.json({ code });
});

// HTTP → WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// in-memory rooms (ephemeral)
const rooms = new Map();
// heartbeat to keep connections healthy
function heartbeat() { this.isAlive = true; }
function pingAll() {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}
setInterval(pingAll, 30000);

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const url = new URL(req.url, "http://localhost");
  const room = url.searchParams.get("room")?.toUpperCase();
  const role = url.searchParams.get("role"); // "spectator" | "performer"

  if (!room || !role || !["spectator", "performer"].includes(role)) {
    ws.close(1008, "Bad params");
    return;
  }

  if (!rooms.has(room)) rooms.set(room, { spectators: new Set(), performers: new Set() });
  const group = rooms.get(room);
  const bucket = role === "spectator" ? group.spectators : group.performers;
  bucket.add(ws);

  const notifyCount = () => {
    const payload = JSON.stringify({
      type: "presence",
      spectators: group.spectators.size,
      performers: group.performers.size
    });
    group.performers.forEach(p => p.readyState === 1 && p.send(payload));
  };
  notifyCount();

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // spectator sends choice -> forward to all performers
    if (role === "spectator" && msg?.type === "choice") {
      const payload = JSON.stringify({ type: "choice", value: String(msg.value || "").slice(0, 200) });
      group.performers.forEach(p => p.readyState === 1 && p.send(payload));
    }

    // performer can send {type:"clear"} to reset UI
    if (role === "performer" && msg?.type === "clear") {
      const payload = JSON.stringify({ type: "clear" });
      group.performers.forEach(p => p.readyState === 1 && p.send(payload));
    }
  });

  ws.on("close", () => {
    bucket.delete(ws);
    if (group.spectators.size === 0 && group.performers.size === 0) {
      rooms.delete(room); // tidy empty rooms
    } else {
      notifyCount();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Relay listening on", PORT));server.js
