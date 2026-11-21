const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, upgrade",
};

const QUEUE_MODES = new Set(["ranked_duel", "boss_coop"]);

function ratingWindow(rating) {
  return Math.min(500, 100 + Math.floor(Math.max(0, rating) / 500) * 50);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "intergalactic-wars-matchmaker",
          version: 2,
          queues: {
            ranked_duel: { playersPerMatch: 2, rosterPerPlayer: 3 },
            boss_coop: { playersPerMatch: 3, rosterPerPlayer: 1 },
          },
        },
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
    const mode = url.searchParams.get("mode") || "ranked_duel";
    const teamSize = mode === "boss_coop" ? 3 : 2;
    let roster = [];

    try {
      const parsed = JSON.parse(url.searchParams.get("roster") || "[]");
      if (Array.isArray(parsed)) {
        roster = [...new Set(
          parsed.filter((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,48}$/.test(id)),
        )].slice(0, 3);
      }
    } catch {}

    const expectedRosterSize = mode === "boss_coop" ? 1 : 3;
    if (
      !/^[a-zA-Z0-9_-]{8,80}$/.test(playerId) ||
      !Number.isFinite(rating) ||
      rating < 0 ||
      rating > 100000 ||
      !QUEUE_MODES.has(mode) ||
      roster.length !== expectedRosterSize
    ) {
      return Response.json({ error: "Invalid playerId, rating, mode or roster" }, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      playerId,
      rating: Math.round(rating),
      roster,
      mode,
      teamSize,
      status: "waiting",
      connectedAt: Date.now(),
    });

    const waiting = this.ctx.getWebSockets()
      .filter((socket) => {
        const data = socket.deserializeAttachment() || {};
        return socket !== server &&
          data.status === "waiting" &&
          data.mode === mode &&
          data.teamSize === teamSize &&
          data.playerId !== playerId &&
          socket.readyState === WebSocket.READY_STATE_OPEN &&
          Math.abs(data.rating - Math.round(rating)) <=
            Math.max(ratingWindow(data.rating), ratingWindow(rating));
      })
      .sort((a, b) => {
        const aa = a.deserializeAttachment() || {};
        const bb = b.deserializeAttachment() || {};
        return (aa.connectedAt || 0) - (bb.connectedAt || 0);
      });

    const participants = [server, ...waiting.slice(0, teamSize - 1)];
    if (participants.length === teamSize) {
      const roomId = crypto.randomUUID();
      const players = participants.map((socket) => {
        const data = socket.deserializeAttachment() || {};
        return {
          playerId: data.playerId,
          rating: data.rating,
          roster: data.roster,
        };
      });

      participants.forEach((socket, index) => {
        const data = socket.deserializeAttachment() || {};
        socket.serializeAttachment({
          ...data,
          status: "matched",
          roomId,
          teamIndex: index,
          participantIds: players.map((player) => player.playerId),
        });

        if (mode === "ranked_duel") {
          const opponent = players[index === 0 ? 1 : 0];
          socket.send(JSON.stringify({
            type: "matched",
            mode,
            roomId,
            self: { playerId: data.playerId, rating: data.rating },
            opponent,
          }));
        } else {
          socket.send(JSON.stringify({
            type: "matched",
            mode,
            roomId,
            selfPlayerId: data.playerId,
            team: players,
          }));
        }
      });
    } else {
      server.send(JSON.stringify({
        type: "waiting",
        mode,
        rating: Math.round(rating),
        playersFound: 1,
        playersNeeded: teamSize,
      }));
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

    const allowed = new Set(["input", "action", "snapshot", "hit", "leave", "ping"]);
    if (!packet || !allowed.has(packet.type)) return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || peer.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const peerData = peer.deserializeAttachment() || {};
      if (peerData.status === "matched" && peerData.roomId === data.roomId) {
        peer.send(JSON.stringify({
          type: "peer-event",
          roomId: data.roomId,
          playerId: data.playerId,
          teamIndex: data.teamIndex,
          event: packet,
        }));
      }
    }
  }

  webSocketClose(socket, code, reason) {
    this.notifyPeers(socket, "opponent-disconnected");
    try { socket.close(code, reason); } catch {}
  }

  webSocketError(socket) {
    this.notifyPeers(socket, "opponent-disconnected");
  }

  notifyPeers(socket, type) {
    const data = socket.deserializeAttachment() || {};
    if (!data.roomId) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || peer.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const peerData = peer.deserializeAttachment() || {};
      if (peerData.roomId === data.roomId) {
        peer.send(JSON.stringify({
          type,
          roomId: data.roomId,
          playerId: data.playerId,
          teamIndex: data.teamIndex,
        }));
        peer.serializeAttachment({ ...peerData, status: "finished" });
      }
    }
  }
}
