import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import type { CardData, PipelineConfig } from "./types.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Browser-like headers to avoid 403s from CDNs (CloudFront, etc.) */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  Referer: "https://www.tcgplayer.com/",
};

const PERIOD_MAP: Record<PipelineConfig["period"], string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

interface JsonLdItem {
  "@type": "ListItem";
  position: number;
  item: {
    "@type": "Product";
    name: string;
    image?: string;
    offers?: {
      price: string;
      url: string;
    };
    additionalProperty?: {
      name: string;
      value: string;
    };
  };
}

interface JsonLdData {
  "@type": "ItemList";
  itemListElement: JsonLdItem[];
}

export async function scrapeTopCards(
  config: Pick<PipelineConfig, "period" | "priceFilter" | "topN" | "direction">
): Promise<CardData[]> {
  const period = PERIOD_MAP[config.period];
  const direction = config.direction ?? "gainers";
  // Curated "top-losers" is often empty; "all-losers" has data
  const slug = direction === "losers" ? "all-losers" : "top-gainers";
  const url = `https://www.tcgmarketnews.com/pokemon/${slug}/${period}?price_filter=${config.priceFilter}&sealed_filter=singles_only`;

  console.log(`[scraper] Fetching: ${url}`);

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`Failed to fetch TCG Market News: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // 1. Parse JSON-LD for card metadata (names, images, rarity, TCGPlayer URLs)
  const jsonLdScript = $('script[type="application/ld+json"]').text();
  let jsonLdItems: JsonLdItem[] = [];
  try {
    const jsonLd = JSON.parse(jsonLdScript) as JsonLdData;
    jsonLdItems = jsonLd.itemListElement || [];
  } catch {
    console.warn("[scraper] Failed to parse JSON-LD");
  }

  // 2. Parse HTML data attributes for price change data
  const htmlCards: Array<{
    productId: string;
    subType: string;
    price: number;
    changeAmount: number;
    changePct: number;
    setName: string;
    cardNumber: string;
  }> = [];

  $(".gainer-card").each((_, el) => {
    const $el = $(el);
    const productId = $el.attr("data-product-id-card") || "";
    const subType = $el.attr("data-sub-type") || "Holofoil";
    const price = parseFloat($el.attr("data-current-price") || "0");
    const changeAmount = parseFloat($el.attr("data-price-change-amount") || "0");
    const changePct = parseFloat($el.attr("data-price-change-percentage") || "0");

    // Extract set name from the group-link inside this card
    const setName = $el.find(".group-link").text().trim();
    // Extract card number from the details badge
    const badges = $el.find(".card-details-badge span");
    const cardNumber = badges.length > 1 ? $(badges[1]).text().trim() : "";

    htmlCards.push({ productId, subType, price, changeAmount, changePct, setName, cardNumber });
  });

  // 3. Merge JSON-LD + HTML data, taking the top N
  const cards: CardData[] = [];

  for (let i = 0; i < Math.min(config.topN, htmlCards.length); i++) {
    const htmlCard = htmlCards[i];
    const jsonLdItem = jsonLdItems[i]?.item;

    const rawName = jsonLdItem?.name || `Card #${htmlCard.productId}`;
    // Decode HTML entities (e.g. &#39; → ')
    const name = $("<div>").html(rawName).text();
    const nameParts = name.split(" - ");
    const cardName = nameParts[0].trim();
    const number = htmlCard.cardNumber || nameParts[1]?.trim() || "";

    // Image: prefer JSON-LD (works when present), else construct from productId.
    // TCGPlayer CDN pattern: tcgplayer-cdn.tcgplayer.com/product/{id}_200w.jpg
    const imageUrl =
      jsonLdItem?.image?.replace("_200w", "_400w") ||
      (htmlCard.productId
        ? `https://tcgplayer-cdn.tcgplayer.com/product/${htmlCard.productId}_200w.jpg`
        : undefined);
    const rarity = jsonLdItem?.additionalProperty?.value || "";
    const tcgPlayerUrl = jsonLdItem?.offers?.url || "";

    cards.push({
      rank: i + 1,
      name: cardName,
      number,
      setName: htmlCard.setName,
      rarity,
      type: htmlCard.subType,
      price: htmlCard.price,
      dollarChange: htmlCard.changeAmount,
      percentChange: htmlCard.changePct,
      tcgPlayerUrl,
      imageUrl,
    });
  }

  console.log(`[scraper] Found ${cards.length} cards`);
  return cards;
}

/**
 * Download card images locally for use in image generation.
 */
export async function downloadCardImages(
  cards: CardData[],
  outputDir: string
): Promise<CardData[]> {
  await mkdir(outputDir, { recursive: true });

  const results: CardData[] = [];

  for (const card of cards) {
    if (!card.imageUrl) {
      console.warn(`[scraper] No image URL for ${card.name}`);
      results.push(card);
      continue;
    }

    const imgPath = path.join(outputDir, `card-${card.rank}.jpg`);
    let downloaded = false;

    // Try the URL as-is, then fall back to _200w if _400w returns non-200
    const urlsToTry = [card.imageUrl];
    if (card.imageUrl.includes("_400w")) {
      urlsToTry.push(card.imageUrl.replace("_400w", "_200w"));
    }

    outer: for (const url of urlsToTry) {
      for (let attempt = 1; attempt <= 2 && !downloaded; attempt++) {
        try {
          if (attempt > 1) await new Promise((r) => setTimeout(r, 600));
          const imgRes = await fetch(url, { headers: BROWSER_HEADERS });
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            await writeFile(imgPath, buffer);
            results.push({ ...card, imageUrl: imgPath });
            console.log(`[scraper] Saved image for ${card.name} (${url})`);
            downloaded = true;
            break outer;
          } else {
            console.warn(`[scraper] HTTP ${imgRes.status} for ${card.name} — ${url}`);
          }
        } catch (err) {
          console.warn(`[scraper] Fetch error for ${card.name} (${url}):`, (err as Error).message);
        }
      }
    }

    if (!downloaded) {
      console.warn(`[scraper] All attempts failed for ${card.name}, using URL fallback`);
      results.push(card); // keep HTTP URL so canvas can try loading it directly
    }

    // Small delay between cards
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

export const scrapeTopGainers = (
  config: Pick<PipelineConfig, "period" | "priceFilter" | "topN">
) => scrapeTopCards({ ...config, direction: "gainers" });

/**
 * Discover the latest N Pokémon TCG sets from tcgmarketnews.com.
 * Skips promo, energy, and trainer-only sets (they rarely have high-tier cards).
 */
export async function discoverLatestSets(
  count: number
): Promise<Array<{ name: string; slug: string; date: string }>> {
  const url = "https://www.tcgmarketnews.com/pokemon/sets";
  console.log(`[scraper] Fetching sets list: ${url}`);

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`Failed to fetch sets: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const SKIP_PATTERNS = /promo|energies|first partner|trainer|collection|league|championship/i;
  const sets: Array<{ name: string; slug: string; date: string }> = [];

  $("a[href^='/set/']").each((_, el) => {
    if (sets.length >= count) return;
    const $el = $(el);
    const href = $el.attr("href") || "";
    const slug = href.replace("/set/", "");
    const name =
      $el.find(".set-item-name").text().trim() || $el.text().trim();
    const date = $el.find(".set-item-date").text().trim();
    if (!slug || !name || SKIP_PATTERNS.test(name)) return;
    sets.push({ name, slug, date });
  });

  console.log(
    `[scraper] Latest ${sets.length} sets: ${sets.map((s) => s.name).join(", ")}`
  );
  return sets;
}

const SET_PERIOD_MAP: Record<string, string> = {
  "24h": "1",
  "7d": "7",
  "30d": "30",
  "90d": "90",
};

const HIGH_TIER_RARITIES = new Set([
  "Illustration Rare",
  "Special Illustration Rare",
  "Ultra Rare",
]);

/**
 * Scrape top movers from a specific set's page, filtered by rarity.
 */
export async function scrapeSetCards(config: {
  setSlug: string;
  period: string;
  topN: number;
  rarityFilter?: string[];
}): Promise<CardData[]> {
  const period = SET_PERIOD_MAP[config.period] || config.period;
  const url = `https://www.tcgmarketnews.com/set/${config.setSlug}?period=${period}&sort=percent_change`;

  console.log(`[scraper] Fetching set: ${url}`);

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`Failed to fetch set page: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  // JSON-LD has image/name/tcgPlayerUrl (limited to 20 items)
  let jsonLdItems: JsonLdItem[] = [];
  try {
    const jsonLd = JSON.parse(
      $('script[type="application/ld+json"]').text()
    ) as JsonLdData;
    jsonLdItems = jsonLd.itemListElement || [];
  } catch {}

  const allowedRarities = config.rarityFilter
    ? new Set(config.rarityFilter)
    : HIGH_TIER_RARITIES;

  const cards: CardData[] = [];

  $(".gainer-card").each((i, el) => {
    if (cards.length >= config.topN) return;

    const $el = $(el);
    const badges = $el.find(".card-details-badge span");
    const rarity = badges.length > 0 ? $(badges[0]).text().trim() : "";

    if (!allowedRarities.has(rarity)) return;

    const productId = $el.attr("data-product-id-card") || "";
    const subType = $el.attr("data-sub-type") || "Holofoil";
    const price = parseFloat($el.attr("data-current-price") || "0");
    const changeAmount = parseFloat(
      $el.attr("data-price-change-amount") || "0"
    );
    const changePct = parseFloat(
      $el.attr("data-price-change-percentage") || "0"
    );
    const cardNumber = badges.length > 1 ? $(badges[1]).text().trim() : "";
    const setName = $el.find(".group-link").text().trim();

    // Prefer .card-name from HTML (always present), fall back to JSON-LD
    const jsonLdItem = jsonLdItems[i]?.item;
    const htmlName = $el.find(".card-name").text().trim() || $el.find("h3").text().trim();
    const rawName = htmlName || jsonLdItem?.name || `Card #${productId}`;
    const name = $("<div>").html(rawName).text();
    const nameParts = name.split(" - ");
    const cardName = nameParts[0].trim();
    const number = cardNumber || nameParts[1]?.trim() || "";

    const imageUrl =
      jsonLdItem?.image?.replace("_200w", "_400w") ||
      (productId
        ? `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`
        : undefined);
    const tcgPlayerUrl =
      jsonLdItem?.offers?.url ||
      $el.find("a[href*='tcgplayer.com']").attr("href") ||
      "";

    cards.push({
      rank: cards.length + 1,
      name: cardName,
      number,
      setName,
      rarity,
      type: subType,
      price,
      dollarChange: changeAmount,
      percentChange: changePct,
      tcgPlayerUrl,
      imageUrl,
    });
  });

  console.log(
    `[scraper] Found ${cards.length} high-tier cards in ${config.setSlug}`
  );
  return cards;
}

// CLI entry point
if (process.argv[1]?.includes("scraper")) {
  const config = {
    period: "30d" as const,
    priceFilter: "over_100",
    topN: 5,
    outputDir: "output",
    direction: "gainers" as const,
  };

  const cards = await scrapeTopCards(config);
  console.log("\nScraped cards:");
  console.log(JSON.stringify(cards, null, 2));

  if (cards.length > 0) {
    const withImages = await downloadCardImages(cards, "output/images");
    await mkdir("output", { recursive: true });
    await writeFile("output/cards.json", JSON.stringify(withImages, null, 2));
    console.log("\nSaved to output/cards.json");
  }
}
