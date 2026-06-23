import { randomUUID } from "node:crypto";
import { createDeck, handValue, shuffle } from "./deck.js";
import type { GamePhase, PlayerSnapshot, RankChangeSnapshot, RoomSnapshot } from "./types.js";
import type { Store } from "./store.js";
import { rankFromPoints, rankLossAmount, rankWinAmount } from "./ranking.js";

export type RoomPlayer = {
  id: string;
  socketId: string;
  userId: string;
  name: string;
  hand: string[];
  bust: boolean;
  stood: boolean;
  chips: number;
  bet: number;
};

export class GameRoom {
  code: string;
  hostPlayerId = "";
  players: RoomPlayer[] = [];
  phase: GamePhase = "lobby";
  deck: string[] = [];
  currentPlayerId: string | null = null;
  outcomeMessage = "";
  private betsSettled = false;
  rankChanges: RankChangeSnapshot[] = [];

  constructor(code: string) {
    this.code = code;
  }

  addPlayer(socketId: string, userId: string, name: string, store: Store): RoomPlayer {
    const chips = store.getChips(userId) ?? 0;
    const p: RoomPlayer = {
      id: randomUUID(),
      socketId,
      userId,
      name: name.trim().slice(0, 24) || "Player",
      hand: [],
      bust: false,
      stood: false,
      chips,
      bet: 0,
    };
    this.players.push(p);
    return p;
  }

  removePlayerBySocket(socketId: string, store: Store): RoomPlayer | undefined {
    const idx = this.players.findIndex((p) => p.socketId === socketId);
    if (idx === -1) return undefined;
    const [removed] = this.players.splice(idx, 1);
    if (this.hostPlayerId === removed.id && this.players.length > 0) {
      this.hostPlayerId = this.players[0].id;
    }
    if (this.phase === "playing") {
      this.applyDisconnectMidGame(removed.id, store);
    }
    return removed;
  }

  rebindSocket(playerId: string, socketId: string): boolean {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return false;
    p.socketId = socketId;
    return true;
  }

  getPlayerBySocket(socketId: string): RoomPlayer | undefined {
    return this.players.find((p) => p.socketId === socketId);
  }

  isHostSocket(socketId: string): boolean {
    const p = this.getPlayerBySocket(socketId);
    return !!p && p.id === this.hostPlayerId;
  }

  /** Per-viewer: during `playing`, only your own hand is visible until the round ends (`finished`). */
  snapshotForViewer(viewerPlayerId: string | null, store: Store): RoomSnapshot {
    const revealAll = this.phase === "lobby" || this.phase === "finished";
    return {
      code: this.code,
      hostPlayerId: this.hostPlayerId,
      phase: this.phase,
      players: this.players.map((p) =>
        this.playerSnapshotForViewer(p, viewerPlayerId, revealAll, store),
      ),
      currentPlayerId: this.currentPlayerId,
      outcomeMessage: this.outcomeMessage,
      deckRemaining: this.deck.length,
      rankChanges: this.phase === "finished" ? this.rankChanges : [],
    };
  }

  private playerSnapshotForViewer(
    p: RoomPlayer,
    viewerPlayerId: string | null,
    revealAll: boolean,
    store: Store,
  ): PlayerSnapshot {
    const rank = store.getRankInfo(p.userId) ?? rankFromPoints(0);
    const isSelf = viewerPlayerId !== null && p.id === viewerPlayerId;
    const reveal = revealAll || isSelf;
    if (!reveal) {
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        hand: [],
        concealedCount: p.hand.length,
        bust: p.bust,
        stood: p.stood,
        handValue: null,
        rank,
      };
    }
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      hand: [...p.hand],
      concealedCount: 0,
      bust: p.bust,
      stood: p.stood,
      handValue: p.bust ? null : handValue(p.hand),
      rank,
    };
  }

  setBet(
    socketId: string,
    amount: number,
    store: Store,
  ): { ok: true } | { ok: false; error: string } {
    const p = this.getPlayerBySocket(socketId);
    if (!p) return { ok: false, error: "Not in a room." };
    if (!(this.phase === "lobby" || this.phase === "finished")) {
      return { ok: false, error: "You can only bet before a hand starts." };
    }
    const a = Math.floor(Number(amount));
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: "Invalid bet amount." };

    // Refund previous bet first.
    if (p.bet > 0) {
      store.addChips(p.userId, p.bet);
      p.bet = 0;
    }

    if (a === 0) {
      p.chips = store.getChips(p.userId) ?? p.chips;
      return { ok: true };
    }

    const r = store.addChips(p.userId, -a);
    if (!r.ok) return { ok: false, error: r.error };
    p.bet = a;
    p.chips = r.chips;
    return { ok: true };
  }

  private refreshChips(store: Store) {
    for (const p of this.players) {
      const c = store.getChips(p.userId);
      if (c != null) p.chips = c;
    }
  }

  startGame(socketId: string, store: Store): { ok: true } | { ok: false; error: string } {
    if (!this.isHostSocket(socketId)) {
      return { ok: false, error: "Only the host can start the game." };
    }
    if (this.players.length < 2) {
      return { ok: false, error: "Need at least two players to start." };
    }
    if (this.phase === "playing") {
      return { ok: false, error: "A game is already in progress." };
    }
    this.refreshChips(store);
    if (this.players.some((p) => p.bet <= 0)) {
      return { ok: false, error: "Everyone must place a bet before the game can start." };
    }
    this.resetRoundState();
    this.phase = "playing";
    this.betsSettled = false;
    this.rankChanges = [];
    this.outcomeMessage = "";
    this.deck = shuffle(createDeck());
    for (const p of this.players) {
      p.hand = [];
      p.bust = false;
      p.stood = false;
    }
    const n = this.players.length;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        const card = this.deck.pop();
        if (card) this.players[i].hand.push(card);
      }
    }
    this.currentPlayerId = this.firstStillDecidingId();
    this.maybeResolveInstantWin(store);
    return { ok: true };
  }

  nextGame(socketId: string, store: Store): { ok: true } | { ok: false; error: string } {
    if (!this.isHostSocket(socketId)) {
      return { ok: false, error: "Only the host can start the next game." };
    }
    if (this.phase !== "finished") {
      return { ok: false, error: "Current hand has not finished." };
    }
    if (this.players.length < 2) {
      this.phase = "lobby";
      this.outcomeMessage = "Waiting for more players.";
      this.currentPlayerId = null;
      return { ok: false, error: "Need at least two players." };
    }
    return this.startGame(socketId, store);
  }

  hit(socketId: string, store: Store): { ok: true } | { ok: false; error: string } {
    const p = this.getPlayerBySocket(socketId);
    if (!p || this.phase !== "playing") {
      return { ok: false, error: "Cannot hit right now." };
    }
    if (p.id !== this.currentPlayerId) {
      return { ok: false, error: "It is not your turn." };
    }
    if (p.bust || p.stood) {
      return { ok: false, error: "You are already out this round." };
    }
    if (this.deck.length === 0) {
      return { ok: false, error: "Deck is empty — you cannot hit." };
    }
    const card = this.deck.pop()!;
    p.hand.push(card);
    if (handValue(p.hand) > 21) {
      p.bust = true;
      this.afterPlayerLeavesTurn(p.id, store);
    }
    return { ok: true };
  }

  stand(socketId: string, store: Store): { ok: true } | { ok: false; error: string } {
    const p = this.getPlayerBySocket(socketId);
    if (!p || this.phase !== "playing") {
      return { ok: false, error: "Cannot stand right now." };
    }
    if (p.id !== this.currentPlayerId) {
      return { ok: false, error: "It is not your turn." };
    }
    if (p.bust || p.stood) {
      return { ok: false, error: "You are already out this round." };
    }
    p.stood = true;
    this.afterPlayerLeavesTurn(p.id, store);
    return { ok: true };
  }

  private resetRoundState() {
    this.deck = [];
    this.currentPlayerId = null;
    this.outcomeMessage = "";
  }

  private stillDeciding(): RoomPlayer[] {
    return this.players.filter((p) => !p.bust && !p.stood);
  }

  private alive(): RoomPlayer[] {
    return this.players.filter((p) => !p.bust);
  }

  private firstStillDecidingId(): string | null {
    const s = this.stillDeciding();
    return s[0]?.id ?? null;
  }

  private nextAfter(prevId: string): string | null {
    const deciding = this.stillDeciding();
    if (deciding.length === 0) return null;
    const order = this.players.filter((p) => deciding.some((d) => d.id === p.id));
    const idx = order.findIndex((p) => p.id === prevId);
    if (idx === -1) return order[0].id;
    const next = order[(idx + 1) % order.length];
    return next.id;
  }

  private afterPlayerLeavesTurn(leftPlayerId: string, store: Store) {
    this.maybeResolveInstantWin(store);
    if (this.phase !== "playing") return;

    const deciding = this.stillDeciding();
    if (deciding.length === 0) {
      this.finishByStanding(store);
      return;
    }

    const nextId = this.nextAfter(leftPlayerId);
    this.currentPlayerId = nextId;
  }

  private determineWinners(): RoomPlayer[] {
    const alive = this.alive();
    if (alive.length === 0) return [];
    if (alive.length === 1) return [alive[0]];
    const scores = alive.map((p) => ({ p, v: handValue(p.hand) }));
    const best = Math.max(...scores.map((s) => s.v));
    const top = scores.filter((s) => s.v === best).map((s) => s.p);
    if (top.length >= 2) return [];
    return [top[0]!];
  }

  private settleRankPoints(store: Store) {
    const winners = this.determineWinners();
    if (winners.length !== 1) {
      this.rankChanges = [];
      return;
    }

    const winner = winners[0]!;
    const winnerTotal = handValue(winner.hand);
    const winAmount = rankWinAmount(winnerTotal);
    const changes: RankChangeSnapshot[] = [];

    for (const p of this.players) {
      if (p.id === winner.id) {
        const r = store.addRankPoints(p.userId, winAmount);
        if (r.ok) {
          changes.push({
            playerId: p.id,
            delta: winAmount,
            rankPoints: r.rankPoints,
            rank: r.rank,
          });
        }
      } else {
        const currentRp = store.getRankPoints(p.userId) ?? 0;
        const loss = rankLossAmount(currentRp);
        const r = store.addRankPoints(p.userId, -loss);
        if (r.ok) {
          changes.push({
            playerId: p.id,
            delta: -loss,
            rankPoints: r.rankPoints,
            rank: r.rank,
          });
        }
      }
    }

    this.rankChanges = changes;
  }

  private settleBets(store: Store) {
    if (this.betsSettled) return;
    if (this.phase !== "finished") return;
    this.betsSettled = true;

    const alive = this.alive();
    if (alive.length === 0) {
      for (const p of this.players) {
        if (p.bet > 0) {
          const r = store.addChips(p.userId, p.bet);
          if (r.ok) p.chips = r.chips;
          p.bet = 0;
        }
      }
    } else if (alive.length === 1) {
      const w = alive[0]!;
      const prize = w.bet * 2;
      if (prize > 0) {
        const r = store.addChips(w.userId, prize);
        if (r.ok) w.chips = r.chips;
      }
      w.bet = 0;
      for (const p of this.players) {
        if (p.id !== w.id) p.bet = 0;
      }
    } else {
      const scores = alive.map((p) => ({ p, v: handValue(p.hand) }));
      const best = Math.max(...scores.map((s) => s.v));
      const top = scores.filter((s) => s.v === best).map((s) => s.p);

      if (top.length >= 2) {
        for (const p of top) {
          if (p.bet > 0) {
            const r = store.addChips(p.userId, p.bet);
            if (r.ok) p.chips = r.chips;
          }
          p.bet = 0;
        }
        for (const p of this.players) {
          if (!top.some((t) => t.id === p.id)) p.bet = 0;
        }
      } else {
        const w = top[0]!;
        const prize = w.bet * 2;
        if (prize > 0) {
          const r = store.addChips(w.userId, prize);
          if (r.ok) w.chips = r.chips;
        }
        w.bet = 0;
        for (const p of this.players) {
          if (p.id !== w.id) p.bet = 0;
        }
      }
    }

    this.settleRankPoints(store);
  }

  private maybeResolveInstantWin(store: Store) {
    const alive = this.alive();
    if (alive.length === 0) {
      this.phase = "finished";
      this.outcomeMessage = "Everyone busted. No winner.";
      this.currentPlayerId = null;
      this.settleBets(store);
      return;
    }
    if (alive.length === 1) {
      const w = alive[0];
      this.phase = "finished";
      this.outcomeMessage = `${w.name} wins — last player standing (${handValue(w.hand)}).`;
      this.currentPlayerId = null;
      this.settleBets(store);
    }
  }

  private finishByStanding(store: Store) {
    const alive = this.alive();
    if (alive.length === 0) {
      this.phase = "finished";
      this.outcomeMessage = "No winner.";
      this.currentPlayerId = null;
      this.settleBets(store);
      return;
    }
    if (alive.length === 1) {
      const w = alive[0];
      this.phase = "finished";
      this.outcomeMessage = `${w.name} wins (${handValue(w.hand)}).`;
      this.currentPlayerId = null;
      this.settleBets(store);
      return;
    }
    const scores = alive.map((p) => ({ p, v: handValue(p.hand) }));
    const best = Math.max(...scores.map((s) => s.v));
    const top = scores.filter((s) => s.v === best);
    this.phase = "finished";
    this.currentPlayerId = null;
    if (top.length >= 2) {
      const names = top.map((t) => t.p.name).join(", ");
      this.outcomeMessage = `No winner — tie at ${best} between ${names}.`;
    } else {
      this.outcomeMessage = `${top[0].p.name} wins with ${best}.`;
    }
    this.settleBets(store);
  }

  private applyDisconnectMidGame(leftPlayerId: string, store: Store) {
    if (this.players.length === 0) {
      this.phase = "lobby";
      this.currentPlayerId = null;
      this.outcomeMessage = "Room closed.";
      return;
    }
    if (this.players.length === 1) {
      const w = this.players[0];
      if (!w.bust) {
        this.phase = "finished";
        this.outcomeMessage = `${w.name} wins — last player in the room (${handValue(w.hand)}).`;
      } else {
        this.phase = "finished";
        this.outcomeMessage = "No winner.";
      }
      this.currentPlayerId = null;
      this.settleBets(store);
      return;
    }
    if (this.currentPlayerId === leftPlayerId) {
      const next = this.firstStillDecidingId();
      this.currentPlayerId = next;
    }
    this.maybeResolveInstantWin(store);
    if (this.phase !== "playing") return;
    if (this.stillDeciding().length === 0) {
      this.finishByStanding(store);
    }
  }
}
