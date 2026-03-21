import { readFile, stat } from "fs/promises";
import type { CardData, MarketTrend } from "./types.js";

const GRAPH_API = "https://graph.facebook.com/v21.0";
const RUPLOAD_API = "https://rupload.facebook.com/video-upload/v21.0";

function getCredentials(): { pageId: string; accessToken: string } {
  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !accessToken) {
    throw new Error(
      "Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN env vars.\n" +
        "Create a Page Access Token at https://developers.facebook.com/tools/explorer/"
    );
  }
  return { pageId, accessToken };
}

function generateDescription(
  cards: CardData[],
  period: string,
  marketTrends?: MarketTrend[]
): string {
  const periodLabel =
    period === "24h"
      ? "24 Hours"
      : period === "7d"
        ? "This Week"
        : period === "30d"
          ? "This Month"
          : "90 Days";

  const lines = [
    `Top Pokémon cards with the biggest price moves (${periodLabel}).`,
    "",
  ];

  if (marketTrends && marketTrends.length > 0) {
    lines.push("Market Snapshot:");
    for (const trend of marketTrends.slice(0, 3)) {
      const arrow = trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "▸";
      lines.push(`  ${arrow} ${trend.summary}`);
    }
    lines.push("");
  }

  lines.push(
    "Rankings:",
    ...cards.map((c) => {
      const cur = c.currency || "$";
      return `#${c.rank} ${c.name} — ${cur}${c.price.toFixed(2)} (+${c.percentChange.toFixed(0)}%)`;
    }),
    "",
    "Pokemon TCG Price Watch",
    "",
    "#Pokemon #PokemonTCG #PokemonCards #TCG #Investing #PriceWatch"
  );

  return lines.join("\n");
}

/**
 * Upload a video as a Facebook Reel using the 3-phase Reels API.
 *
 * Phase 1: Initialize upload → get video_id
 * Phase 2: Binary upload via resumable upload URL
 * Phase 3: Finish / publish the reel
 */
export async function uploadToFacebook(
  videoPath: string,
  cards: CardData[],
  period: string,
  marketTrends?: MarketTrend[]
): Promise<{ url: string }> {
  const { pageId, accessToken } = getCredentials();
  const description = generateDescription(cards, period, marketTrends);

  // --- Phase 1: Initialize ---
  console.log("[facebook] Initializing Reel upload…");
  const initRes = await fetch(`${GRAPH_API}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_phase: "start",
      access_token: accessToken,
    }),
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Facebook init failed (${initRes.status}): ${err}`);
  }

  const initData = (await initRes.json()) as { video_id: string };
  const videoId = initData.video_id;
  console.log(`[facebook] Got video_id: ${videoId}`);

  // --- Phase 2: Upload binary ---
  console.log("[facebook] Uploading video binary…");
  const videoBuffer = await readFile(videoPath);
  const fileSize = (await stat(videoPath)).size;

  const uploadRes = await fetch(`${RUPLOAD_API}/${videoId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      offset: "0",
      file_size: String(fileSize),
      "Content-Type": "application/octet-stream",
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Facebook upload failed (${uploadRes.status}): ${err}`);
  }

  console.log("[facebook] Binary upload complete");

  // --- Phase 3: Finish / publish ---
  console.log("[facebook] Publishing Reel…");
  const finishRes = await fetch(`${GRAPH_API}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_phase: "finish",
      video_id: videoId,
      access_token: accessToken,
      title: `Pokémon TCG Price Movers`,
      description,
      published: true,
    }),
  });

  if (!finishRes.ok) {
    const err = await finishRes.text();
    throw new Error(`Facebook publish failed (${finishRes.status}): ${err}`);
  }

  const finishData = (await finishRes.json()) as { success?: boolean; post_id?: string };
  const postUrl = `https://www.facebook.com/${pageId}/videos/${videoId}`;
  console.log(`[facebook] Published! ${postUrl}`);

  return { url: postUrl };
}
