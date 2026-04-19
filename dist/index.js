/**
 * Dev: set PORT and CORS_ORIGIN (see .env.example). Run `npm run dev` from this folder.
 * Next app uses NEXT_PUBLIC_SOCKET_URL (e.g. http://localhost:3001) to connect.
 */
import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { GameRoom } from "./gameRoom.js";
const PORT = Number(process.env.PORT) || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomRoomCode() {
    let s = "";
    for (let i = 0; i < 4; i++) {
        s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return s;
}
function createUniqueRoomCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const code = randomRoomCode();
        if (!rooms.has(code))
            return code;
    }
    throw new Error("Could not allocate room code");
}
async function broadcastRoom(room) {
    const sockets = await io.in(room.code).fetchSockets();
    for (const s of sockets) {
        const viewerId = s.data.playerId;
        s.emit("state", room.snapshotForViewer(viewerId ?? null));
    }
}
function leaveRoom(socket) {
    const code = socket.data.roomCode;
    if (!code)
        return;
    const room = rooms.get(code);
    if (!room) {
        socket.data.roomCode = undefined;
        return;
    }
    room.removePlayerBySocket(socket.id);
    socket.leave(code);
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    if (room.players.length === 0) {
        rooms.delete(code);
    }
    else {
        void broadcastRoom(room);
    }
}
io.on("connection", (socket) => {
    socket.data.roomCode = undefined;
    socket.on("disconnect", () => {
        leaveRoom(socket);
    });
    socket.on("room:leave", () => {
        leaveRoom(socket);
        socket.emit("state", null);
    });
    socket.on("room:create", (displayName, ack) => {
        try {
            leaveRoom(socket);
            const code = createUniqueRoomCode();
            const room = new GameRoom(code);
            const host = room.addPlayer(socket.id, String(displayName ?? ""));
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
        }
        catch (e) {
            ack?.(e instanceof Error ? e.message : "error");
        }
    });
    socket.on("room:join", (payload, ack) => {
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
        const p = room.addPlayer(socket.id, name);
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.playerId = p.id;
        socket.emit("room:joined", {
            myPlayerId: p.id,
            room: room.snapshotForViewer(p.id),
        });
        void broadcastRoom(room);
        ack?.(null);
    });
    socket.on("game:start", (ack) => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : undefined;
        if (!room) {
            ack?.("Not in a room.");
            return;
        }
        const r = room.startGame(socket.id);
        if (!r.ok) {
            ack?.(r.error);
            return;
        }
        void broadcastRoom(room);
        ack?.(null);
    });
    socket.on("game:next", (ack) => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : undefined;
        if (!room) {
            ack?.("Not in a room.");
            return;
        }
        const r = room.nextGame(socket.id);
        if (!r.ok) {
            ack?.(r.error);
            void broadcastRoom(room);
            return;
        }
        void broadcastRoom(room);
        ack?.(null);
    });
    socket.on("action:hit", (ack) => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : undefined;
        if (!room) {
            ack?.("Not in a room.");
            return;
        }
        const r = room.hit(socket.id);
        if (!r.ok) {
            ack?.(r.error);
            return;
        }
        void broadcastRoom(room);
        ack?.(null);
    });
    socket.on("action:stand", (ack) => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : undefined;
        if (!room) {
            ack?.("Not in a room.");
            return;
        }
        const r = room.stand(socket.id);
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
