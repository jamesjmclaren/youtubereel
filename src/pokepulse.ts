import { chromium, type Browser, type Page } from "playwright";
import type { CardData, MarketTrend } from "./types.js";

/**
 * PulseTCG (pokepulse.io) market trends scraper.
 *
 * Authenticates via Playwright and scrapes the homepage + /market
 * for market trend data (top sellers, price movers, volume movers).
 *
 * Credentials are read from environment variables:
 *   POKEPULSE_EMAIL – login email
 *   POKEPULSE_PASSWORD – login password
 */

const BASE_URL = "https://pokepulse.io";

function getCredentials(): { email: string; password: string } {
  const email = process.env.POKEPULSE_EMAIL;
  const password = process.env.POKEPULSE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "PokePulse credentials not set. Set POKEPULSE_EMAIL and POKEPULSE_PASSWORD env vars."
    );
  }
  return { email, password };
}

/**
 * Log in to PulseTCG.
 * The login is a modal/inline form on the homepage — click the Login button,
 * then fill email + password in the sign-in tab.
 */
async function login(page: Page, email: string, password: string): Promise<void> {
  // Go to homepage first
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20_000 });

  // Dismiss cookie consent overlay if present (it blocks clicks on the page)
  try {
    const acceptBtn = page.locator('.cm-btn-accept, button:has-text("Accept"), .cm-overlay button').first();
    if ((await acceptBtn.count()) > 0) {
      await acceptBtn.click({ timeout: 3000 });
      console.log("[pokepulse] Dismissed cookie consent overlay");
      await page.waitForTimeout(500);
    }
  } catch {
    // If no cookie banner or click fails, try removing the overlay via JS
    await page.evaluate(() => {
      document.querySelectorAll('.cm-overlay').forEach((el) => el.remove());
    });
    console.log("[pokepulse] Removed cookie overlay via JS");
  }

  // Click the "Login" button in the header to open the auth modal
  const loginBtn = page.locator('header button:has-text("Login")').first();
  if ((await loginBtn.count()) > 0) {
    await loginBtn.click();
    await page.waitForTimeout(1000);
  }

  // The sign-in form may appear as a modal or a page — look for the email input
  // The form has: input[name="email"][autocomplete="username"] and input[name="password"]
  const emailInput = page.locator(
    'form input[name="email"][type="email"], .app-public-page input[name="email"][type="email"]'
  ).first();

  // Wait for the login form to be visible
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });

  await emailInput.fill(email);

  const passwordInput = page.locator(
    'form input[name="password"][type="password"], .app-public-page input[name="password"][type="password"]'
  ).first();
  await passwordInput.fill(password);

  // Click "Sign in" submit button
  const submitBtn = page.locator(
    'form button[type="submit"]:has-text("Sign in"), .app-public-page button[type="submit"]:has-text("Sign in")'
  ).first();
  await submitBtn.click();

  // Wait for auth to complete — the login form should disappear
  await page.waitForTimeout(3000);

  // Verify login succeeded by checking if login button is gone or user avatar appears
  const stillHasLogin = await page.locator('header button:has-text("Login")').count();
  if (stillHasLogin > 0) {
    console.warn("[pokepulse] Login button still visible — login may have failed");
  } else {
    console.log("[pokepulse] Logged in successfully");
  }
}

/**
 * Parse card data from the homepage card grids.
 * Each card has: name, price (£), % change, trend direction, sold count.
 */
async function parseHomepageCards(page: Page): Promise<MarketTrend[]> {
  const trends: MarketTrend[] = [];

  // Extract data from each section's card grid
  const sections = await page.$$eval("section", (sects) =>
    sects.map((sect) => {
      const title = (sect.querySelector("h3")?.textContent || "").trim();
      const cards = Array.from(sect.querySelectorAll(".group a[href^='/cards/'], .group a[href^='/sealed/']")).map((a) => {
        const name = (a.querySelector("p.text-xs.font-medium, p.truncate")?.textContent || "").trim();
        // Price is in a span with £ sign
        const priceText = Array.from(a.querySelectorAll("span"))
          .find((s) => (s.textContent || "").includes("£"))?.textContent || "";
        const priceMatch = priceText.match(/£([\d,.]+)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(",", "")) : 0;
        // % change
        const pctSpan = a.querySelector(".text-green-600, .text-green-400, .text-red-600, .text-red-400");
        const pctText = pctSpan?.textContent || "0";
        const pctMatch = pctText.match(/([\d.]+)%/);
        const pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
        // Direction from icon class
        const isDown = !!a.querySelector(".lucide-trending-down");
        const changePct = isDown ? -pct : pct;
        // Sold count
        const soldSpan = Array.from(a.querySelectorAll("span"))
          .find((s) => /\d+\s*sold/.test(s.textContent || ""));
        const soldMatch = soldSpan?.textContent?.match(/(\d+)\s*sold/);
        const volume = soldMatch ? parseInt(soldMatch[1]) : undefined;

        return { name, price, changePct, volume };
      }).filter((c) => c.name.length > 0);

      return { title, cards };
    }).filter((s) => s.cards.length > 0)
  );

  for (const section of sections) {
    for (const card of section.cards) {
      trends.push({
        category: card.name,
        direction: card.changePct > 0.5 ? "up" : card.changePct < -0.5 ? "down" : "flat",
        changePct: card.changePct,
        summary: `${card.name}: ${card.changePct >= 0 ? "+" : ""}${card.changePct.toFixed(1)}%`,
        volume: card.volume,
        period: "7d",
      });
    }
  }

  return trends;
}

/**
 * Parse market report cards from the homepage (Card Market Reports / Sealed Product Market Reports).
 * These have report titles with top movers listed inside.
 */
async function parseMarketReports(page: Page): Promise<MarketTrend[]> {
  const trends: MarketTrend[] = [];

  // Market report cards contain items with name + % change
  const reportItems = await page.$$eval(
    '.shadow-sm.border .space-y-0\\.5 > div',
    (items) =>
      items.map((item) => {
        const nameEl = item.querySelector("span.text-xs.truncate, span.text-secondary-foreground");
        const name = (nameEl?.textContent || "").trim();
        const pctEl = item.querySelector(".text-green-600, .text-green-400, .text-red-600, .text-red-400");
        const pctText = pctEl?.textContent || "0";
        const pctMatch = pctText.match(/([\d.]+)%/);
        const pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
        const isDown = !!item.querySelector(".lucide-trending-down");
        const changePct = isDown ? -pct : pct;
        // Sales count (for best sellers)
        const salesMatch = (item.textContent || "").match(/(\d+)\s*sales/);
        const volume = salesMatch ? parseInt(salesMatch[1]) : undefined;

        return { name, changePct, volume };
      }).filter((i) => i.name.length > 0)
  );

  for (const item of reportItems) {
    // Avoid duplicates
    if (trends.some((t) => t.category === item.name && t.changePct === item.changePct)) continue;

    trends.push({
      category: item.name,
      direction: item.changePct > 0.5 ? "up" : item.changePct < -0.5 ? "down" : "flat",
      changePct: item.changePct,
      summary: `${item.name}: ${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(1)}%`,
      volume: item.volume,
      period: "7d",
    });
  }

  return trends;
}

/**
 * Parse the table-based report detail page (e.g. /market/analysis?reportId=X).
 * Columns: Product, Set, Rarity, Market Price, Price Chart, 7-Day Change, 7-Day Volume, 30-Day Volume.
 */
async function parseReportTable(page: Page): Promise<MarketTrend[]> {
  const trends: MarketTrend[] = [];

  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs.map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td"));
      // Product name is in the 2nd cell (index 1)
      const nameEl = cells[1]?.querySelector("span.text-xs.truncate.font-medium");
      const name = (nameEl?.textContent || "").trim();
      // 7-Day Change is in a cell with green/red span containing %
      let changePct = 0;
      for (const cell of cells) {
        const pctEl = cell.querySelector("span.text-green-600, span.text-red-600");
        if (pctEl) {
          const pctText = pctEl.textContent || "";
          const match = pctText.match(/([+-]?[\d.]+)%/);
          if (match) {
            changePct = parseFloat(match[1]);
            break;
          }
        }
      }
      // Volume from 7-Day Volume column (8th cell, index 7)
      const volText = cells[7]?.querySelector("span.text-xs.font-medium")?.textContent || "";
      const volume = parseInt(volText) || undefined;

      return { name, changePct, volume };
    }).filter((r) => r.name.length > 0)
  );

  for (const row of rows) {
    trends.push({
      category: row.name,
      direction: row.changePct > 0.5 ? "up" : row.changePct < -0.5 ? "down" : "flat",
      changePct: row.changePct,
      summary: `${row.name}: ${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(1)}%`,
      volume: row.volume,
      period: "7d",
    });
  }

  return trends;
}

/**
 * Scrape market trends from PulseTCG.
 * Fetches the homepage for top sellers/movers, then the /market page for reports.
 *
 * @returns Array of market trends, or empty array if scraping fails
 */
export async function scrapeMarketTrends(): Promise<MarketTrend[]> {
  let browser: Browser | undefined;

  try {
    const { email, password } = getCredentials();

    console.log("[pokepulse] Launching browser…");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Log in
    await login(page, email, password);

    // Parse homepage data (available even without login, but login gives full access)
    console.log("[pokepulse] Parsing homepage market data…");
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(2000);

    const homepageTrends = await parseHomepageCards(page);
    const reportTrends = await parseMarketReports(page);

    // Navigate to /market for report listings + try first report detail
    const marketUrl = `${BASE_URL}/market`;
    console.log(`[pokepulse] Fetching: ${marketUrl}`);
    try {
      await page.goto(marketUrl, { waitUntil: "networkidle", timeout: 20_000 });
      await page.waitForTimeout(2000);
      const marketTrends = await parseMarketReports(page);
      reportTrends.push(...marketTrends);

      // Try clicking into the first report to get detailed table data
      const reportLink = page.locator('a[href*="/market/analysis"]').first();
      if ((await reportLink.count()) > 0) {
        await reportLink.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        const tableTrends = await parseReportTable(page);
        console.log(`[pokepulse] Report table: ${tableTrends.length} items`);
        reportTrends.push(...tableTrends);
      }
    } catch (err) {
      console.warn("[pokepulse] Market page failed:", (err as Error).message);
    }

    // Merge and deduplicate
    const allTrends = [...reportTrends, ...homepageTrends];
    const seen = new Set<string>();
    const dedupedTrends = allTrends.filter((t) => {
      const key = `${t.category}:${t.changePct}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[pokepulse] Found ${dedupedTrends.length} market trends`);

    await context.close();
    return dedupedTrends;
  } catch (err) {
    console.warn("[pokepulse] Failed to scrape market trends:", (err as Error).message);
    return [];
  } finally {
    await browser?.close();
  }
}

/**
 * Get a concise market summary string for use in video overlays/descriptions.
 * Returns null if no trends are available.
 */
export function formatMarketSummary(trends: MarketTrend[]): string | null {
  if (trends.length === 0) return null;

  // Calculate overall market direction from all trends
  const avgChange = trends.reduce((sum, t) => sum + t.changePct, 0) / trends.length;
  const upCount = trends.filter((t) => t.direction === "up").length;
  const downCount = trends.filter((t) => t.direction === "down").length;

  const arrow = avgChange > 0.5 ? "▲" : avgChange < -0.5 ? "▼" : "▸";
  const sign = avgChange >= 0 ? "+" : "";

  return `${arrow} Market ${sign}${avgChange.toFixed(1)}% (${upCount} up, ${downCount} down)`;
}

/**
 * Scrape top card data from PokePulse homepage for use in video generation.
 * Returns CardData[] with image URLs, prices (GBP), and % changes.
 */
export async function scrapePokePulseCards(topN = 10): Promise<CardData[]> {
  let browser: Browser | undefined;

  try {
    const { email, password } = getCredentials();

    console.log("[pokepulse] Launching browser for card scrape…");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await login(page, email, password);

    // Navigate to homepage to scrape card grids
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(2000);

    // Extract cards with images from the homepage sections
    const rawCards = await page.$$eval("section", (sects) => {
      const allCards: Array<{
        name: string;
        price: number;
        changePct: number;
        imageUrl: string;
        section: string;
      }> = [];

      for (const sect of sects) {
        const sectionTitle = (sect.querySelector("h3")?.textContent || "").trim();
        const links = Array.from(
          sect.querySelectorAll("a[href^='/cards/'], a[href^='/sealed/']")
        );
        for (const a of links) {
          const name = (a.querySelector("p.text-xs.font-medium, p.truncate")?.textContent || "").trim();
          if (!name) continue;

          // Image URL
          const img = a.querySelector("img");
          const imageUrl = img?.getAttribute("src") || "";

          // Price (£)
          const priceText = Array.from(a.querySelectorAll("span"))
            .find((s) => (s.textContent || "").includes("£"))?.textContent || "";
          const priceMatch = priceText.match(/£([\d,.]+)/);
          const price = priceMatch ? parseFloat(priceMatch[1].replace(",", "")) : 0;

          // % change
          const pctSpan = a.querySelector(".text-green-600, .text-green-400, .text-red-600, .text-red-400");
          const pctText = pctSpan?.textContent || "0";
          const pctMatch = pctText.match(/([\d.]+)%/);
          const pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
          const isDown = !!a.querySelector(".lucide-trending-down");
          const changePct = isDown ? -pct : pct;

          allCards.push({ name, price, changePct, imageUrl, section: sectionTitle });
        }
      }
      return allCards;
    });

    // Deduplicate by name (same card may appear in multiple sections)
    const seen = new Set<string>();
    const uniqueCards = rawCards.filter((c) => {
      if (seen.has(c.name) || !c.imageUrl) return false;
      seen.add(c.name);
      return true;
    });

    // Sort by absolute % change descending (biggest movers first)
    uniqueCards.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

    // Take top N and convert to CardData
    const topCards = uniqueCards.slice(0, topN);
    const cards: CardData[] = topCards.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      number: "",
      setName: c.section,
      rarity: "",
      type: "",
      price: c.price,
      dollarChange: 0,
      percentChange: c.changePct,
      tcgPlayerUrl: "",
      imageUrl: c.imageUrl,
    }));

    console.log(`[pokepulse] Scraped ${cards.length} cards with images`);

    await context.close();
    return cards;
  } catch (err) {
    console.warn("[pokepulse] Card scrape failed:", (err as Error).message);
    return [];
  } finally {
    await browser?.close();
  }
}

/**
 * Pick the best preset direction based on market trends.
 * If the market is trending down, prefer "losers" presets for relevance.
 */
export function suggestDirection(trends: MarketTrend[]): "gainers" | "losers" | null {
  if (trends.length === 0) return null;

  const avgChange =
    trends.reduce((sum, t) => sum + t.changePct, 0) / trends.length;

  // Strong negative trend → show losers for topicality
  if (avgChange < -3) return "losers";
  // Strong positive trend → show gainers
  if (avgChange > 3) return "gainers";
  // No strong signal
  return null;
}
