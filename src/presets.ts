import type { ContentPreset } from "./types.js";
import { discoverLatestSets } from "./scraper.js";

export const CONTENT_PRESETS: ContentPreset[] = [
  {
    name: "weekly-movers-premium",
    title: "Top 5 Movers This Week",
    subtitle: "Premium cards with the biggest gains",
    direction: "gainers",
    period: "7d",
    priceFilter: "over_100",
    topN: 5,
    theme: "indigo",
  },
  {
    name: "monthly-movers-premium",
    title: "Top 5 Movers This Month",
    subtitle: "Premium cards trending up this month",
    direction: "gainers",
    period: "30d",
    priceFilter: "over_100",
    topN: 5,
    theme: "indigo",
  },
  {
    name: "weekly-biggest-drops",
    title: "Top 5 Biggest Drops This Week",
    subtitle: "Cards that lost the most value this week",
    direction: "losers",
    period: "7d",
    priceFilter: "over_100",
    topN: 5,
    theme: "crimson",
  },
  {
    name: "budget-movers",
    title: "Top 5 Budget Movers This Week",
    subtitle: "Affordable cards on the rise",
    direction: "gainers",
    period: "7d",
    priceFilter: "5_25",
    topN: 5,
    theme: "emerald",
  },
  {
    name: "daily-hot",
    title: "Top 5 Hottest Cards Today",
    subtitle: "Today's biggest price surges",
    direction: "gainers",
    period: "24h",
    priceFilter: "over_100",
    topN: 5,
    theme: "amber",
  },
  {
    name: "monthly-drops",
    title: "Top 5 Monthly Drops",
    subtitle: "Cards that fell the most this month",
    direction: "losers",
    period: "30d",
    priceFilter: "over_100",
    topN: 5,
    theme: "crimson",
  },
  {
    name: "weekly-movers-all",
    title: "Top 10 Biggest Movers",
    subtitle: "All price ranges, biggest weekly gains",
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
    title: `${set.name} Top 5 Movers`,
    subtitle: `Hottest high-tier cards right now`,
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
