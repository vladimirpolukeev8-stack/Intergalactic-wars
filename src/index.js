const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, upgrade",
};

const QUEUE_MODES = new Set(["ranked_duel", "boss_coop"]);

function ratingWindow(rating) {
  return Math.min(500, 100 + Math.floor(Math.max(0, rating) / 500) * 50);
}


async function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== "string" || initData.length < 1 || initData.length > 12000) throw new Error("Invalid Telegram initData");
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHash) || !Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) throw new Error("Expired or invalid Telegram session");
  const entries = [...params.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value);
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode("WebAppData"));
  const dataKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const calculated = new Uint8Array(await crypto.subtle.sign("HMAC", dataKey, encoder.encode(entries.join("\n"))));
  const actual = [...calculated].map((v) => v.toString(16).padStart(2, "0")).join("");
  let mismatch = actual.length ^ suppliedHash.length;
  for (let i = 0; i < Math.max(actual.length, suppliedHash.length); i++) mismatch |= (actual.charCodeAt(i) || 0) ^ (suppliedHash.toLowerCase().charCodeAt(i) || 0);
  if (mismatch !== 0) throw new Error("Telegram signature verification failed");
  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch { user = null; }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) throw new Error("Telegram user is missing");
  return {
    id: String(user.id),
    username: typeof user.username === "string" ? user.username.slice(0, 64) : "",
    firstName: typeof user.first_name === "string" ? user.first_name.slice(0, 128) : "",
    lastName: typeof user.last_name === "string" ? user.last_name.slice(0, 128) : "",
    photoUrl: typeof user.photo_url === "string" ? user.photo_url.slice(0, 2048) : "",
  };
}
async function accountRequest(env, path, method, body, token) {
  const id = env.ACCOUNT_STORE.idFromName("global-account-store");
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token);
  return env.ACCOUNT_STORE.get(id).fetch("https://account.internal" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
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
          version: 4,
          telegramAccounts: true,
          social: { friends: true, clans: true, clanInvites: true },
          queues: {
            ranked_duel: { playersPerMatch: 2, rosterPerPlayer: 3 },
            boss_coop: { playersPerMatch: 3, rosterPerPlayer: 1 },
          },
        },
        { headers: JSON_HEADERS },
      );
    }


    if (url.pathname === "/api/auth/telegram" && request.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: "Telegram authentication is not configured" }, { status: 503, headers: JSON_HEADERS });
      try {
        const body = await request.json();
        const user = await verifyTelegramInitData(body?.initData, env.TELEGRAM_BOT_TOKEN);
        const result = await accountRequest(env, "/session/create", "POST", { user });
        return new Response(result.body, { status: result.status, headers: JSON_HEADERS });
      } catch (error) {
        return Response.json({ error: error.message || "Telegram authentication failed" }, { status: 401, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/api/me" || url.pathname === "/api/profile") {
      if (!["GET", "PUT"].includes(request.method)) return Response.json({ error: "Method not allowed" }, { status: 405, headers: JSON_HEADERS });
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (url.pathname === "/api/profile" && request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > 524288) return Response.json({ error: "Profile payload too large" }, { status: 413, headers: JSON_HEADERS });
        let body;
        try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: JSON_HEADERS }); }
        const result = await accountRequest(env, "/profile", "PUT", body, token);
        return new Response(result.body, { status: result.status, headers: JSON_HEADERS });
      }
      const path = url.pathname === "/api/me" ? "/me" : "/profile";
      const result = await accountRequest(env, path, "GET", undefined, token);
      return new Response(result.body, { status: result.status, headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith("/api/social")) {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const suffix = url.pathname.slice("/api/social".length);
      const raw = request.method === "GET" ? undefined : await request.text();
      if (raw && raw.length > 16384) return Response.json({ error: "Payload too large" }, { status: 413, headers: JSON_HEADERS });
      let body;
      if (raw) { try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: JSON_HEADERS }); } }
      const result = await accountRequest(env, "/social" + suffix + (url.search || ""), request.method, body, token);
      return new Response(result.body, { status: result.status, headers: JSON_HEADERS });
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


export class AccountStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, expires_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);" +
      "CREATE TABLE IF NOT EXISTS profiles (telegram_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(from_id,to_id));" +
      "CREATE INDEX IF NOT EXISTS friend_to_status_idx ON friend_requests(to_id,status);" +
      "CREATE TABLE IF NOT EXISTS battle_invites (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ranked_duel', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS battle_invites_to_status_idx ON battle_invites(to_id,status,created_at);" +
      "CREATE TABLE IF NOT EXISTS match_tickets (token_hash TEXT PRIMARY KEY, invite_id TEXT NOT NULL, user_id TEXT NOT NULL, peer_id TEXT NOT NULL, mode TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL DEFAULT 0);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS match_ticket_user_idx ON match_tickets(invite_id,user_id);"
      "CREATE TABLE IF NOT EXISTS clans (id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS clan_members (clan_id TEXT NOT NULL, telegram_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, PRIMARY KEY(clan_id,telegram_id));" +
      "CREATE TABLE IF NOT EXISTS clan_invites (id TEXT PRIMARY KEY, clan_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(clan_id,to_id));"
    );
    try { this.ctx.storage.sql.exec("ALTER TABLE users ADD COLUMN presence_at INTEGER NOT NULL DEFAULT 0"); } catch {}
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ticket/consume" && request.method === "POST") {
      const body=await request.json().catch(()=>({}));
      const ticket=String(body.ticket||"");
      if(!/^[A-Za-z0-9_-]{40,80}$/.test(ticket))return Response.json({error:"Invalid ticket"},{status:401});
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ticket));
      const tokenHash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
      const now=Date.now();
      const changed=this.ctx.storage.sql.exec("UPDATE match_tickets SET consumed_at=? WHERE token_hash=? AND consumed_at=0 AND expires_at>?",now,tokenHash,now);
      if(changed.rowsWritten!==1)return Response.json({error:"Ticket expired or already used"},{status:401});
      const row=this.ctx.storage.sql.exec("SELECT t.invite_id,t.user_id,t.peer_id,t.mode,i.status,i.created_at FROM match_tickets t JOIN battle_invites i ON i.id=t.invite_id WHERE t.token_hash=?",tokenHash).toArray()[0];
      if(!row||row.status!=="accepted"||row.created_at<now-300000)return Response.json({error:"Invite is no longer active"},{status:401});
      return Response.json({ok:true,inviteId:row.invite_id,userId:row.user_id,peerId:row.peer_id,mode:row.mode});
    }
    if (url.pathname === "/session/create" && request.method === "POST") {
      const body = await request.json();
      const user = body?.user;
      if (!user || !/^\d{1,24}$/.test(String(user.id))) return Response.json({ error: "Invalid user" }, { status: 400 });
      const now = Date.now();
      const existing = this.ctx.storage.sql.exec("SELECT telegram_id FROM users WHERE telegram_id = ?", String(user.id)).toArray()[0];
      this.ctx.storage.sql.exec(
        "INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, photo_url=excluded.photo_url, updated_at=excluded.updated_at",
        String(user.id), user.username || "", user.firstName || "", user.lastName || "", user.photoUrl || "", now, now
      );
      const rawToken = new Uint8Array(32);
      crypto.getRandomValues(rawToken);
      const token = btoa(String.fromCharCode(...rawToken)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
      const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
      this.ctx.storage.sql.exec("INSERT INTO sessions (token_hash, telegram_id, expires_at) VALUES (?, ?, ?)", tokenHash, String(user.id), expiresAt);
      return Response.json({ token, expiresAt, user: { id: String(user.id), username: user.username || "", firstName: user.firstName || "", lastName: user.lastName || "", photoUrl: user.photoUrl || "" }, isNew: !existing });
    }
    if (url.pathname.startsWith("/social")) {
      const auth = request.headers.get("authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token || token.length > 256) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
      const session = this.ctx.storage.sql.exec("SELECT telegram_id FROM sessions WHERE token_hash = ? AND expires_at > ?", tokenHash, Date.now()).toArray()[0];
      if (!session) return Response.json({ error: "Session expired" }, { status: 401 });
      const me = session.telegram_id, now = Date.now(), path = url.pathname;
      const body = request.method === "GET" ? {} : await request.json().catch(() => ({}));
      const userCard = (row) => ({ id: row.telegram_id, username: row.username || "", firstName: row.first_name || "", photoUrl: row.photo_url || "", online: Number(row.presence_at || 0) > now - 45000 });
      if (path === "/social/presence" && request.method === "POST") {
        this.ctx.storage.sql.exec("UPDATE users SET presence_at=? WHERE telegram_id=?", now, me);
        return Response.json({ ok: true, onlineUntil: now + 45000 });
      }
      if (path === "/social" && request.method === "GET") {
        const friends = this.ctx.storage.sql.exec(
          "SELECT u.telegram_id,u.username,u.first_name,u.photo_url,u.presence_at FROM friend_requests f JOIN users u ON u.telegram_id=CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END WHERE (f.from_id=? OR f.to_id=?) AND f.status='accepted' ORDER BY u.first_name,u.username",
          me,me,me
        ).toArray().map(userCard);
        const incoming = this.ctx.storage.sql.exec("SELECT f.id,u.telegram_id,u.username,u.first_name,u.photo_url FROM friend_requests f JOIN users u ON u.telegram_id=f.from_id WHERE f.to_id=? AND f.status='pending' ORDER BY f.created_at DESC",me).toArray().map(r=>({requestId:r.id,user:userCard(r)}));
        const outgoing = this.ctx.storage.sql.exec("SELECT f.id,u.telegram_id,u.username,u.first_name,u.photo_url FROM friend_requests f JOIN users u ON u.telegram_id=f.to_id WHERE f.from_id=? AND f.status='pending' ORDER BY f.created_at DESC",me).toArray().map(r=>({requestId:r.id,user:userCard(r)}));
        const clanRow = this.ctx.storage.sql.exec("SELECT c.id,c.name,c.tag,c.owner_id,m.role,(SELECT COUNT(*) FROM clan_members cm WHERE cm.clan_id=c.id) AS members FROM clan_members m JOIN clans c ON c.id=m.clan_id WHERE m.telegram_id=?",me).toArray()[0] || null;
        const clan = clanRow ? {id:clanRow.id,name:clanRow.name,tag:clanRow.tag,ownerId:clanRow.owner_id,role:clanRow.role,members:clanRow.members} : null;
        const clanInvites = this.ctx.storage.sql.exec("SELECT i.id,c.name,c.tag,u.username,u.first_name FROM clan_invites i JOIN clans c ON c.id=i.clan_id JOIN users u ON u.telegram_id=i.from_id WHERE i.to_id=? AND i.status='pending' ORDER BY i.created_at DESC",me).toArray().map(r=>({id:r.id,clanName:r.name,tag:r.tag,from:r.username||r.first_name||"Игрок"}));
        const battleInvites=this.ctx.storage.sql.exec("SELECT i.id,i.mode,i.created_at,u.telegram_id,u.username,u.first_name FROM battle_invites i JOIN users u ON u.telegram_id=i.from_id WHERE i.to_id=? AND i.status='pending' AND i.created_at>? ORDER BY i.created_at DESC LIMIT 20",me,now-120000).toArray().map(r=>({id:r.id,mode:r.mode,createdAt:r.created_at,from:userCard(r)}));
        const outgoingBattleInvites=this.ctx.storage.sql.exec("SELECT i.id,i.mode,i.status,i.created_at,u.telegram_id,u.username,u.first_name FROM battle_invites i JOIN users u ON u.telegram_id=i.to_id WHERE i.from_id=? AND i.status='pending' AND i.created_at>? ORDER BY i.created_at DESC LIMIT 20",me,now-120000).toArray().map(r=>({id:r.id,mode:r.mode,createdAt:r.created_at,to:userCard(r)}));
        const readyBattleInvites=this.ctx.storage.sql.exec("SELECT i.id,i.mode,i.from_id,i.to_id,i.created_at,u.telegram_id,u.username,u.first_name FROM battle_invites i JOIN users u ON u.telegram_id=CASE WHEN i.from_id=? THEN i.to_id ELSE i.from_id END WHERE (i.from_id=? OR i.to_id=?) AND i.status='accepted' AND i.created_at>? ORDER BY i.updated_at DESC LIMIT 10",me,me,me,now-300000).toArray().map(r=>({id:r.id,mode:r.mode,createdAt:r.created_at,peer:userCard(r)}));
        return Response.json({friends,incoming,outgoing,clan,clanInvites,battleInvites,outgoingBattleInvites,readyBattleInvites});
      }
      if (path === "/social/friends/request" && request.method === "POST") {
        const target = String(body.target || "").trim().replace(/^@/,"").slice(0,64);
        if (!target) return Response.json({error:"Укажи Telegram ID или @username"}, {status:400});
        const targetUser = this.ctx.storage.sql.exec("SELECT telegram_id FROM users WHERE telegram_id=? OR lower(username)=lower(?) LIMIT 1",target,target).toArray()[0];
        if (!targetUser) return Response.json({error:"Игрок не найден. Он должен хотя бы раз открыть игру."},{status:404});
        if (targetUser.telegram_id === me) return Response.json({error:"Нельзя добавить самого себя"},{status:400});
        const existing=this.ctx.storage.sql.exec("SELECT id,status FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",me,targetUser.telegram_id,targetUser.telegram_id,me).toArray()[0];
        if(existing){if(existing.status==="accepted")return Response.json({error:"Вы уже друзья"},{status:409});return Response.json({error:"Заявка уже существует"},{status:409});}
        this.ctx.storage.sql.exec("INSERT INTO friend_requests (id,from_id,to_id,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)",crypto.randomUUID(),me,targetUser.telegram_id,now,now);
        return Response.json({ok:true});
      }
      if (path === "/social/battle-invites" && request.method === "POST") {
        const target=String(body.target||"").trim().slice(0,80);
        const mode=String(body.mode||"ranked_duel");
        if(!/^[0-9]{1,24}$/.test(target)||!["ranked_duel","boss_coop"].includes(mode))return Response.json({error:"Некорректный игрок или режим"},{status:400});
        if(target===me)return Response.json({error:"Нельзя пригласить самого себя"},{status:400});
        const friend=this.ctx.storage.sql.exec("SELECT id FROM friend_requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",me,target,target,me).toArray()[0];
        if(!friend)return Response.json({error:"Приглашать в бой можно только друзей"},{status:403});
        const recent=this.ctx.storage.sql.exec("SELECT id FROM battle_invites WHERE from_id=? AND to_id=? AND status='pending' AND created_at>?",me,target,now-120000).toArray()[0];
        if(recent)return Response.json({error:"Приглашение уже ожидает ответа"},{status:409});
        const id=crypto.randomUUID();
        this.ctx.storage.sql.exec("INSERT INTO battle_invites (id,from_id,to_id,mode,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?)",id,me,target,mode,now,now);
        return Response.json({ok:true,inviteId:id,expiresAt:now+120000});
      }
      if (path === "/social/battle-invites/respond" && request.method === "POST") {
        const id=String(body.inviteId||"").slice(0,64),accept=body.accept===true;
        const invite=this.ctx.storage.sql.exec("SELECT id,from_id,mode,created_at FROM battle_invites WHERE id=? AND to_id=? AND status='pending'",id,me).toArray()[0];
        if(!invite)return Response.json({error:"Приглашение уже недействительно"},{status:404});
        if(invite.created_at<now-120000){this.ctx.storage.sql.exec("UPDATE battle_invites SET status='expired',updated_at=? WHERE id=?",now,id);return Response.json({error:"Время приглашения истекло"},{status:410});}
        this.ctx.storage.sql.exec("UPDATE battle_invites SET status=?,updated_at=? WHERE id=? AND to_id=? AND status='pending'",accept?"accepted":"declined",now,id,me);
        return Response.json({ok:true,accepted:accept,mode:invite.mode,fromId:invite.from_id,inviteId:id});
      }
      if (path === "/social/battle-invites/ticket" && request.method === "POST") {
        const id=String(body.inviteId||"").slice(0,64);
        const invite=this.ctx.storage.sql.exec("SELECT id,from_id,to_id,mode,created_at,status FROM battle_invites WHERE id=? AND (from_id=? OR to_id=?)",id,me,me).toArray()[0];
        if(!invite||invite.status!=="accepted"||invite.mode!=="ranked_duel"||invite.created_at<now-300000) return Response.json({error:"Принятое приглашение не найдено или истекло"},{status:404});
        const peerId=invite.from_id===me?invite.to_id:invite.from_id;
        const raw=new Uint8Array(32);crypto.getRandomValues(raw);
        const ticket=btoa(String.fromCharCode(...raw)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
        const hashBytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ticket)));
        const tokenHash=[...hashBytes].map(v=>v.toString(16).padStart(2,"0")).join("");
        this.ctx.storage.sql.exec("DELETE FROM match_tickets WHERE invite_id=? AND user_id=? AND consumed_at=0",id,me);
        this.ctx.storage.sql.exec("INSERT INTO match_tickets (token_hash,invite_id,user_id,peer_id,mode,expires_at,consumed_at) VALUES (?,?,?,?,?,?,0)",tokenHash,id,me,peerId,invite.mode,now+90000);
        return Response.json({ok:true,ticket,mode:invite.mode,expiresAt:now+90000});
      }
      if (path === "/social/friends/respond" && request.method === "POST") {
        const id=String(body.requestId||"").slice(0,64), accept=body.accept===true;
        const result=this.ctx.storage.sql.exec("UPDATE friend_requests SET status=?,updated_at=? WHERE id=? AND to_id=? AND status='pending'",accept?"accepted":"declined",now,id,me);
        return Response.json({ok:result.rowsWritten===1});
      }
      if (path === "/social/clans" && request.method === "GET") {
        const q=String(url.searchParams.get("q")||"").trim().slice(0,40);
        const rows=this.ctx.storage.sql.exec("SELECT c.id,c.name,c.tag,c.owner_id,COUNT(m.telegram_id) AS members FROM clans c LEFT JOIN clan_members m ON m.clan_id=c.id WHERE (?='' OR lower(c.name) LIKE lower(?) OR lower(c.tag) LIKE lower(?)) GROUP BY c.id ORDER BY members DESC,c.created_at DESC LIMIT 30",q,q+"%",q+"%").toArray();
        return Response.json({clans:rows.map(r=>({id:r.id,name:r.name,tag:r.tag,members:r.members,ownerId:r.owner_id}))});
      }
      if (path === "/social/clans/create" && request.method === "POST") {
        const name=String(body.name||"").trim().slice(0,24),tag=String(body.tag||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5);
        if(name.length<3||tag.length<2)return Response.json({error:"Название: 3–24 символа, тег: 2–5 латинских букв/цифр"},{status:400});
        const member=this.ctx.storage.sql.exec("SELECT clan_id FROM clan_members WHERE telegram_id=?",me).toArray()[0];
        if(member)return Response.json({error:"Сначала покинь текущий клан"},{status:409});
        const id=crypto.randomUUID();
        try{this.ctx.storage.sql.exec("INSERT INTO clans (id,name,tag,owner_id,created_at) VALUES (?,?,?,?,?)",id,name,tag,me,now);this.ctx.storage.sql.exec("INSERT INTO clan_members (clan_id,telegram_id,role,joined_at) VALUES (?,?,'leader',?)",id,me,now);}
        catch{return Response.json({error:"Тег уже занят или не удалось создать клан"},{status:409});}
        return Response.json({ok:true,clan:{id,name,tag,ownerId:me,role:"leader",members:1}});
      }
      if (path === "/social/clans/join" && request.method === "POST") {
        const id=String(body.clanId||"").slice(0,64),member=this.ctx.storage.sql.exec("SELECT clan_id FROM clan_members WHERE telegram_id=?",me).toArray()[0];
        if(member)return Response.json({error:"Ты уже состоишь в клане"},{status:409});
        const clan=this.ctx.storage.sql.exec("SELECT id FROM clans WHERE id=?",id).toArray()[0];
        if(!clan)return Response.json({error:"Клан не найден"},{status:404});
        const size=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM clan_members WHERE clan_id=?",id).toArray()[0]?.n||0;
        if(size>=50)return Response.json({error:"В клане уже 50 участников"},{status:409});
        this.ctx.storage.sql.exec("INSERT INTO clan_members (clan_id,telegram_id,role,joined_at) VALUES (?,?,'member',?)",id,me,now);
        return Response.json({ok:true});
      }
      if (path === "/social/clans/leave" && request.method === "POST") {
        const membership=this.ctx.storage.sql.exec("SELECT clan_id,role FROM clan_members WHERE telegram_id=?",me).toArray()[0];
        if(!membership)return Response.json({error:"Ты не состоишь в клане"},{status:404});
        if(membership.role==="leader"){
          const next=this.ctx.storage.sql.exec("SELECT telegram_id FROM clan_members WHERE clan_id=? AND telegram_id<>? ORDER BY joined_at LIMIT 1",membership.clan_id,me).toArray()[0];
          if(next)this.ctx.storage.sql.exec("UPDATE clan_members SET role='leader' WHERE clan_id=? AND telegram_id=?",membership.clan_id,next.telegram_id);
          else this.ctx.storage.sql.exec("DELETE FROM clans WHERE id=?",membership.clan_id);
        }
        this.ctx.storage.sql.exec("DELETE FROM clan_members WHERE clan_id=? AND telegram_id=?",membership.clan_id,me);
        return Response.json({ok:true});
      }
      if (path === "/social/clans/invite" && request.method === "POST") {
        const target=String(body.target||"").trim().replace(/^@/,"").slice(0,64);
        const membership=this.ctx.storage.sql.exec("SELECT clan_id FROM clan_members WHERE telegram_id=?",me).toArray()[0];
        if(!membership)return Response.json({error:"Сначала вступи в клан"},{status:409});
        const targetUser=this.ctx.storage.sql.exec("SELECT telegram_id FROM users WHERE telegram_id=? OR lower(username)=lower(?) LIMIT 1",target,target).toArray()[0];
        if(!targetUser||targetUser.telegram_id===me)return Response.json({error:"Игрок не найден"},{status:404});
        if(this.ctx.storage.sql.exec("SELECT telegram_id FROM clan_members WHERE telegram_id=?",targetUser.telegram_id).toArray().length)return Response.json({error:"Игрок уже состоит в клане"},{status:409});
        try{this.ctx.storage.sql.exec("INSERT INTO clan_invites (id,clan_id,from_id,to_id,status,created_at) VALUES (?,?,?,?,'pending',?)",crypto.randomUUID(),membership.clan_id,me,targetUser.telegram_id,now);}
        catch{return Response.json({error:"Приглашение уже отправлено"},{status:409});}
        return Response.json({ok:true});
      }
      if (path === "/social/clans/invite/respond" && request.method === "POST") {
        const id=String(body.inviteId||"").slice(0,64),accept=body.accept===true;
        const invite=this.ctx.storage.sql.exec("SELECT clan_id FROM clan_invites WHERE id=? AND to_id=? AND status='pending'",id,me).toArray()[0];
        if(!invite)return Response.json({error:"Приглашение не найдено"},{status:404});
        if(accept){
          const member=this.ctx.storage.sql.exec("SELECT telegram_id FROM clan_members WHERE telegram_id=?",me).toArray()[0];
          if(member)return Response.json({error:"Ты уже состоишь в клане"},{status:409});
          const size=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM clan_members WHERE clan_id=?",invite.clan_id).toArray()[0]?.n||0;
          if(size>=50)return Response.json({error:"В клане уже 50 участников"},{status:409});
          this.ctx.storage.sql.exec("INSERT INTO clan_members (clan_id,telegram_id,role,joined_at) VALUES (?,?,'member',?)",invite.clan_id,me,now);
        }
        this.ctx.storage.sql.exec("UPDATE clan_invites SET status=? WHERE id=? AND to_id=?",accept?"accepted":"declined",id,me);
        return Response.json({ok:true});
      }
      return Response.json({error:"Not found"},{status:404});
    }
    const auth = request.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token || token.length > 256) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
    const session = this.ctx.storage.sql.exec("SELECT telegram_id FROM sessions WHERE token_hash = ? AND expires_at > ?", tokenHash, Date.now()).toArray()[0];
    if (!session) return Response.json({ error: "Session expired" }, { status: 401 });
    if (url.pathname === "/me" && request.method === "GET") {
      const user = this.ctx.storage.sql.exec("SELECT telegram_id, username, first_name, last_name, photo_url, created_at, updated_at FROM users WHERE telegram_id = ?", session.telegram_id).toArray()[0];
      return Response.json({ user: user ? { id: user.telegram_id, username: user.username, firstName: user.first_name, lastName: user.last_name, photoUrl: user.photo_url, createdAt: user.created_at, updatedAt: user.updated_at } : null });
    }
    if (url.pathname === "/profile" && request.method === "GET") {
      const row = this.ctx.storage.sql.exec("SELECT data_json, updated_at FROM profiles WHERE telegram_id = ?", session.telegram_id).toArray()[0];
      return Response.json({ profile: row ? JSON.parse(row.data_json) : null, updatedAt: row?.updated_at || 0 });
    }
    if (url.pathname === "/profile" && request.method === "PUT") {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || !body.state || typeof body.state !== "object" || Array.isArray(body.state)) return Response.json({ error: "Invalid profile state" }, { status: 400 });
      const data = JSON.stringify(body.state);
      if (data.length > 524288) return Response.json({ error: "Profile payload too large" }, { status: 413 });
      const now = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO profiles (telegram_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at", session.telegram_id, data, now);
      return Response.json({ ok: true, updatedAt: now });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
