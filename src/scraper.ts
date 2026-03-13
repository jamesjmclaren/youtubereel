import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import type { CardData, PipelineConfig } from "./types.js";

const PERIOD_MAP: Record<PipelineConfig["period"], string> = {
  "24h": "1d",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

export async function scrapeTopCards(
  config: Pick<PipelineConfig, "period" | "priceFilter" | "topN" | "direction">
): Promise<CardData[]> {
  const period = PERIOD_MAP[config.period];
  const direction = config.direction ?? "gainers";
  const slug = direction === "losers" ? "top-losers" : "top-gainers";
  const url = `https://www.tcgmarketnews.com/pokemon/${slug}/${period}?price_filter=${config.priceFilter}&sealed_filter=singles_only`;

  console.log(`[scraper] Fetching: ${url}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Use domcontentloaded (faster) then wait for JS to render cards
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 5_000;
          console.warn(`[scraper] Navigation failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }

    // Wait for card elements to render after JS executes
    const CARD_SELECTOR = ".gainer-card, .loser-card, .mover-card, [data-product-id-card]";
    try {
      await page.waitForSelector(CARD_SELECTOR, { timeout: 30_000 });
    } catch {
      // Try waiting for networkidle as a fallback (page may still be loading data)
      console.warn("[scraper] Cards not found yet, waiting for network to settle...");
      try {
        await page.waitForNetworkIdle({ timeout: 15_000 });
        await page.waitForSelector(CARD_SELECTOR, { timeout: 10_000 });
      } catch {
        const bodyText = await page.evaluate(() =>
          document.body.innerText.slice(0, 500)
        );
        console.warn(`[scraper] No card elements found after waiting. Page preview: ${bodyText}`);
      }
    }

    // Extract card data from the rendered page
    const cards = await page.evaluate((opts) => {
      const { topN, direction } = opts;
      const results: Array<{
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
      }> = [];

      // Try multiple selectors for card elements
      const cardEls = document.querySelectorAll(
        ".gainer-card, .loser-card, .mover-card, [data-product-id-card]"
      );

      // Also parse JSON-LD if available
      type JsonLdItem = {
        item: {
          name?: string;
          image?: string;
          offers?: { url?: string };
          additionalProperty?: { value?: string };
        };
      };
      let jsonLdItems: JsonLdItem[] = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
        try {
          const data = JSON.parse(el.textContent || "");
          if (data["@type"] === "ItemList" && Array.isArray(data.itemListElement)) {
            jsonLdItems = data.itemListElement;
          }
        } catch { /* skip */ }
      });

      const limit = Math.min(topN, cardEls.length);
      for (let i = 0; i < limit; i++) {
        const el = cardEls[i] as HTMLElement;
        const productId = el.getAttribute("data-product-id-card") || "";
        const subType = el.getAttribute("data-sub-type") || "Holofoil";
        const price = parseFloat(el.getAttribute("data-current-price") || "0");
        const changeAmount = parseFloat(el.getAttribute("data-price-change-amount") || "0");
        const changePct = parseFloat(el.getAttribute("data-price-change-percentage") || "0");

        const setName = el.querySelector(".group-link")?.textContent?.trim() || "";
        const badges = el.querySelectorAll(".card-details-badge span");
        const cardNumber = badges.length > 1 ? (badges[1]?.textContent?.trim() || "") : "";

        const jsonLdItem = jsonLdItems[i]?.item;
        const fullName = jsonLdItem?.name || `Card #${productId}`;
        const nameParts = fullName.split(" - ");
        const cardName = nameParts[0].trim();
        const number = cardNumber || nameParts[1]?.trim() || "";
        const imageUrl = jsonLdItem?.image?.replace("_200w", "_400w");
        const rarity = jsonLdItem?.additionalProperty?.value || "";
        const tcgPlayerUrl = jsonLdItem?.offers?.url || "";

        results.push({
          rank: i + 1,
          name: cardName,
          number,
          setName,
          rarity,
          type: subType,
          price,
          dollarChange: direction === "losers" ? -Math.abs(changeAmount) : changeAmount,
          percentChange: direction === "losers" ? -Math.abs(changePct) : changePct,
          tcgPlayerUrl,
          imageUrl,
        });
      }

      return results;
    }, { topN: config.topN, direction });

    console.log(`[scraper] Found ${cards.length} cards`);
    return cards;
  } finally {
    await browser.close();
  }
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
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
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
