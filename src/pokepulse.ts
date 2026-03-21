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
      // 7-Day Change — broaden selectors for colour variants
      let changePct = 0;
      const pctSels = "span.text-green-600, span.text-green-500, span.text-green-400, span.text-red-600, span.text-red-500, span.text-red-400, span.text-emerald-600, span.text-emerald-500";
      for (let ci = 5; ci < cells.length; ci++) {
        const cell = cells[ci];
        if (!cell) continue;
        const pctEl = cell.querySelector(pctSels);
        if (pctEl) {
          const pctText = pctEl.textContent || "";
          const match = pctText.match(/([+-]?[\d,.]+)\s*%/);
          if (match) {
            changePct = parseFloat(match[1].replace(",", ""));
            if (pctEl.className.includes("red") && changePct > 0) changePct = -changePct;
            break;
          }
        }
        // Fallback: any text with %
        const cellText = cell.textContent || "";
        const fm = cellText.match(/([+-]?[\d,.]+)\s*%/);
        if (fm) {
          changePct = parseFloat(fm[1].replace(",", ""));
          if (cell.querySelector('[class*="red"]')) {
            if (changePct > 0) changePct = -changePct;
          }
          break;
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
 * Scrape top card data from PokePulse market report table.
 * Navigates to /market → clicks first report → parses the table rows.
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

    // Navigate directly to the 7-day price movers report (reportId=1)
    const reportUrl = `${BASE_URL}/market/analysis?reportId=1`;
    console.log(`[pokepulse] Navigating to ${reportUrl}`);
    await page.goto(reportUrl, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(2000);

    // Wait for the table to appear
    await page.waitForSelector("table tbody tr", { timeout: 10_000 });

    // Debug: dump first row's cells so we can see the structure
    const debugCells = await page.$$eval("table tbody tr:first-child td", (cells) =>
      cells.map((cell, i) => ({ index: i, text: (cell.textContent || "").trim().slice(0, 80), html: cell.innerHTML.slice(0, 200) }))
    );
    console.log("[pokepulse] First row cells:");
    for (const dc of debugCells) {
      console.log(`[pokepulse]   [${dc.index}] text="${dc.text}" html=${dc.html}`);
    }

    // Parse table rows for full card data
    const rawCards = await page.$$eval("table tbody tr", (trs) =>
      trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 6) return null;

        // Product cell (index 1): contains image, name, and number
        const productCell = cells[1];
        const img = productCell?.querySelector("img");
        const imageUrl = img?.getAttribute("src") || "";
        const nameEl = productCell?.querySelector("span.text-xs.truncate.font-medium");
        const name = (nameEl?.textContent || "").trim();
        // Number + rarity hint (e.g. "22/214 • Holo")
        const numberEl = productCell?.querySelector("span.font-normal.text-muted-foreground");
        const numberText = (numberEl?.textContent || "").trim();

        // Set name (index 2)
        const setEl = cells[2]?.querySelector("span.text-xs");
        const setName = (setEl?.textContent || "").trim();

        // Rarity (index 3)
        const rarityEl = cells[3]?.querySelector("span.text-xs");
        const rarity = (rarityEl?.textContent || "").trim();

        // Market Price (index 4) — contains £X.XX in a purple span
        const priceEl = cells[4]?.querySelector("span.font-mono, span.text-purple-600");
        const priceText = priceEl?.textContent || "";
        const priceMatch = priceText.match(/£([\d,.]+)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(",", "")) : 0;

        // 7-Day Change — look for coloured percentage spans across multiple class variants
        let changePct = 0;
        const pctSelectors = [
          "span.text-green-600", "span.text-green-500", "span.text-green-400",
          "span.text-red-600", "span.text-red-500", "span.text-red-400",
          "span.text-emerald-600", "span.text-emerald-500",
        ].join(", ");
        // Skip the price cell (index 4) — only look in cells 5+ for percentage
        for (let ci = 5; ci < cells.length; ci++) {
          const cell = cells[ci];
          if (!cell) continue;
          const pctEl = cell.querySelector(pctSelectors);
          if (pctEl) {
            const pctText = pctEl.textContent || "";
            const match = pctText.match(/([+-]?[\d,.]+)\s*%/);
            if (match) {
              changePct = parseFloat(match[1].replace(",", ""));
              // Detect negative from red class or minus sign
              const isRed = pctEl.className.includes("red");
              if (isRed && changePct > 0) changePct = -changePct;
              break;
            }
          }
          // Fallback: look for any text with % in the cell
          const cellText = cell.textContent || "";
          const fallbackMatch = cellText.match(/([+-]?[\d,.]+)\s*%/);
          if (fallbackMatch) {
            changePct = parseFloat(fallbackMatch[1].replace(",", ""));
            // Check for downward indicators
            if (cell.querySelector('[class*="red"]') || cell.querySelector('.lucide-trending-down')) {
              if (changePct > 0) changePct = -changePct;
            }
            break;
          }
        }

        // Calculate dollar/pound change from price and percentage
        const dollarChange = price > 0 && changePct !== 0
          ? price - (price / (1 + changePct / 100))
          : 0;

        return { name, numberText, setName, rarity, price, changePct, dollarChange, imageUrl };
      }).filter((r): r is NonNullable<typeof r> => r !== null && r.name.length > 0)
    );

    console.log(`[pokepulse] Report table: ${rawCards.length} rows`);
    // Debug: log first few rows so we can verify % extraction
    for (const c of rawCards.slice(0, 3)) {
      console.log(`[pokepulse]   ${c.name}: ${c.changePct}% | £${c.price.toFixed(2)} | Δ£${c.dollarChange.toFixed(2)}`);
    }

    // Sort by absolute % change descending (biggest movers first)
    rawCards.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

    // Take top N and convert to CardData
    const topCards = rawCards.slice(0, topN);
    const cards: CardData[] = topCards.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      number: c.numberText,
      setName: c.setName,
      rarity: c.rarity,
      type: "",
      price: c.price,
      dollarChange: c.dollarChange,
      percentChange: c.changePct,
      tcgPlayerUrl: "",
      imageUrl: c.imageUrl,
      currency: "£",
    }));

    const cardsWithImages = cards.filter(
      (c) => c.imageUrl && !c.imageUrl.startsWith("data:")
    );
    console.log(`[pokepulse] Scraped ${cardsWithImages.length}/${cards.length} cards with images`);

    await context.close();
    return cardsWithImages;
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
