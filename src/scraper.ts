import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { chromium, type Browser } from "playwright";
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
 * Try downloading a single image via direct fetch with browser-like headers.
 * Returns the saved path on success, or null on failure.
 */
async function fetchImageDirect(
  card: CardData,
  imgPath: string
): Promise<string | null> {
  const urlsToTry = [card.imageUrl!];
  if (card.imageUrl!.includes("_400w")) {
    urlsToTry.push(card.imageUrl!.replace("_400w", "_200w"));
  }

  for (const url of urlsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 600));
        const imgRes = await fetch(url, { headers: BROWSER_HEADERS });
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          await writeFile(imgPath, buffer);
          console.log(`[scraper] Saved image for ${card.name} via fetch (${url})`);
          return imgPath;
        }
        console.warn(`[scraper] HTTP ${imgRes.status} for ${card.name} — ${url}`);
      } catch (err) {
        console.warn(`[scraper] Fetch error for ${card.name} (${url}):`, (err as Error).message);
      }
    }
  }
  return null;
}

/**
 * Download images that failed direct fetch using a real Playwright browser.
 * Opens a single browser, navigates to each image URL, and saves the response.
 */
async function fetchImagesWithBrowser(
  failedCards: Array<{ card: CardData; imgPath: string }>,
): Promise<Map<number, string>> {
  const saved = new Map<number, string>();
  let browser: Browser | undefined;

  try {
    console.log(`[scraper] Launching browser to fetch ${failedCards.length} image(s)…`);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Visit TCGPlayer first to pick up any required cookies / JS tokens
    const warmupPage = await context.newPage();
    try {
      await warmupPage.goto("https://www.tcgplayer.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      console.warn("[scraper] TCGPlayer warmup page timed out — continuing anyway");
    }
    await warmupPage.close();

    for (const { card, imgPath } of failedCards) {
      const urlsToTry = [card.imageUrl!];
      if (card.imageUrl!.includes("_400w")) {
        urlsToTry.push(card.imageUrl!.replace("_400w", "_200w"));
      }

      let success = false;
      for (const url of urlsToTry) {
        try {
          const page = await context.newPage();
          const response = await page.goto(url, {
            waitUntil: "load",
            timeout: 15_000,
          });

          if (response && response.ok()) {
            const buffer = await response.body();
            await writeFile(imgPath, buffer);
            console.log(`[scraper] Saved image for ${card.name} via browser (${url})`);
            saved.set(card.rank, imgPath);
            success = true;
          } else {
            console.warn(
              `[scraper] Browser HTTP ${response?.status()} for ${card.name} — ${url}`
            );
          }
          await page.close();
          if (success) break;
        } catch (err) {
          console.warn(
            `[scraper] Browser error for ${card.name} (${url}):`,
            (err as Error).message
          );
        }
      }

      // Small delay between requests
      await new Promise((r) => setTimeout(r, 300));
    }

    await context.close();
  } catch (err) {
    console.error("[scraper] Failed to launch browser:", (err as Error).message);
  } finally {
    await browser?.close();
  }

  return saved;
}

/**
 * Download card images locally for use in image generation.
 * Tries direct fetch first, then falls back to Playwright browser for failures.
 */
export async function downloadCardImages(
  cards: CardData[],
  outputDir: string
): Promise<CardData[]> {
  await mkdir(outputDir, { recursive: true });

  const results: CardData[] = [];
  const failedCards: Array<{ card: CardData; imgPath: string }> = [];

  // Phase 1: Try direct fetch for all cards
  for (const card of cards) {
    if (!card.imageUrl) {
      console.warn(`[scraper] No image URL for ${card.name}`);
      results.push(card);
      continue;
    }

    const imgPath = path.join(outputDir, `card-${card.rank}.jpg`);
    const savedPath = await fetchImageDirect(card, imgPath);

    if (savedPath) {
      results.push({ ...card, imageUrl: savedPath });
    } else {
      // Mark for browser fallback
      failedCards.push({ card, imgPath });
      results.push(card); // placeholder — will be updated if browser succeeds
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Phase 2: Use Playwright browser for any that failed
  if (failedCards.length > 0) {
    console.warn(
      `[scraper] ${failedCards.length} image(s) failed direct fetch — trying browser fallback`
    );
    const browserResults = await fetchImagesWithBrowser(failedCards);

    // Update results for cards that the browser saved successfully
    for (let i = 0; i < results.length; i++) {
      const saved = browserResults.get(results[i].rank);
      if (saved) {
        results[i] = { ...results[i], imageUrl: saved };
      }
    }
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

/** Broader rarities to fall back on when high-tier filter yields too few cards */
const FALLBACK_RARITIES = new Set([
  "Illustration Rare",
  "Special Illustration Rare",
  "Ultra Rare",
  "Double Rare",
  "Hyper Rare",
  "ACE SPEC Rare",
  "Rare",
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

  const primaryRarities = config.rarityFilter
    ? new Set(config.rarityFilter)
    : HIGH_TIER_RARITIES;

  // Parse all cards from the page once, then filter by rarity
  interface ParsedCard {
    rarity: string;
    productId: string;
    subType: string;
    price: number;
    changeAmount: number;
    changePct: number;
    cardNumber: string;
    setName: string;
    cardName: string;
    number: string;
    imageUrl: string | undefined;
    tcgPlayerUrl: string;
  }

  const allParsed: ParsedCard[] = [];

  $(".gainer-card").each((i, el) => {
    const $el = $(el);
    const badges = $el.find(".card-details-badge span");
    const rarity = badges.length > 0 ? $(badges[0]).text().trim() : "";

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

    allParsed.push({
      rarity, productId, subType, price, changeAmount, changePct,
      cardNumber, setName, cardName, number, imageUrl, tcgPlayerUrl,
    });
  });

  // Filter by primary rarities first; if too few, widen to fallback rarities
  let filtered = allParsed.filter((c) => primaryRarities.has(c.rarity));
  if (filtered.length < config.topN) {
    console.warn(
      `[scraper] Only ${filtered.length} high-tier cards found — widening rarity filter`
    );
    filtered = allParsed.filter((c) => FALLBACK_RARITIES.has(c.rarity));
  }
  // If still too few, use all cards from the page
  if (filtered.length < config.topN) {
    console.warn(
      `[scraper] Still only ${filtered.length} cards — using all rarities`
    );
    filtered = allParsed;
  }

  const cards: CardData[] = filtered.slice(0, config.topN).map((c, i) => ({
    rank: i + 1,
    name: c.cardName,
    number: c.number,
    setName: c.setName,
    rarity: c.rarity,
    type: c.subType,
    price: c.price,
    dollarChange: c.changeAmount,
    percentChange: c.changePct,
    tcgPlayerUrl: c.tcgPlayerUrl,
    imageUrl: c.imageUrl,
  }));

  console.log(
    `[scraper] Found ${cards.length} cards in ${config.setSlug} (rarities: ${[...new Set(cards.map((c) => c.rarity))].join(", ")})`
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
