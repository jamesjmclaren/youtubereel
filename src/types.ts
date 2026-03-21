export interface CardData {
  rank: number;
  name: string;
  number: string;
  setName: string;
  rarity: string;
  type: string;
  price: number;
  dollarChange: number;
  percentChange: number;
  tcgPlayerUrl: string;
  imageUrl?: string;
  /** Currency symbol for display (default "$") */
  currency?: string;
  /** 7-day sales volume */
  salesVolume7d?: number;
  /** 30-day sales volume */
  salesVolume30d?: number;
}

/** Controls what data is shown on each slide */
export type SlideDisplayMode =
  | "price-and-percent"   // Videos 1 & 4: price + % gain only
  | "sales-7d"            // Video 2: price + 7-day sales count
  | "sales-30d";          // Video 3: price + 30-day sales count

export interface PipelineConfig {
  period: "24h" | "7d" | "30d" | "90d";
  priceFilter: string;
  topN: number;
  outputDir: string;
  direction: "gainers" | "losers";
}

export interface ContentPreset {
  name: string;
  title: string;
  subtitle: string;
  direction: "gainers" | "losers";
  period: PipelineConfig["period"];
  priceFilter: string;
  topN: number;
  theme: string;
  /** When set, scrape this set's page instead of the global top-gainers/losers */
  setSlug?: string;
  /** Rarity filter for set-based presets (applied client-side) */
  rarityFilter?: string[];
  /** Data source: "tcgmarketnews" (default) or "pokepulse" */
  source?: "tcgmarketnews" | "pokepulse";
  /** Force slideshow mode (one card at a time) instead of 50/50 random */
  forceSlideshow?: boolean;
  /** PokePulse report name to scrape (matched against report titles on the /market page) */
  pokepulseReport?: string;
  /** Controls what data is shown on each slide */
  displayMode?: SlideDisplayMode;
}

/** Market trend data scraped from PokePulse */
export interface MarketTrend {
  /** e.g. "overall", set name, or card category */
  category: string;
  /** Direction of the trend */
  direction: "up" | "down" | "flat";
  /** Percentage change (e.g. 5.2 means +5.2%) */
  changePct: number;
  /** Human-readable summary (e.g. "Market up 5.2% this week") */
  summary: string;
  /** Volume or number of cards tracked, if available */
  volume?: number;
  /** Time period the trend covers */
  period?: string;
  /** Top trending card names, if listed */
  trendingCards?: string[];
}
