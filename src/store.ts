import fs from "node:fs";
import path from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { rankFromPoints, type RankInfo } from "./ranking.js";

type UserRecord = {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  chips: number;
  rankPoints: number;
};

type SessionRecord = {
  token: string;
  userId: string;
  createdAtMs: number;
};

type DbShape = {
  users: UserRecord[];
  sessions: SessionRecord[];
};

function dataFilePath(): string {
  // Keep data beside the server project (persist across restarts).
  return path.resolve(process.cwd(), "data.json");
}

function readDb(): DbShape {
  const p = dataFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    const users = Array.isArray(parsed.users)
      ? (parsed.users as Partial<UserRecord>[]).map((u) => ({
          id: String(u.id ?? ""),
          username: String(u.username ?? ""),
          passwordSalt: String(u.passwordSalt ?? ""),
          passwordHash: String(u.passwordHash ?? ""),
          chips: typeof u.chips === "number" ? u.chips : 1000,
          rankPoints: typeof u.rankPoints === "number" ? Math.max(0, u.rankPoints) : 0,
        }))
      : [];
    return {
      users,
      sessions: Array.isArray(parsed.sessions) ? (parsed.sessions as SessionRecord[]) : [],
    };
  } catch {
    return { users: [], sessions: [] };
  }
}

function writeDb(db: DbShape) {
  const p = dataFilePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function normalizeUsername(u: string): string {
  return String(u ?? "").trim().toLowerCase();
}

function hashPassword(password: string, salt: string): string {
  const h = scryptSync(password, salt, 32);
  return h.toString("hex");
}

function makeSalt(): string {
  // 16 bytes, hex.
  return Buffer.from(scryptSync(randomUUID(), "salt", 16)).toString("hex");
}

export class Store {
  private db: DbShape = readDb();

  private flush() {
    writeDb(this.db);
  }

  register(username: string, password: string): { ok: true; token: string; userId: string } | { ok: false; error: string } {
    const u = normalizeUsername(username);
    const p = String(password ?? "");
    if (u.length < 3) return { ok: false, error: "Username must be at least 3 characters." };
    if (p.length < 6) return { ok: false, error: "Password must be at least 6 characters." };
    if (this.db.users.some((x) => x.username === u)) return { ok: false, error: "Username is taken." };

    const salt = makeSalt();
    const user: UserRecord = {
      id: randomUUID(),
      username: u,
      passwordSalt: salt,
      passwordHash: hashPassword(p, salt),
      chips: 1000,
      rankPoints: 0,
    };
    this.db.users.push(user);

    const token = randomUUID();
    this.db.sessions.push({ token, userId: user.id, createdAtMs: Date.now() });
    this.flush();
    return { ok: true, token, userId: user.id };
  }

  login(username: string, password: string): { ok: true; token: string; userId: string } | { ok: false; error: string } {
    const u = normalizeUsername(username);
    const p = String(password ?? "");
    const user = this.db.users.find((x) => x.username === u);
    if (!user) return { ok: false, error: "Invalid username or password." };
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

  logout(token: string) {
    const t = String(token ?? "");
    if (!t) return;
    this.db.sessions = this.db.sessions.filter((s) => s.token !== t);
    this.flush();
  }

  userIdForToken(token: string | null | undefined): string | null {
    const t = String(token ?? "");
    if (!t) return null;
    const s = this.db.sessions.find((x) => x.token === t);
    return s?.userId ?? null;
  }

  getUser(userId: string): UserRecord | null {
    return this.db.users.find((u) => u.id === userId) ?? null;
  }

  getChips(userId: string): number | null {
    const u = this.getUser(userId);
    return u ? u.chips : null;
  }

  setChips(userId: string, chips: number): boolean {
    const u = this.getUser(userId);
    if (!u) return false;
    u.chips = Math.max(0, Math.floor(chips));
    this.flush();
    return true;
  }

  addChips(userId: string, delta: number): { ok: true; chips: number } | { ok: false; error: string } {
    const u = this.getUser(userId);
    if (!u) return { ok: false, error: "User not found." };
    const next = u.chips + Math.floor(delta);
    if (next < 0) return { ok: false, error: "Insufficient chips." };
    u.chips = next;
    this.flush();
    return { ok: true, chips: u.chips };
  }

  getRankPoints(userId: string): number | null {
    const u = this.getUser(userId);
    return u ? u.rankPoints : null;
  }

  getRankInfo(userId: string): RankInfo | null {
    const rp = this.getRankPoints(userId);
    return rp == null ? null : rankFromPoints(rp);
  }

  addRankPoints(
    userId: string,
    delta: number,
  ): { ok: true; rankPoints: number; rank: RankInfo } | { ok: false; error: string } {
    const u = this.getUser(userId);
    if (!u) return { ok: false, error: "User not found." };
    u.rankPoints = Math.max(0, u.rankPoints + Math.floor(delta));
    this.flush();
    return { ok: true, rankPoints: u.rankPoints, rank: rankFromPoints(u.rankPoints) };
  }

  publicProfile(userId: string): {
    userId: string;
    username: string;
    chips: number;
    rankPoints: number;
    rank: RankInfo;
  } | null {
    const u = this.getUser(userId);
    if (!u) return null;
    return {
      userId: u.id,
      username: u.username,
      chips: u.chips,
      rankPoints: u.rankPoints,
      rank: rankFromPoints(u.rankPoints),
    };
  }
}

