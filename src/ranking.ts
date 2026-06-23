/**
 * Competitive rank tiers and Rank Points (RP) calculations.
 * Keep display fields in sync with online-blackjack/lib/ranking.ts.
 */

export type RankTierId =
  | "bronze"
  | "silver"
  | "gold"
  | "diamond"
  | "emerald"
  | "master"
  | "grandmaster"
  | "champion";

export type RankInfo = {
  tierId: RankTierId;
  tierName: string;
  stage: number;
  stageLabel: string;
  rankPoints: number;
  nextThreshold: number | null;
  progressInStage: number;
  color: string;
  shineLevel: number;
  isOpal: boolean;
  isOpalDetailed: boolean;
};

type TierDef = {
  id: RankTierId;
  name: string;
  stages: number[];
  color: string;
  shineLevel: number;
  isOpal: boolean;
  isOpalDetailed: boolean;
};

const TIERS: TierDef[] = [
  { id: "bronze", name: "Bronze", stages: [0, 250, 500], color: "#b87333", shineLevel: 1, isOpal: false, isOpalDetailed: false },
  { id: "silver", name: "Silver", stages: [750, 1000, 1250], color: "#c0c0c0", shineLevel: 2, isOpal: false, isOpalDetailed: false },
  { id: "gold", name: "Gold", stages: [1500, 2000, 2500], color: "#d4af37", shineLevel: 3, isOpal: false, isOpalDetailed: false },
  { id: "diamond", name: "Diamond", stages: [3000, 3750, 4500], color: "#7dd3fc", shineLevel: 4, isOpal: false, isOpalDetailed: false },
  { id: "emerald", name: "Emerald", stages: [5250, 6500, 7750], color: "#86efac", shineLevel: 5, isOpal: false, isOpalDetailed: false },
  { id: "master", name: "Master", stages: [9000, 10250, 11500], color: "#e8d5ff", shineLevel: 6, isOpal: true, isOpalDetailed: false },
  { id: "grandmaster", name: "Grandmaster", stages: [12750, 14500, 16250], color: "#d4f0ff", shineLevel: 7, isOpal: true, isOpalDetailed: true },
  { id: "champion", name: "Champion", stages: [18000], color: "#a855f7", shineLevel: 8, isOpal: false, isOpalDetailed: false },
];

const STAGE_ROMAN = ["I", "II", "III"] as const;

const LOSS_BASE = 5;
const LOSS_MAX = 25;
const WIN_NORMAL = 18;
const WIN_WITH_21 = 30;

function flatThresholds(): { tier: TierDef; stageIndex: number; threshold: number }[] {
  const out: { tier: TierDef; stageIndex: number; threshold: number }[] = [];
  for (const tier of TIERS) {
    tier.stages.forEach((threshold, stageIndex) => {
      out.push({ tier, stageIndex, threshold });
    });
  }
  return out.sort((a, b) => a.threshold - b.threshold);
}

const FLAT = flatThresholds();

export function rankFromPoints(rankPoints: number): RankInfo {
  const rp = Math.max(0, Math.floor(rankPoints));
  let current = FLAT[0]!;
  for (const entry of FLAT) {
    if (rp >= entry.threshold) current = entry;
    else break;
  }
  const currentIdx = FLAT.indexOf(current);
  const next = FLAT[currentIdx + 1] ?? null;
  const stageNum = current.stageIndex + 1;
  const stageRoman = STAGE_ROMAN[current.stageIndex] ?? String(stageNum);
  const stageLabel =
    current.tier.id === "champion"
      ? current.tier.name
      : `${current.tier.name} ${stageRoman}`;

  let progressInStage = 1;
  if (next) {
    const span = next.threshold - current.threshold;
    progressInStage = span > 0 ? Math.min(1, (rp - current.threshold) / span) : 0;
  }

  return {
    tierId: current.tier.id,
    tierName: current.tier.name,
    stage: stageNum,
    stageLabel,
    rankPoints: rp,
    nextThreshold: next?.threshold ?? null,
    progressInStage,
    color: current.tier.color,
    shineLevel: current.tier.shineLevel,
    isOpal: current.tier.isOpal,
    isOpalDetailed: current.tier.isOpalDetailed,
  };
}

export function tierIndexFromPoints(rankPoints: number): number {
  const info = rankFromPoints(rankPoints);
  return TIERS.findIndex((t) => t.id === info.tierId);
}

export function rankLossAmount(rankPoints: number): number {
  const idx = tierIndexFromPoints(rankPoints);
  const t = TIERS.length <= 1 ? 0 : idx / (TIERS.length - 1);
  return Math.min(LOSS_MAX, Math.round(LOSS_BASE + t * (LOSS_MAX - LOSS_BASE)));
}

export function rankWinAmount(handTotal: number): number {
  return handTotal === 21 ? WIN_WITH_21 : WIN_NORMAL;
}
