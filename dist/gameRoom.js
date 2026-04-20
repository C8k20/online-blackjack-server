import { randomUUID } from "node:crypto";
import { createDeck, handValue, shuffle } from "./deck.js";
export class GameRoom {
    code;
    hostPlayerId = "";
    players = [];
    phase = "lobby";
    deck = [];
    currentPlayerId = null;
    outcomeMessage = "";
    betsSettled = false;
    constructor(code) {
        this.code = code;
    }
    addPlayer(socketId, userId, name, store) {
        const chips = store.getChips(userId) ?? 0;
        const p = {
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
    removePlayerBySocket(socketId, store) {
        const idx = this.players.findIndex((p) => p.socketId === socketId);
        if (idx === -1)
            return undefined;
        const [removed] = this.players.splice(idx, 1);
        if (this.hostPlayerId === removed.id && this.players.length > 0) {
            this.hostPlayerId = this.players[0].id;
        }
        if (this.phase === "playing") {
            this.applyDisconnectMidGame(removed.id, store);
        }
        return removed;
    }
    rebindSocket(playerId, socketId) {
        const p = this.players.find((x) => x.id === playerId);
        if (!p)
            return false;
        p.socketId = socketId;
        return true;
    }
    getPlayerBySocket(socketId) {
        return this.players.find((p) => p.socketId === socketId);
    }
    isHostSocket(socketId) {
        const p = this.getPlayerBySocket(socketId);
        return !!p && p.id === this.hostPlayerId;
    }
    /** Per-viewer: during `playing`, only your own hand is visible until the round ends (`finished`). */
    snapshotForViewer(viewerPlayerId) {
        const revealAll = this.phase === "lobby" || this.phase === "finished";
        return {
            code: this.code,
            hostPlayerId: this.hostPlayerId,
            phase: this.phase,
            players: this.players.map((p) => this.playerSnapshotForViewer(p, viewerPlayerId, revealAll)),
            currentPlayerId: this.currentPlayerId,
            outcomeMessage: this.outcomeMessage,
            deckRemaining: this.deck.length,
        };
    }
    playerSnapshotForViewer(p, viewerPlayerId, revealAll) {
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
        };
    }
    setBet(socketId, amount, store) {
        const p = this.getPlayerBySocket(socketId);
        if (!p)
            return { ok: false, error: "Not in a room." };
        if (!(this.phase === "lobby" || this.phase === "finished")) {
            return { ok: false, error: "You can only bet before a hand starts." };
        }
        const a = Math.floor(Number(amount));
        if (!Number.isFinite(a) || a < 0)
            return { ok: false, error: "Invalid bet amount." };
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
        if (!r.ok)
            return { ok: false, error: r.error };
        p.bet = a;
        p.chips = r.chips;
        return { ok: true };
    }
    refreshChips(store) {
        for (const p of this.players) {
            const c = store.getChips(p.userId);
            if (c != null)
                p.chips = c;
        }
    }
    startGame(socketId, store) {
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
                if (card)
                    this.players[i].hand.push(card);
            }
        }
        this.currentPlayerId = this.firstStillDecidingId();
        this.maybeResolveInstantWin(store);
        return { ok: true };
    }
    nextGame(socketId, store) {
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
    hit(socketId, store) {
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
        const card = this.deck.pop();
        p.hand.push(card);
        if (handValue(p.hand) > 21) {
            p.bust = true;
            this.afterPlayerLeavesTurn(p.id, store);
        }
        return { ok: true };
    }
    stand(socketId, store) {
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
    resetRoundState() {
        this.deck = [];
        this.currentPlayerId = null;
        this.outcomeMessage = "";
    }
    stillDeciding() {
        return this.players.filter((p) => !p.bust && !p.stood);
    }
    alive() {
        return this.players.filter((p) => !p.bust);
    }
    firstStillDecidingId() {
        const s = this.stillDeciding();
        return s[0]?.id ?? null;
    }
    nextAfter(prevId) {
        const deciding = this.stillDeciding();
        if (deciding.length === 0)
            return null;
        const order = this.players.filter((p) => deciding.some((d) => d.id === p.id));
        const idx = order.findIndex((p) => p.id === prevId);
        if (idx === -1)
            return order[0].id;
        const next = order[(idx + 1) % order.length];
        return next.id;
    }
    afterPlayerLeavesTurn(leftPlayerId, store) {
        this.maybeResolveInstantWin(store);
        if (this.phase !== "playing")
            return;
        const deciding = this.stillDeciding();
        if (deciding.length === 0) {
            this.finishByStanding(store);
            return;
        }
        const nextId = this.nextAfter(leftPlayerId);
        this.currentPlayerId = nextId;
    }
    settleBets(store) {
        if (this.betsSettled)
            return;
        if (this.phase !== "finished")
            return;
        this.betsSettled = true;
        // Determine winners/ties from the final room state.
        const alive = this.alive();
        if (alive.length === 0) {
            // Everyone busted -> no change, refund all bets.
            for (const p of this.players) {
                if (p.bet > 0) {
                    const r = store.addChips(p.userId, p.bet);
                    if (r.ok)
                        p.chips = r.chips;
                    p.bet = 0;
                }
            }
            return;
        }
        if (alive.length === 1) {
            const w = alive[0];
            // Winner gets profit equal to their bet => they receive 2*bet back (stake + winnings).
            const prize = w.bet * 2;
            if (prize > 0) {
                const r = store.addChips(w.userId, prize);
                if (r.ok)
                    w.chips = r.chips;
            }
            w.bet = 0;
            // Losers already paid by staking their bet (no refund).
            for (const p of this.players) {
                if (p.id !== w.id)
                    p.bet = 0;
            }
            return;
        }
        const scores = alive.map((p) => ({ p, v: handValue(p.hand) }));
        const best = Math.max(...scores.map((s) => s.v));
        const top = scores.filter((s) => s.v === best).map((s) => s.p);
        if (top.length >= 2) {
            // Tie -> top players get their chips back (no change).
            for (const p of top) {
                if (p.bet > 0) {
                    const r = store.addChips(p.userId, p.bet);
                    if (r.ok)
                        p.chips = r.chips;
                }
                p.bet = 0;
            }
            // Others lose their bet (already staked).
            for (const p of this.players) {
                if (!top.some((t) => t.id === p.id))
                    p.bet = 0;
            }
            return;
        }
        // Single winner in multi-alive case.
        const w = top[0];
        const prize = w.bet * 2;
        if (prize > 0) {
            const r = store.addChips(w.userId, prize);
            if (r.ok)
                w.chips = r.chips;
        }
        w.bet = 0;
        for (const p of this.players) {
            if (p.id !== w.id)
                p.bet = 0;
        }
    }
    maybeResolveInstantWin(store) {
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
    finishByStanding(store) {
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
        }
        else {
            this.outcomeMessage = `${top[0].p.name} wins with ${best}.`;
        }
        this.settleBets(store);
    }
    applyDisconnectMidGame(leftPlayerId, store) {
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
            }
            else {
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
        if (this.phase !== "playing")
            return;
        if (this.stillDeciding().length === 0) {
            this.finishByStanding(store);
        }
    }
}
