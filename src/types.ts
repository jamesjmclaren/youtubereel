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
}

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
}
