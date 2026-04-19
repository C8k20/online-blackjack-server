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
    constructor(code) {
        this.code = code;
    }
    addPlayer(socketId, name) {
        const p = {
            id: randomUUID(),
            socketId,
            name: name.trim().slice(0, 24) || "Player",
            hand: [],
            bust: false,
            stood: false,
        };
        this.players.push(p);
        return p;
    }
    removePlayerBySocket(socketId) {
        const idx = this.players.findIndex((p) => p.socketId === socketId);
        if (idx === -1)
            return undefined;
        const [removed] = this.players.splice(idx, 1);
        if (this.hostPlayerId === removed.id && this.players.length > 0) {
            this.hostPlayerId = this.players[0].id;
        }
        if (this.phase === "playing") {
            this.applyDisconnectMidGame(removed.id);
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
            hand: [...p.hand],
            concealedCount: 0,
            bust: p.bust,
            stood: p.stood,
            handValue: p.bust ? null : handValue(p.hand),
        };
    }
    startGame(socketId) {
        if (!this.isHostSocket(socketId)) {
            return { ok: false, error: "Only the host can start the game." };
        }
        if (this.players.length < 2) {
            return { ok: false, error: "Need at least two players to start." };
        }
        if (this.phase === "playing") {
            return { ok: false, error: "A game is already in progress." };
        }
        this.resetRoundState();
        this.phase = "playing";
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
        this.maybeResolveInstantWin();
        return { ok: true };
    }
    nextGame(socketId) {
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
        return this.startGame(socketId);
    }
    hit(socketId) {
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
            this.afterPlayerLeavesTurn(p.id);
        }
        return { ok: true };
    }
    stand(socketId) {
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
        this.afterPlayerLeavesTurn(p.id);
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
    afterPlayerLeavesTurn(leftPlayerId) {
        this.maybeResolveInstantWin();
        if (this.phase !== "playing")
            return;
        const deciding = this.stillDeciding();
        if (deciding.length === 0) {
            this.finishByStanding();
            return;
        }
        const nextId = this.nextAfter(leftPlayerId);
        this.currentPlayerId = nextId;
    }
    maybeResolveInstantWin() {
        const alive = this.alive();
        if (alive.length === 0) {
            this.phase = "finished";
            this.outcomeMessage = "Everyone busted. No winner.";
            this.currentPlayerId = null;
            return;
        }
        if (alive.length === 1) {
            const w = alive[0];
            this.phase = "finished";
            this.outcomeMessage = `${w.name} wins — last player standing (${handValue(w.hand)}).`;
            this.currentPlayerId = null;
        }
    }
    finishByStanding() {
        const alive = this.alive();
        if (alive.length === 0) {
            this.phase = "finished";
            this.outcomeMessage = "No winner.";
            this.currentPlayerId = null;
            return;
        }
        if (alive.length === 1) {
            const w = alive[0];
            this.phase = "finished";
            this.outcomeMessage = `${w.name} wins (${handValue(w.hand)}).`;
            this.currentPlayerId = null;
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
    }
    applyDisconnectMidGame(leftPlayerId) {
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
            return;
        }
        if (this.currentPlayerId === leftPlayerId) {
            const next = this.firstStillDecidingId();
            this.currentPlayerId = next;
        }
        this.maybeResolveInstantWin();
        if (this.phase !== "playing")
            return;
        if (this.stillDeciding().length === 0) {
            this.finishByStanding();
        }
    }
}
