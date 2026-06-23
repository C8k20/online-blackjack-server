/**
 * Keep in sync with online-blackjack/lib/socket-protocol.ts (duplicated on purpose).
 */

import type { RankInfo } from "./ranking.js";

export type GamePhase = "lobby" | "playing" | "finished";

export type RankChangeSnapshot = {
  playerId: string;
  delta: number;
  rankPoints: number;
  rank: RankInfo;
};

export type PlayerSnapshot = {
  id: string;
  name: string;
  chips: number;
  bet: number;
  /** Face-up card ids for this viewer; empty when this player’s hand is hidden. */
  hand: string[];
  /** Number of face-down cards when `hand` is hidden (opponents during play). */
  concealedCount: number;
  bust: boolean;
  stood: boolean;
  handValue: number | null;
  rank: RankInfo;
};

export type RoomSnapshot = {
  code: string;
  hostPlayerId: string;
  phase: GamePhase;
  players: PlayerSnapshot[];
  currentPlayerId: string | null;
  outcomeMessage: string;
  deckRemaining: number;
  rankChanges: RankChangeSnapshot[];
};
