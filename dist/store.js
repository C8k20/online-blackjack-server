import fs from "node:fs";
import path from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
function dataFilePath() {
    // Keep data beside the server project (persist across restarts).
    return path.resolve(process.cwd(), "data.json");
}
function readDb() {
    const p = dataFilePath();
    try {
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        return {
            users: Array.isArray(parsed.users) ? parsed.users : [],
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        };
    }
    catch {
        return { users: [], sessions: [] };
    }
}
function writeDb(db) {
    const p = dataFilePath();
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, p);
}
function normalizeUsername(u) {
    return String(u ?? "").trim().toLowerCase();
}
function hashPassword(password, salt) {
    const h = scryptSync(password, salt, 32);
    return h.toString("hex");
}
function makeSalt() {
    // 16 bytes, hex.
    return Buffer.from(scryptSync(randomUUID(), "salt", 16)).toString("hex");
}
export class Store {
    db = readDb();
    flush() {
        writeDb(this.db);
    }
    register(username, password) {
        const u = normalizeUsername(username);
        const p = String(password ?? "");
        if (u.length < 3)
            return { ok: false, error: "Username must be at least 3 characters." };
        if (p.length < 6)
            return { ok: false, error: "Password must be at least 6 characters." };
        if (this.db.users.some((x) => x.username === u))
            return { ok: false, error: "Username is taken." };
        const salt = makeSalt();
        const user = {
            id: randomUUID(),
            username: u,
            passwordSalt: salt,
            passwordHash: hashPassword(p, salt),
            chips: 1000,
        };
        this.db.users.push(user);
        const token = randomUUID();
        this.db.sessions.push({ token, userId: user.id, createdAtMs: Date.now() });
        this.flush();
        return { ok: true, token, userId: user.id };
    }
    login(username, password) {
        const u = normalizeUsername(username);
        const p = String(password ?? "");
        const user = this.db.users.find((x) => x.username === u);
        if (!user)
            return { ok: false, error: "Invalid username or password." };
        const candidate = Buffer.from(hashPassword(p, user.passwordSalt), "hex");
        const actual = Buffer.from(user.passwordHash, "hex");
        if (candidate.length !== actual.length || !timingSafeEqual(candidate, actual)) {
            return { ok: false, error: "Invalid username or password." };
        }
        const token = randomUUID();
        this.db.sessions.push({ token, userId: user.id, createdAtMs: Date.now() });
        this.flush();
        return { ok: true, token, userId: user.id };
    }
    logout(token) {
        const t = String(token ?? "");
        if (!t)
            return;
        this.db.sessions = this.db.sessions.filter((s) => s.token !== t);
        this.flush();
    }
    userIdForToken(token) {
        const t = String(token ?? "");
        if (!t)
            return null;
        const s = this.db.sessions.find((x) => x.token === t);
        return s?.userId ?? null;
    }
    getUser(userId) {
        return this.db.users.find((u) => u.id === userId) ?? null;
    }
    getChips(userId) {
        const u = this.getUser(userId);
        return u ? u.chips : null;
    }
    setChips(userId, chips) {
        const u = this.getUser(userId);
        if (!u)
            return false;
        u.chips = Math.max(0, Math.floor(chips));
        this.flush();
        return true;
    }
    addChips(userId, delta) {
        const u = this.getUser(userId);
        if (!u)
            return { ok: false, error: "User not found." };
        const next = u.chips + Math.floor(delta);
        if (next < 0)
            return { ok: false, error: "Insufficient chips." };
        u.chips = next;
        this.flush();
        return { ok: true, chips: u.chips };
    }
}
