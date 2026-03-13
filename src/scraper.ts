import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import type { CardData, PipelineConfig } from "./types.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PERIOD_MAP: Record<PipelineConfig["period"], string> = {
  "24h": "1d",
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
  const slug = direction === "losers" ? "top-losers" : "top-gainers";
  const url = `https://www.tcgmarketnews.com/pokemon/${slug}/${period}?price_filter=${config.priceFilter}&sealed_filter=singles_only`;

  console.log(`[scraper] Fetching: ${url}`);

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`Failed to fetch TCG Market News: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // 1. Parse JSON-LD for card metadata (names, images, rarity, TCGPlayer URLs)
  let jsonLdItems: JsonLdItem[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const jsonLd = JSON.parse($(el).text());
      if (jsonLd["@type"] === "ItemList" && Array.isArray(jsonLd.itemListElement)) {
        jsonLdItems = jsonLd.itemListElement;
      }
    } catch {
      // skip non-matching JSON-LD blocks
    }
  });
  if (jsonLdItems.length === 0) {
    console.warn("[scraper] No ItemList found in JSON-LD");
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

  // Try multiple selectors: class-based (legacy) and data-attribute-based (resilient)
  const cardEls = $(".gainer-card, .loser-card, .mover-card, [data-product-id-card]");
  console.log(`[scraper] Found ${cardEls.length} card elements in HTML`);

  if (cardEls.length === 0) {
    // Dump page structure for debugging
    const bodyText = $("body").text().slice(0, 500).replace(/\s+/g, " ").trim();
    console.warn(`[scraper] Page body preview: ${bodyText}`);
  }

  cardEls.each((_, el) => {
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

    const name = jsonLdItem?.name || `Card #${htmlCard.productId}`;
    const nameParts = name.split(" - ");
    const cardName = nameParts[0].trim();
    const number = htmlCard.cardNumber || nameParts[1]?.trim() || "";

    // Get higher-res image from TCGPlayer CDN (replace _200w with _400w)
    const imageUrl = jsonLdItem?.image?.replace("_200w", "_400w");
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
      dollarChange: direction === "losers" ? -Math.abs(htmlCard.changeAmount) : htmlCard.changeAmount,
      percentChange: direction === "losers" ? -Math.abs(htmlCard.changePct) : htmlCard.changePct,
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

    try {
      console.log(`[scraper] Downloading image for: ${card.name}`);
      const imgRes = await fetch(card.imageUrl, {
        headers: { "User-Agent": UA },
      });

      if (imgRes.ok) {
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const imgPath = path.join(outputDir, `card-${card.rank}.jpg`);
        await writeFile(imgPath, buffer);
        results.push({ ...card, imageUrl: imgPath });
        console.log(`[scraper] Saved image for ${card.name}`);
      } else {
        console.warn(`[scraper] Failed to download image for ${card.name}: ${imgRes.status}`);
        results.push(card);
      }
    } catch (err) {
      console.warn(`[scraper] Error downloading image for ${card.name}:`, err);
      results.push(card);
    }

    // Small delay between requests
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

export const scrapeTopGainers = (
  config: Pick<PipelineConfig, "period" | "priceFilter" | "topN">
) => scrapeTopCards({ ...config, direction: "gainers" });

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
