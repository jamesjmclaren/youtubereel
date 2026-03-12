import { google } from "googleapis";
import { readFile, writeFile } from "fs/promises";
import { createReadStream } from "fs";
import type { CardData } from "./types.js";

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

  try {
    const tokenData = await readFile(TOKEN_PATH, "utf-8");
    const tokens = JSON.parse(tokenData) as StoredTokens;
    oauth2Client.setCredentials(tokens);

    // Refresh if expired
    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
      console.log("[uploader] Refreshing expired token...");
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    }

    return oauth2Client;
  } catch {
    throw new Error(
      "No saved tokens found. Run the auth flow first:\n" +
        "  1. Run: npm run start -- --auth\n" +
        "  2. Visit the URL and authorize\n" +
        "  3. Run: npm run start -- --code YOUR_CODE"
    );
  }
}

function generateTitle(cards: CardData[], period: string): string {
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

  const titles = [
    `${topCard.name} Up ${topChange}! Top 5 Pokémon Card Gainers ${periodLabel} #Shorts`,
    `Top 5 Pokémon Cards EXPLODING in Price ${periodLabel} 📈 #Shorts`,
    `These Pokémon Cards Are SKYROCKETING! ${periodLabel} Top Gainers #Shorts`,
    `${topCard.name} ${topChange} 🚀 Top 5 Price Gainers ${periodLabel} #Shorts`,
    `Pokémon Cards You NEED Before They Moon 🌙 ${periodLabel} #Shorts`,
  ];

  return titles[Math.floor(Math.random() * titles.length)];
}

function generateDescription(cards: CardData[], period: string): string {
  const lines = [
    `Top 5 Pokémon cards with the biggest price increases (${period}).`,
    "",
    "📊 Rankings:",
    ...cards.map(
      (c) =>
        `#${c.rank} ${c.name} — $${c.price.toFixed(2)} (+${c.percentChange.toFixed(0)}%)`
    ),
    "",
    "Data from TCG Market News • Prices from TCGPlayer",
    "",
    "#Pokemon #PokemonTCG #PokemonCards #TCG #Investing #PriceWatch #Shorts",
  ];

  return lines.join("\n");
}

export async function uploadToYouTube(
  videoPath: string,
  cards: CardData[],
  period: string
): Promise<string> {
  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const title = generateTitle(cards, period);
  const description = generateDescription(cards, period);

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

  return videoUrl;
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
