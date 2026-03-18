import type { ContentPreset } from "./types.js";
import { discoverLatestSets } from "./scraper.js";

export const CONTENT_PRESETS: ContentPreset[] = [
  {
    name: "weekly-movers-premium",
    title: "WEEKLY WINNERS",
    subtitle: "Cards skyrocketing this week",
    direction: "gainers",
    period: "7d",
    priceFilter: "over_100",
    topN: 5,
    theme: "indigo",
  },
  {
    name: "monthly-movers-premium",
    title: "MONTHLY SURGE",
    subtitle: "Biggest gains this month",
    direction: "gainers",
    period: "30d",
    priceFilter: "over_100",
    topN: 5,
    theme: "indigo",
  },
  {
    name: "weekly-biggest-drops",
    title: "PRICE CRASH",
    subtitle: "Biggest losers this week",
    direction: "losers",
    period: "7d",
    priceFilter: "over_100",
    topN: 5,
    theme: "crimson",
  },
  {
    name: "budget-movers",
    title: "BUDGET GEMS",
    subtitle: "Sleeper picks heating up",
    direction: "gainers",
    period: "7d",
    priceFilter: "5_25",
    topN: 5,
    theme: "emerald",
  },
  {
    name: "daily-hot",
    title: "ON FIRE TODAY",
    subtitle: "Cards exploding right now",
    direction: "gainers",
    period: "24h",
    priceFilter: "over_100",
    topN: 5,
    theme: "amber",
  },
  {
    name: "monthly-drops",
    title: "MONTHLY DROPS",
    subtitle: "Cards tanking this month",
    direction: "losers",
    period: "30d",
    priceFilter: "over_100",
    topN: 5,
    theme: "crimson",
  },
  {
    name: "weekly-movers-all",
    title: "TOP 10 MOVERS",
    subtitle: "Biggest gains across all prices",
    direction: "gainers",
    period: "7d",
    priceFilter: "",
    topN: 10,
    theme: "indigo",
  },
];

const SET_THEMES = ["indigo", "emerald", "amber", "crimson"];

/**
 * Dynamically build presets for the latest N sets by discovering them from
 * tcgmarketnews.com. Filters to high-tier rarities (IR, SIR, UR, DR).
 */
export async function buildSetPresets(count = 2): Promise<ContentPreset[]> {
  const sets = await discoverLatestSets(count);
  return sets.map((set, i) => ({
    name: `set-${set.slug}`,
    title: `${set.name.toUpperCase()}`,
    subtitle: `Hottest cards right now`,
    direction: "gainers" as const,
    period: "24h" as const,
    priceFilter: "",
    topN: 5,
    theme: SET_THEMES[i % SET_THEMES.length],
    setSlug: set.slug,
    rarityFilter: [
      "Illustration Rare",
      "Special Illustration Rare",
      "Ultra Rare",
    ],
  }));
}

/**
 * Get today's preset from the full rotation (static + dynamic set presets).
 */
export async function getPresetForTodayWithSets(): Promise<ContentPreset> {
  const setPresets = await buildSetPresets(2);
  const allPresets = [...CONTENT_PRESETS, ...setPresets];
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return allPresets[dayOfYear % allPresets.length];
}

export function getPresetForToday(): ContentPreset {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return CONTENT_PRESETS[dayOfYear % CONTENT_PRESETS.length];
}
