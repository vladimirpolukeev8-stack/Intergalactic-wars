const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, upgrade",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, service: "intergalactic-wars-matchmaker", version: 1 },
        { headers: JSON_HEADERS },
      );
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
      }
      const id = env.MATCHMAKER.idFromName("global-matchmaking");
      return env.MATCHMAKER.get(id).fetch(request);
    }

    return Response.json(
      { service: "intergalactic-wars-online", endpoints: ["/health", "/ws"] },
      { headers: JSON_HEADERS },
    );
  },
};

export class Matchmaker {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const url = new URL(request.url);
    const playerId = (url.searchParams.get("playerId") || "").slice(0, 80);
    const rating = Number(url.searchParams.get("rating") || 1000);

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId) ||
        !Number.isFinite(rating) || rating < 0 || rating > 100000) {
      return Response.json({ error: "Invalid playerId or rating" }, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      playerId,
      rating: Math.round(rating),
      status: "waiting",
      connectedAt: Date.now(),
    });

    const waiting = this.ctx.getWebSockets().filter((socket) => {
      const data = socket.deserializeAttachment() || {};
      return socket !== server &&
        data.status === "waiting" &&
        data.playerId !== playerId &&
        socket.readyState === WebSocket.READY_STATE_OPEN;
    });

    const opponent = waiting.find((socket) => {
      const data = socket.deserializeAttachment() || {};
      return Math.abs(data.rating - Math.round(rating)) <=
        Math.min(500, 100 + Math.floor(Math.max(0, rating) / 500) * 50);
    });

    if (opponent) {
      const other = opponent.deserializeAttachment();
      const roomId = crypto.randomUUID();
      server.serializeAttachment({ playerId, rating: Math.round(rating), status: "matched", roomId, opponentId: other.playerId });
      opponent.serializeAttachment({ ...other, status: "matched", roomId, opponentId: playerId });

      const packetA = JSON.stringify({
        type: "matched",
        roomId,
        self: { playerId, rating: Math.round(rating) },
        opponent: { playerId: other.playerId, rating: other.rating },
      });
      const packetB = JSON.stringify({
        type: "matched",
        roomId,
        self: { playerId: other.playerId, rating: other.rating },
        opponent: { playerId, rating: Math.round(rating) },
      });
      server.send(packetA);
      opponent.send(packetB);
    } else {
      server.send(JSON.stringify({ type: "waiting", rating: Math.round(rating) }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const data = socket.deserializeAttachment() || {};
    if (data.status !== "matched" || !data.roomId) return;

    let packet;
    try {
      if (typeof message !== "string" || message.length > 16_384) return;
      packet = JSON.parse(message);
    } catch {
      return;
    }

    const allowed = new Set(["input", "action", "snapshot", "leave", "ping"]);
    if (!packet || !allowed.has(packet.type)) return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || peer.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const peerData = peer.deserializeAttachment() || {};
      if (peerData.status === "matched" && peerData.roomId === data.roomId) {
        peer.send(JSON.stringify({
          type: "peer-event",
          roomId: data.roomId,
          playerId: data.playerId,
          event: packet,
        }));
      }
    }
  }

  webSocketClose(socket, code, reason) {
    this.notifyPeer(socket, "opponent-disconnected");
    try { socket.close(code, reason); } catch {}
  }

  webSocketError(socket) {
    this.notifyPeer(socket, "opponent-disconnected");
  }

  notifyPeer(socket, type) {
    const data = socket.deserializeAttachment() || {};
    if (!data.roomId) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || peer.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const peerData = peer.deserializeAttachment() || {};
      if (peerData.roomId === data.roomId) {
        peer.send(JSON.stringify({ type, roomId: data.roomId }));
        peer.serializeAttachment({ ...peerData, status: "finished" });
      }
    }
  }
}
