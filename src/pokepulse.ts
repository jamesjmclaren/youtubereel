import { chromium, type Browser, type Page } from "playwright";
import type { MarketTrend } from "./types.js";

/**
 * PokePulse (pokepulse.io) market trends scraper.
 *
 * Authenticates via Playwright and scrapes the /market/analysis page
 * for market trend data to enrich video content.
 *
 * Credentials are read from environment variables:
 *   POKEPULSE_EMAIL – login email
 *   POKEPULSE_PASSWORD – login password
 */

const BASE_URL = "https://pokepulse.io";
const ANALYSIS_URL = `${BASE_URL}/market/analysis`;

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
 * Log in to PokePulse via Playwright.
 * Tries common login page paths and fills email/password fields.
 */
async function login(page: Page, email: string, password: string): Promise<void> {
  // Try common login paths
  const loginPaths = ["/login", "/auth/login", "/signin", "/auth/signin"];

  let loggedIn = false;
  for (const loginPath of loginPaths) {
    try {
      await page.goto(`${BASE_URL}${loginPath}`, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });

      // Check if we landed on a page with a login form
      const hasForm = await page
        .locator('input[type="email"], input[type="text"][name*="email"], input[name="email"]')
        .count();
      if (hasForm === 0) continue;

      // Fill email
      const emailInput = page.locator(
        'input[type="email"], input[type="text"][name*="email"], input[name="email"]'
      ).first();
      await emailInput.fill(email);

      // Fill password
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(password);

      // Submit
      const submitBtn = page.locator(
        'button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")'
      ).first();
      await submitBtn.click();

      // Wait for navigation after login
      await page.waitForURL((url) => !url.pathname.includes("login") && !url.pathname.includes("signin"), {
        timeout: 15_000,
      });

      loggedIn = true;
      console.log("[pokepulse] Logged in successfully");
      break;
    } catch (err) {
      console.warn(`[pokepulse] Login attempt at ${loginPath} failed:`, (err as Error).message);
    }
  }

  if (!loggedIn) {
    throw new Error("Could not find or complete PokePulse login form");
  }
}

/**
 * Parse market trend data from the analysis page HTML.
 * Adaptively extracts data from tables, cards/panels, and structured content.
 */
async function parseTrends(page: Page): Promise<MarketTrend[]> {
  const trends: MarketTrend[] = [];

  // Strategy 1: Extract from tables (common in market analysis pages)
  const tableData = await page.$$eval("table", (tables) => {
    return tables.map((table) => {
      const headers = Array.from(table.querySelectorAll("th")).map((th) =>
        (th.textContent || "").trim().toLowerCase()
      );
      const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim())
      );
      return { headers, rows };
    });
  });

  for (const table of tableData) {
    // Look for columns that indicate trend data (name/category, change%, direction)
    const nameCol = table.headers.findIndex((h) =>
      /name|card|set|category/i.test(h)
    );
    const changeCol = table.headers.findIndex((h) =>
      /change|%|percent|gain|loss|movement/i.test(h)
    );

    if (nameCol >= 0 && changeCol >= 0) {
      for (const row of table.rows) {
        const category = row[nameCol] || "unknown";
        const rawChange = row[changeCol] || "0";
        const changePct = parseFloat(rawChange.replace(/[^-\d.]/g, "")) || 0;

        trends.push({
          category,
          direction: changePct > 0.5 ? "up" : changePct < -0.5 ? "down" : "flat",
          changePct,
          summary: `${category}: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`,
        });
      }
    }
  }

  // Strategy 2: Extract from stat cards/panels (common in dashboards)
  const statCards = await page.$$eval(
    '[class*="stat"], [class*="trend"], [class*="metric"], [class*="card"], [class*="panel"]',
    (els) =>
      els
        .map((el) => ({
          text: (el.textContent || "").trim().slice(0, 300),
          classes: el.className,
        }))
        .filter((e) => /[+-]?\d+\.?\d*%/.test(e.text))
  );

  for (const card of statCards) {
    const pctMatch = card.text.match(/([+-]?\d+\.?\d*)%/);
    if (!pctMatch) continue;

    const changePct = parseFloat(pctMatch[1]);
    // Try to extract a label from the card text (everything before the percentage)
    const labelMatch = card.text.match(/^(.+?)\s*[+-]?\d/);
    const category = labelMatch
      ? labelMatch[1].replace(/\n/g, " ").trim().slice(0, 60)
      : "market";

    // Avoid duplicates from table data
    if (trends.some((t) => t.category === category && t.changePct === changePct)) continue;

    trends.push({
      category,
      direction: changePct > 0.5 ? "up" : changePct < -0.5 ? "down" : "flat",
      changePct,
      summary: `${category}: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`,
    });
  }

  // Strategy 3: Extract from JSON embedded in scripts (Next.js / React apps)
  const scriptData = await page.$$eval("script", (scripts) =>
    scripts
      .map((s) => s.textContent || "")
      .filter((t) => t.includes("market") || t.includes("trend") || t.includes("change"))
      .map((t) => t.slice(0, 5000))
  );

  for (const script of scriptData) {
    try {
      // Look for JSON objects with market data
      const jsonMatches = script.match(/\{[^{}]*"(?:change|trend|market)[^{}]*\}/gi) || [];
      for (const jsonStr of jsonMatches) {
        try {
          const obj = JSON.parse(jsonStr) as Record<string, unknown>;
          if (typeof obj.changePct === "number" || typeof obj.change === "number") {
            const pct = (obj.changePct ?? obj.change) as number;
            const cat = (obj.name ?? obj.category ?? obj.set ?? "market") as string;
            if (!trends.some((t) => t.category === cat && t.changePct === pct)) {
              trends.push({
                category: cat,
                direction: pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat",
                changePct: pct,
                summary: `${cat}: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Extract any trending card names mentioned on the page
  const trendingNames = await page
    .$$eval('[class*="trending"], [class*="hot"], [class*="top"] li, [class*="mover"]', (els) =>
      els.map((el) => (el.textContent || "").trim()).filter((t) => t.length > 2 && t.length < 80)
    )
    .catch(() => [] as string[]);

  if (trendingNames.length > 0 && trends.length > 0) {
    trends[0].trendingCards = trendingNames.slice(0, 10);
  }

  return trends;
}

/**
 * Scrape market trends from PokePulse.
 *
 * @param reportId - The report ID to fetch (default: 1)
 * @returns Array of market trends, or empty array if scraping fails
 */
export async function scrapeMarketTrends(reportId = 1): Promise<MarketTrend[]> {
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

    // Navigate to market analysis
    const analysisUrl = `${ANALYSIS_URL}?reportId=${reportId}`;
    console.log(`[pokepulse] Fetching: ${analysisUrl}`);
    await page.goto(analysisUrl, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Wait for content to render (SPAs may need extra time)
    await page.waitForTimeout(2000);

    // Parse trends
    const trends = await parseTrends(page);
    console.log(`[pokepulse] Found ${trends.length} market trends`);

    await context.close();
    return trends;
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

  // Find overall market trend (or use the first one)
  const overall = trends.find((t) =>
    /overall|market|total|index/i.test(t.category)
  ) || trends[0];

  const arrow = overall.direction === "up" ? "▲" : overall.direction === "down" ? "▼" : "▸";
  const sign = overall.changePct >= 0 ? "+" : "";

  return `${arrow} Market ${sign}${overall.changePct.toFixed(1)}%`;
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
