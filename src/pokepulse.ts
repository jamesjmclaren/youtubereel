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
  // Go to homepage first (use domcontentloaded — the SPA polls for live data so networkidle may never fire)
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

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
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    const homepageTrends = await parseHomepageCards(page);
    const reportTrends = await parseMarketReports(page);

    // Navigate to /market for report listings + try first report detail
    const marketUrl = `${BASE_URL}/market`;
    console.log(`[pokepulse] Fetching: ${marketUrl}`);
    try {
      await page.goto(marketUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2000);
      const marketTrends = await parseMarketReports(page);
      reportTrends.push(...marketTrends);

      // Try clicking into the first report card to get detailed table data
      const firstReportH3 = page.locator("h3").first();
      if ((await firstReportH3.count()) > 0) {
        await firstReportH3.evaluate((el) => {
          let target: HTMLElement | null = el as HTMLElement;
          while (target && !target.classList.contains("cursor-pointer")) {
            target = target.parentElement;
          }
          (target || el as HTMLElement).click();
        });
        await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
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
 * Navigates to /market, finds the report by name, and parses the table rows.
 * Returns CardData[] with image URLs, prices (GBP), sales volumes, and % changes.
 *
 * @param topN - Number of top cards to return
 * @param reportName - Report title to match (e.g. "7-Day Price Movers - Cards (Top 50)")
 *                     Defaults to first report if not specified.
 * @param sortBy - How to sort results: "percent" (default) or "rank" (keep original order)
 */
export async function scrapePokePulseCards(
  topN = 10,
  reportName?: string,
  sortBy: "percent" | "rank" = "percent"
): Promise<CardData[]> {
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

    // Navigate to the market page to find reports
    const marketUrl = `${BASE_URL}/market`;
    console.log(`[pokepulse] Navigating to ${marketUrl}`);
    await page.goto(marketUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    console.log(`[pokepulse] Current URL: ${page.url()}`);

    // PokePulse /market page renders reports as clickable <div> cards (not <a> links).
    // Each card has an <h3> with the report title. We find the right card by matching
    // the h3 text, then click the card's cursor-pointer ancestor to trigger SPA navigation.

    // Collect all report card titles from h3 elements
    const reportHeadings = await page.$$("h3");
    const reportCards: Array<{ heading: typeof reportHeadings[0]; text: string }> = [];
    for (const h3 of reportHeadings) {
      const text = ((await h3.textContent()) || "").trim();
      if (text.length > 0) {
        reportCards.push({ heading: h3, text });
      }
    }
    console.log(`[pokepulse] Found ${reportCards.length} h3 headings on /market:`);
    for (const rc of reportCards) {
      console.log(`[pokepulse]   "${rc.text}"`);
    }

    // Find and click the matching report card
    let navigatedToReport = false;
    if (reportName && reportCards.length > 0) {
      console.log(`[pokepulse] Looking for report: "${reportName}"`);

      // Substring match: preset name "7-Day Price Movers - Cards" matches h3 "7-Day Price Movers - Cards (Top 50)"
      let matchedCard = reportCards.find(rc =>
        rc.text.toLowerCase().includes(reportName.toLowerCase())
      );

      // Fallback: keyword match
      if (!matchedCard) {
        const keywords = reportName.toLowerCase().split(/[\s-]+/).filter(w => w.length > 2);
        matchedCard = reportCards.find(rc => {
          const t = rc.text.toLowerCase();
          const hits = keywords.filter(kw => t.includes(kw)).length;
          return hits >= Math.ceil(keywords.length * 0.5);
        });
      }

      if (matchedCard) {
        console.log(`[pokepulse] Matched report card: "${matchedCard.text}"`);
        // Click the closest ancestor with cursor-pointer (the card container), or the h3 itself
        const clicked = await matchedCard.heading.evaluate((el) => {
          let target: HTMLElement | null = el as HTMLElement;
          // Walk up to find the clickable card container
          while (target && !target.classList.contains("cursor-pointer")) {
            target = target.parentElement;
          }
          if (target) {
            target.click();
            return true;
          }
          // Fallback: click the h3 itself
          (el as HTMLElement).click();
          return true;
        });
        if (clicked) navigatedToReport = true;
      } else {
        console.warn(`[pokepulse] Report "${reportName}" not found. Available: ${reportCards.map(rc => rc.text).join(", ")}`);
        // Fall back to first report card
        if (reportCards.length > 0) {
          console.log(`[pokepulse] Falling back to first report: "${reportCards[0].text}"`);
          await reportCards[0].heading.evaluate((el) => {
            let target: HTMLElement | null = el as HTMLElement;
            while (target && !target.classList.contains("cursor-pointer")) {
              target = target.parentElement;
            }
            (target || el as HTMLElement).click();
          });
          navigatedToReport = true;
        }
      }
    } else if (reportCards.length > 0) {
      // No specific report requested — click first one
      await reportCards[0].heading.evaluate((el) => {
        let target: HTMLElement | null = el as HTMLElement;
        while (target && !target.classList.contains("cursor-pointer")) {
          target = target.parentElement;
        }
        (target || el as HTMLElement).click();
      });
      navigatedToReport = true;
    }

    if (navigatedToReport) {
      // Wait for SPA navigation to the report detail page
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
      await page.waitForTimeout(3000);
    }

    console.log(`[pokepulse] After navigation URL: ${page.url()}`);

    // Wait for the table to appear
    try {
      await page.waitForSelector("table tbody tr", { timeout: 10_000 });
    } catch {
      // Sometimes the table takes longer on first load — retry once
      await page.waitForTimeout(3000);
    }

    // Wait for async data to load — PokePulse lazy-loads some columns (prices, volumes)
    // which initially show shimmer/skeleton placeholders (div.animate-pulse).
    // Wait until these placeholders resolve into actual data spans.
    try {
      // Wait for at least one price span to appear (font-mono with £ sign)
      await page.waitForSelector("table tbody span.font-mono", { timeout: 15_000 });
      console.log("[pokepulse] Price data loaded");
    } catch {
      console.warn("[pokepulse] Price data may not have loaded (no span.font-mono found)");
    }

    // Also wait for shimmer placeholders to disappear from the table
    try {
      await page.waitForFunction(
        () => {
          const table = document.querySelector("table tbody");
          if (!table) return true;
          const shimmers = table.querySelectorAll(".animate-pulse");
          return shimmers.length === 0;
        },
        { timeout: 15_000 }
      );
      console.log("[pokepulse] All shimmer placeholders resolved");
    } catch {
      console.warn("[pokepulse] Some shimmer placeholders may still be loading");
      // Give it a final extra wait
      await page.waitForTimeout(3000);
    }

    // Re-check for table rows after waiting for data
    try {
      await page.waitForSelector("table tbody tr", { timeout: 5_000 });
    } catch {
      // Table not found — dump page structure for debugging
      const bodyText = await page.$eval("body", (b) => (b.textContent || "").trim().slice(0, 500));
      console.warn(`[pokepulse] No table found on page. URL: ${page.url()}`);
      console.warn(`[pokepulse] Body text preview: ${bodyText}`);

      // Check if there's a different container (cards/grid instead of table)
      const containers = await page.$$eval("div, section", (els) =>
        els.map(el => ({
          cls: el.className?.slice(0, 60) || "",
          children: el.children.length,
          text: (el.textContent || "").trim().slice(0, 60),
        })).filter(e => e.children > 5 && e.text.length > 20).slice(0, 10)
      );
      console.warn(`[pokepulse] Top containers:`);
      for (const c of containers) {
        console.warn(`[pokepulse]   class="${c.cls}" children=${c.children} text="${c.text}"`);
      }

      throw new Error("No report table found on page");
    }

    // Detect column layout from table headers
    // Price Movers: Checkbox | Product | Set | Rarity | Market Price | Price Chart | 7-Day Change | 7-Day Volume | 30-Day Volume (9 cols)
    // Volume Movers: Checkbox | Product | Set | Rarity | Market Price | Price Chart | 7-Day Volume | 30-Day Volume (8 cols, no 7-Day Change)
    const columnHeaders = await page.$$eval("table thead th", (ths) =>
      ths.map((th, i) => ({ index: i, text: (th.textContent || "").trim().toLowerCase() }))
    );
    console.log("[pokepulse] Table headers:");
    for (const ch of columnHeaders) {
      console.log(`[pokepulse]   [${ch.index}] "${ch.text}"`);
    }

    // Build column index map from headers
    // Note: "price" must match "market price" but NOT "price chart", so use "market price" first
    // Headers may contain extra whitespace or differ in casing — all are lowercased above
    const colMap = {
      product: columnHeaders.find(h => h.text.includes("product"))?.index ?? 1,
      set: columnHeaders.find(h => h.text === "set")?.index ?? 2,
      rarity: columnHeaders.find(h => h.text.includes("rarity"))?.index ?? 3,
      price: columnHeaders.find(h => h.text.includes("market price") || (h.text.includes("price") && !h.text.includes("chart")))?.index ?? 4,
      change7d: columnHeaders.find(h => h.text.includes("change") || h.text.includes("7-day %") || h.text.includes("7d %"))?.index ?? -1,  // -1 = not present
      vol7d: columnHeaders.find(h => h.text.includes("7-day vol") || h.text.includes("7d vol") || h.text.includes("7-day volume"))?.index ?? -1,
      vol30d: columnHeaders.find(h => h.text.includes("30-day vol") || h.text.includes("30d vol") || h.text.includes("30-day volume"))?.index ?? -1,
    };

    // Fallback: if change column not found by header, detect it from first row content
    // (look for a cell containing a colored % span like +126.6%)
    if (colMap.change7d === -1) {
      const changeColIdx = await page.$$eval("table tbody tr:first-child td", (cells) => {
        for (let i = 4; i < cells.length; i++) {
          const pctEl = cells[i].querySelector(
            "span.text-green-600, span.text-green-500, span.text-red-600, span.text-red-500"
          );
          if (pctEl && /[+-]?[\d,.]+\s*%/.test(pctEl.textContent || "")) {
            return i;
          }
        }
        return -1;
      });
      if (changeColIdx >= 0) {
        colMap.change7d = changeColIdx;
        console.log(`[pokepulse] Detected change column from cell content at index ${changeColIdx}`);
      }
    }

    // Fallback: if vol columns not found by header text, use last two numeric columns
    if (colMap.vol7d === -1 || colMap.vol30d === -1) {
      const totalCols = columnHeaders.length;
      if (totalCols >= 9) {
        // 9-col layout (Price Movers): vol7d=7, vol30d=8
        if (colMap.vol7d === -1) colMap.vol7d = 7;
        if (colMap.vol30d === -1) colMap.vol30d = 8;
      } else if (totalCols >= 8) {
        // 8-col layout (Volume Movers): vol7d=6, vol30d=7
        if (colMap.vol7d === -1) colMap.vol7d = 6;
        if (colMap.vol30d === -1) colMap.vol30d = 7;
      }
    }

    console.log(`[pokepulse] Column map: product=${colMap.product} set=${colMap.set} rarity=${colMap.rarity} price=${colMap.price} change=${colMap.change7d} vol7d=${colMap.vol7d} vol30d=${colMap.vol30d}`);

    // Debug: dump first row's cells so we can see the structure
    const debugCells = await page.$$eval("table tbody tr:first-child td", (cells) =>
      cells.map((cell, i) => ({ index: i, text: (cell.textContent || "").trim().slice(0, 80), html: cell.innerHTML.slice(0, 200) }))
    );
    console.log("[pokepulse] First row cells:");
    for (const dc of debugCells) {
      console.log(`[pokepulse]   [${dc.index}] text="${dc.text}" html=${dc.html}`);
    }

    // Parse table rows for full card data using the detected column map
    const rawCards = await page.$$eval("table tbody tr", (trs, cm) =>
      trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 4) return null;

        // Product cell: contains image, name, and number
        const productCell = cells[cm.product];
        const img = productCell?.querySelector("img");
        const imageUrl = img?.getAttribute("src") || "";
        const nameEl = productCell?.querySelector("span.text-xs.truncate.font-medium");
        const name = (nameEl?.textContent || "").trim();
        const numberEl = productCell?.querySelector("span.font-normal.text-muted-foreground");
        const numberText = (numberEl?.textContent || "").trim();

        // Set name
        const setEl = cells[cm.set]?.querySelector("span.text-xs");
        const setName = (setEl?.textContent || "").trim();

        // Rarity
        const rarityEl = cells[cm.rarity]?.querySelector("span.text-xs");
        const rarity = (rarityEl?.textContent || "").trim();

        // Market Price — try the known price column first, then scan all cells
        let price = 0;
        const priceCells = cm.price >= 0 ? [cells[cm.price], ...cells] : cells;
        for (const cell of priceCells) {
          if (!cell) continue;
          const priceEl = cell.querySelector("span.font-mono, span.text-purple-600");
          const priceText = priceEl?.textContent || "";
          const priceMatch = priceText.match(/£([\d,.]+)/);
          if (priceMatch) {
            price = parseFloat(priceMatch[1].replace(",", ""));
            break;
          }
        }

        // Percentage change — only look in the 7-Day Change column if it exists
        let changePct = 0;
        const pctSelectors = "span.text-green-600, span.text-green-500, span.text-green-400, span.text-red-600, span.text-red-500, span.text-red-400, span.text-emerald-600, span.text-emerald-500";

        if (cm.change7d >= 0) {
          // We know exactly which column has the % change
          const changeCell = cells[cm.change7d];
          if (changeCell) {
            const pctEl = changeCell.querySelector(pctSelectors);
            if (pctEl) {
              const pctText = pctEl.textContent || "";
              const match = pctText.match(/([+-]?[\d,.]+)\s*%/);
              if (match) {
                changePct = parseFloat(match[1].replace(",", ""));
                if (pctEl.className.includes("red") && changePct > 0) changePct = -changePct;
              }
            }
            if (changePct === 0) {
              const cellText = changeCell.textContent || "";
              const fm = cellText.match(/([+-]?[\d,.]+)\s*%/);
              if (fm) {
                changePct = parseFloat(fm[1].replace(",", ""));
                if (changeCell.querySelector('[class*="red"]')) {
                  if (changePct > 0) changePct = -changePct;
                }
              }
            }
          }
        } else {
          // No dedicated change column — scan for any % value (fallback for unknown layouts)
          for (let ci = 4; ci < cells.length; ci++) {
            const cell = cells[ci];
            if (!cell) continue;
            const pctEl = cell.querySelector(pctSelectors);
            if (pctEl) {
              const pctText = pctEl.textContent || "";
              const match = pctText.match(/([+-]?[\d,.]+)\s*%/);
              if (match) {
                changePct = parseFloat(match[1].replace(",", ""));
                if (pctEl.className.includes("red") && changePct > 0) changePct = -changePct;
                break;
              }
            }
          }
        }

        // Sales volumes — read from exact column indices
        let salesVolume7d: number | undefined;
        let salesVolume30d: number | undefined;

        if (cm.vol7d >= 0 && cells[cm.vol7d]) {
          const spanEl = cells[cm.vol7d].querySelector("span.text-xs.font-medium, span.font-mono");
          const text = (spanEl?.textContent || cells[cm.vol7d].textContent || "").trim();
          const num = parseInt(text.replace(/,/g, ""));
          if (!isNaN(num) && !/[%£$€]/.test(text)) salesVolume7d = num;
        }
        if (cm.vol30d >= 0 && cells[cm.vol30d]) {
          const spanEl = cells[cm.vol30d].querySelector("span.text-xs.font-medium, span.font-mono");
          const text = (spanEl?.textContent || cells[cm.vol30d].textContent || "").trim();
          const num = parseInt(text.replace(/,/g, ""));
          if (!isNaN(num) && !/[%£$€]/.test(text)) salesVolume30d = num;
        }

        // Calculate pound change from price and percentage
        const dollarChange = price > 0 && changePct !== 0
          ? price - (price / (1 + changePct / 100))
          : 0;

        return { name, numberText, setName, rarity, price, changePct, dollarChange, imageUrl, salesVolume7d, salesVolume30d };
      }).filter((r): r is NonNullable<typeof r> => r !== null && r.name.length > 0)
    , colMap);

    console.log(`[pokepulse] Report table: ${rawCards.length} rows`);
    for (const c of rawCards.slice(0, 3)) {
      console.log(`[pokepulse]   ${c.name}: ${c.changePct}% | £${c.price.toFixed(2)} | 7d vol: ${c.salesVolume7d ?? "?"} | 30d vol: ${c.salesVolume30d ?? "?"}`);
    }

    // Sort by absolute % change descending (biggest movers first) or keep original rank
    if (sortBy === "percent") {
      rawCards.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    }

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
      salesVolume7d: c.salesVolume7d,
      salesVolume30d: c.salesVolume30d,
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
