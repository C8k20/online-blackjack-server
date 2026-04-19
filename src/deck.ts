const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = ["C", "D", "H", "S"] as const;

export function createDeck(): string[] {
  const deck: string[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankValue(rank: string): number {
  if (rank === "A") return 11;
  if (rank === "K" || rank === "Q" || rank === "J") return 10;
  return Number(rank);
}

export function parseRank(cardId: string): string | null {
  const m = cardId.match(/^(10|[A2-9JQK])([CDHS])$/);
  return m ? m[1] : null;
}

export function handValue(cards: string[]): number {
  let total = 0;
  let aces = 0;
  for (const id of cards) {
    const rank = parseRank(id);
    if (!rank) continue;
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else {
      total += rankValue(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}
