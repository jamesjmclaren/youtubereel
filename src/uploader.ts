import { google } from "googleapis";
import { readFile, writeFile } from "fs/promises";
import { createReadStream } from "fs";
import type { CardData, MarketTrend, SlideDisplayMode } from "./types.js";

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];
const TOKEN_PATH = "tokens.json";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

function getOAuth2Client() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET env vars.\n" +
        "Set up OAuth2 credentials at https://console.cloud.google.com/apis/credentials"
    );
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    "http://localhost:3000/oauth2callback"
  );
}

/**
 * Generate an auth URL for first-time setup.
 * User visits this URL, grants access, gets a code.
 */
export function getAuthUrl(): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
}

/**
 * Exchange an authorization code for tokens and save them.
 */
export async function exchangeCode(code: string): Promise<void> {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("[uploader] Tokens saved to", TOKEN_PATH);
}

async function getAuthenticatedClient() {
  const oauth2Client = getOAuth2Client();

  let tokenData: string;
  try {
    tokenData = await readFile(TOKEN_PATH, "utf-8");
  } catch {
    throw new Error(
      "No saved tokens found. Run the auth flow first:\n" +
        "  1. Run: npm run start -- --auth\n" +
        "  2. Visit the URL and authorize\n" +
        "  3. Run: npm run start -- --code YOUR_CODE"
    );
  }

  const tokens = JSON.parse(tokenData) as StoredTokens;
  oauth2Client.setCredentials(tokens);

  // Refresh if expired
  if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
    console.log("[uploader] Refreshing expired token...");
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    } catch (err) {
      throw new Error(
        `Failed to refresh YouTube token: ${err instanceof Error ? err.message : err}\n` +
          "This can happen if your Google Cloud app is in 'Testing' mode (tokens expire after 7 days).\n" +
          "Fix: publish the app in Google Cloud Console, then re-auth:\n" +
          "  1. Run: npm run start -- --auth\n" +
          "  2. Visit the URL and authorize\n" +
          "  3. Run: npm run start -- --code YOUR_CODE"
      );
    }
  }

  return oauth2Client;
}

function generateTitle(
  cards: CardData[],
  period: string,
  excludeTitles: string[] = [],
  displayMode: SlideDisplayMode = "price-and-percent"
): string {
  const periodLabel =
    period === "24h"
      ? "24 Hours"
      : period === "7d"
        ? "This Week"
        : period === "30d"
          ? "This Month"
          : "90 Days";

  const topCard = cards[0];
  const topChange = `+${topCard.percentChange.toFixed(0)}%`;
  const setName = topCard.setName || "";
  const hasSet = setName.length > 0;

  let titles: string[];

  if (displayMode === "sales-7d" || displayMode === "sales-30d") {
    const salesLabel = displayMode === "sales-7d" ? "This Week" : "This Month";
    titles = [
      `The Most WANTED Pokémon Cards ${salesLabel} 🔥 #Shorts`,
      `Everyone Is Buying These Pokémon Cards ${salesLabel}! #Shorts`,
      `Top Selling Pokémon Cards ${salesLabel} 📈 #Shorts`,
      `These Pokémon Cards Are FLYING Off Shelves ${salesLabel}! 🚀 #Shorts`,
      `Best Selling Pokémon Cards Right Now ${salesLabel} #Shorts`,
      `${topCard.name} Is The #1 Seller ${salesLabel}! #Shorts`,
      `Pokémon Cards Everyone Wants ${salesLabel} 🔥 #Shorts`,
      `You Won't Believe What's Selling ${salesLabel}! #Shorts`,
    ];
  } else {
    titles = [
      `${topCard.name} Up ${topChange}! Pokémon Card Gainers ${periodLabel} #Shorts`,
      `Pokémon Cards EXPLODING in Price ${periodLabel} 📈 #Shorts`,
      `These Pokémon Cards Are SKYROCKETING ${periodLabel}! 🚀 #Shorts`,
      `${topCard.name} ${topChange} — Don't Sleep on These Cards! #Shorts`,
      `Pokémon Cards You NEED Before They Moon 🌙 ${periodLabel} #Shorts`,
      `${topChange} in ${periodLabel}?! ${topCard.name} Is Moving 📈 #Shorts`,
      `Who Saw ${topCard.name} Coming? ${topChange} ${periodLabel} 🔥 #Shorts`,
      `The Pokémon Cards Nobody's Talking About ${periodLabel} #Shorts`,
      ...(hasSet
        ? [
            `${setName} Cards Are POPPING OFF ${periodLabel} 🔥 #Shorts`,
            `Best ${setName} Pulls to Invest In Right Now #Shorts`,
          ]
        : []),
    ];
  }

  // Filter out previously used titles to avoid duplicates in multi-video runs
  const available = titles.filter((t) => !excludeTitles.includes(t));
  const pool = available.length > 0 ? available : titles;

  return pool[Math.floor(Math.random() * pool.length)];
}

function generateDescription(
  cards: CardData[],
  period: string,
  marketTrends?: MarketTrend[],
  displayMode: SlideDisplayMode = "price-and-percent"
): string {
  let intro: string;
  if (displayMode === "sales-7d") {
    intro = `Top ${cards.length} best selling Pokémon cards this week.`;
  } else if (displayMode === "sales-30d") {
    intro = `Top ${cards.length} best selling Pokémon cards this month.`;
  } else {
    intro = `Top ${cards.length} Pokémon cards with the biggest price increases (${period}).`;
  }

  const lines = [intro, ""];

  // Add market trend context if available
  if (marketTrends && marketTrends.length > 0) {
    lines.push("📈 Market Snapshot:");
    for (const trend of marketTrends.slice(0, 3)) {
      const arrow = trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "▸";
      lines.push(`  ${arrow} ${trend.summary}`);
    }
    lines.push("");
  }

  lines.push("📊 Rankings:");
  if (displayMode === "sales-7d") {
    lines.push(
      ...cards.map((c) => {
        const cur = c.currency || "$";
        return `#${c.rank} ${c.name} — ${cur}${c.price.toFixed(2)} (${c.salesVolume7d ?? 0} sold)`;
      })
    );
  } else if (displayMode === "sales-30d") {
    lines.push(
      ...cards.map((c) => {
        const cur = c.currency || "$";
        return `#${c.rank} ${c.name} — ${cur}${c.price.toFixed(2)} (${c.salesVolume30d ?? 0} sold)`;
      })
    );
  } else {
    lines.push(
      ...cards.map((c) => {
        const cur = c.currency || "$";
        const sign = c.percentChange >= 0 ? "+" : "";
        return `#${c.rank} ${c.name} — ${cur}${c.price.toFixed(2)} (${sign}${c.percentChange.toFixed(0)}%)`;
      })
    );
  }

  lines.push(
    "",
    "Pokemon TCG Price Watch",
    "",
    "#Pokemon #PokemonTCG #PokemonCards #TCG #Investing #PriceWatch #Shorts"
  );

  return lines.join("\n");
}

export async function uploadToYouTube(
  videoPath: string,
  cards: CardData[],
  period: string,
  excludeTitles: string[] = [],
  marketTrends?: MarketTrend[],
  displayMode: SlideDisplayMode = "price-and-percent"
): Promise<{ url: string; title: string }> {
  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const title = generateTitle(cards, period, excludeTitles, displayMode);
  const description = generateDescription(cards, period, marketTrends, displayMode);

  console.log(`[uploader] Uploading: ${title}`);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags: [
          "Pokemon",
          "Pokemon TCG",
          "Pokemon Cards",
          "TCG",
          "Trading Cards",
          "Price Watch",
          "Pokemon Investing",
          "Top Gainers",
          "Card Prices",
        ],
        categoryId: "20", // Gaming
        defaultLanguage: "en",
      },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(videoPath),
    },
  });

  const videoId = res.data.id;
  const videoUrl = `https://youtube.com/shorts/${videoId}`;
  console.log(`[uploader] Uploaded! ${videoUrl}`);

  return { url: videoUrl, title };
}

// CLI entry point
if (process.argv[1]?.includes("uploader")) {
  const command = process.argv[2];

  if (command === "--auth") {
    console.log("Visit this URL to authorize:\n");
    console.log(getAuthUrl());
    console.log("\nThen run: npm run upload -- --code YOUR_CODE");
  } else if (command === "--code") {
    const code = process.argv[3];
    if (!code) {
      console.error("Provide the authorization code: npm run upload -- --code YOUR_CODE");
      process.exit(1);
    }
    await exchangeCode(code);
  } else {
    const videoPath = process.argv[2] || "output/short.mp4";
    const cardsPath = process.argv[3] || "output/cards.json";
    const cards = JSON.parse(await readFile(cardsPath, "utf-8")) as CardData[];
    await uploadToYouTube(videoPath, cards, "30d");
  }
}
