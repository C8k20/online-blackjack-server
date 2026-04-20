/**
 * Dev: set PORT and CORS_ORIGIN (see .env.example). Run `npm run dev` from this folder.
 * Next app uses NEXT_PUBLIC_SOCKET_URL (e.g. http://localhost:3001) to connect.
 */
import http from "node:http";
import cors from "cors";
import express from "express";
import { Server, type Socket } from "socket.io";
import { GameRoom } from "./gameRoom.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT) || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

const app = express();
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN }));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const store = new Store();

function bearerToken(req: express.Request): string | null {
  const h = String(req.header("authorization") ?? "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

app.post("/auth/register", (req, res) => {
  const r = store.register(req.body?.username, req.body?.password);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, token: r.token, userId: r.userId });
});

app.post("/auth/login", (req, res) => {
  const r = store.login(req.body?.username, req.body?.password);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, token: r.token, userId: r.userId });
});

app.post("/auth/logout", (req, res) => {
  const t = bearerToken(req);
  if (t) store.logout(t);
  return res.json({ ok: true });
});

app.get("/me", (req, res) => {
  const t = bearerToken(req);
  const userId = store.userIdForToken(t);
  if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const user = store.getUser(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
  return res.json({ ok: true, userId: user.id, username: user.username, chips: user.chips });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

const rooms = new Map<string, GameRoom>();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomRoomCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]!;
  }
  return s;
}

function createUniqueRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate room code");
}

async function broadcastRoom(room: GameRoom) {
  const sockets = await io.in(room.code).fetchSockets();
  for (const s of sockets) {
    const viewerId = s.data.playerId;
    s.emit("state", room.snapshotForViewer(viewerId ?? null));
  }
}

function leaveRoom(socket: Socket) {
  const code = socket.data.roomCode as string | undefined;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) {
    socket.data.roomCode = undefined;
    return;
  }
  room.removePlayerBySocket(socket.id, store);
  socket.leave(code);
  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    void broadcastRoom(room);
  }
}

io.on("connection", (socket) => {
  socket.data.roomCode = undefined;
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  const userId = store.userIdForToken(typeof token === "string" ? token : null);
  socket.data.userId = userId ?? undefined;

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });

  socket.on("room:leave", () => {
    leaveRoom(socket);
    socket.emit("state", null);
  });

  socket.on("room:create", (displayName: string, ack?: (e: unknown) => void) => {
    try {
      if (!socket.data.userId) {
        ack?.("You must be logged in to create a room.");
        return;
      }
      leaveRoom(socket);
      const code = createUniqueRoomCode();
      const room = new GameRoom(code);
      const host = room.addPlayer(socket.id, socket.data.userId, String(displayName ?? ""), store);
      room.hostPlayerId = host.id;
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = host.id;
      socket.emit("room:joined", {
        myPlayerId: host.id,
        room: room.snapshotForViewer(host.id),
      });
      void broadcastRoom(room);
      ack?.(null);
    } catch (e) {
      ack?.(e instanceof Error ? e.message : "error");
    }
  });

  socket.on(
    "room:join",
    (payload: { code?: string; displayName?: string }, ack?: (e: unknown) => void) => {
      if (!socket.data.userId) {
        ack?.("You must be logged in to join a room.");
        return;
      }
      const raw = payload?.code ?? "";
      const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const name = String(payload?.displayName ?? "");
      const room = rooms.get(code);
      if (!room) {
        ack?.("Room not found.");
        return;
      }
      if (room.phase === "playing") {
        ack?.("This room is in the middle of a hand. Try again later.");
        return;
      }
      leaveRoom(socket);
      const p = room.addPlayer(socket.id, socket.data.userId, name, store);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = p.id;
      socket.emit("room:joined", {
        myPlayerId: p.id,
        room: room.snapshotForViewer(p.id),
      });
      void broadcastRoom(room);
      ack?.(null);
    },
  );

  socket.on("game:start", (ack?: (e: unknown) => void) => {
    const code = socket.data.roomCode as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      ack?.("Not in a room.");
      return;
    }
    const r = room.startGame(socket.id, store);
    if (!r.ok) {
      ack?.(r.error);
      return;
    }
    void broadcastRoom(room);
    ack?.(null);
  });

  socket.on("game:next", (ack?: (e: unknown) => void) => {
    const code = socket.data.roomCode as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      ack?.("Not in a room.");
      return;
    }
    const r = room.nextGame(socket.id, store);
    if (!r.ok) {
      ack?.(r.error);
      void broadcastRoom(room);
      return;
    }
    void broadcastRoom(room);
    ack?.(null);
  });

  socket.on("action:hit", (ack?: (e: unknown) => void) => {
    const code = socket.data.roomCode as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      ack?.("Not in a room.");
      return;
    }
    const r = room.hit(socket.id, store);
    if (!r.ok) {
      ack?.(r.error);
      return;
    }
    void broadcastRoom(room);
    ack?.(null);
  });

  socket.on("action:stand", (ack?: (e: unknown) => void) => {
    const code = socket.data.roomCode as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      ack?.("Not in a room.");
      return;
    }
    const r = room.stand(socket.id, store);
    if (!r.ok) {
      ack?.(r.error);
      return;
    }
    void broadcastRoom(room);
    ack?.(null);
  });

  socket.on("bet:set", (amount: number, ack?: (e: unknown) => void) => {
    const code = socket.data.roomCode as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      ack?.("Not in a room.");
      return;
    }
    const r = room.setBet(socket.id, amount, store);
    if (!r.ok) {
      ack?.(r.error);
      return;
    }
    void broadcastRoom(room);
    ack?.(null);
  });
});

server.listen(PORT, () => {
  console.log(`Blackjack server on http://localhost:${PORT} (CORS ${CORS_ORIGIN})`);
});
