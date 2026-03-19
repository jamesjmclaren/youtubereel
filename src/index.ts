import { mkdir, writeFile, readdir } from "fs/promises";
import { scrapeTopCards, scrapeSetCards, downloadCardImages } from "./scraper.js";
import { generateImage, generateSlides } from "./image-generator.js";
import type { CardData, MarketTrend } from "./types.js";
import { renderVideo, renderSlideshow, videoDuration } from "./video-renderer.js";
import { uploadToYouTube, getAuthUrl, exchangeCode } from "./uploader.js";
import { CONTENT_PRESETS, getPresetForToday, getPresetForTodayWithSets, buildSetPresets } from "./presets.js";
import type { PipelineConfig, ContentPreset } from "./types.js";
import { scrapeMarketTrends, formatMarketSummary, suggestDirection, scrapePokePulseCards } from "./pokepulse.js";

/** Titles used in this session — prevents duplicate titles across dual-mode videos */
const usedTitles: string[] = [];

/** Cached market trends for the session (fetched once, reused across videos) */
let cachedMarketTrends: MarketTrend[] | undefined;

async function fetchMarketTrends(): Promise<MarketTrend[]> {
  if (cachedMarketTrends !== undefined) return cachedMarketTrends;

  if (!process.env.POKEPULSE_EMAIL || !process.env.POKEPULSE_PASSWORD) {
    console.log("[pipeline] PokePulse credentials not set — skipping market trends");
    cachedMarketTrends = [];
    return cachedMarketTrends;
  }

  try {
    cachedMarketTrends = await scrapeMarketTrends();
    if (cachedMarketTrends.length > 0) {
      const summary = formatMarketSummary(cachedMarketTrends);
      console.log(`[pipeline] Market snapshot: ${summary}`);
    }
  } catch (err) {
    console.warn("[pipeline] PokePulse fetch failed:", (err as Error).message);
    cachedMarketTrends = [];
  }

  return cachedMarketTrends;
}

async function run(
  config: PipelineConfig,
  preset: ContentPreset | null,
  skipUpload = false
) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const presetName = preset?.name || "custom";
  const runDir = `${config.outputDir}/${timestamp}-${presetName}`;
  await mkdir(runDir, { recursive: true });

  // Step 1: Scrape
  console.log("\n━━━ Step 1: Scraping cards ━━━");
  let cards: CardData[];
  if (preset?.source === "pokepulse") {
    cards = await scrapePokePulseCards(config.topN);
  } else if (preset?.setSlug) {
    cards = await scrapeSetCards({
      setSlug: preset.setSlug,
      period: config.period,
      topN: config.topN,
      rarityFilter: preset.rarityFilter,
    });
  } else {
    cards = await scrapeTopCards(config);
  }
  if (cards.length === 0) {
    throw new Error("No cards found. Aborting.");
  }
  console.log(`Found ${cards.length} cards`);

  // Step 2: Download images
  console.log("\n━━━ Step 2: Downloading card images ━━━");
  cards = await downloadCardImages(cards, `${runDir}/images`);
  await writeFile(`${runDir}/cards.json`, JSON.stringify(cards, null, 2));

  // Pick a random music track
  let musicPath = "assets/music.mp3";
  try {
    const assetFiles = await readdir("assets");
    const mp3s = assetFiles.filter((f) => f.endsWith(".mp3"));
    if (mp3s.length > 0) {
      const pick = mp3s[Math.floor(Math.random() * mp3s.length)];
      musicPath = `assets/${pick}`;
      console.log(`Using music: ${pick}`);
    }
  } catch { /* use default */ }

  // Drop cards where image download failed — never show placeholders in the video
  const cardsWithImages = cards.filter((c) => c.imageUrl && !c.imageUrl.startsWith("http"));
  if (cardsWithImages.length === 0) {
    throw new Error("No card images downloaded. Aborting.");
  }
  if (cardsWithImages.length < cards.length) {
    console.warn(
      `[pipeline] ${cards.length - cardsWithImages.length} card(s) dropped (no image). Using ${cardsWithImages.length} cards.`
    );
  }
  // Re-rank after dropping image-less cards
  cards = cardsWithImages.map((c, i) => ({ ...c, rank: i + 1 }));

  const duration = videoDuration(cards.length);

  // Force slideshow for PokePulse presets, otherwise 50/50 random
  const useSlideshow = preset?.forceSlideshow || Math.random() > 0.5;
  const videoPath = `${runDir}/short.mp4`;

  if (useSlideshow) {
    // Slideshow: #5 → #1 countdown order for maximum drama
    const sortedCards = [...cards].sort((a, b) => b.rank - a.rank);

    // Slideshow: one card at a time
    console.log("\n━━━ Step 3: Generating slides ━━━");
    const slidePaths = await generateSlides(sortedCards, `${runDir}/slides`, {
      theme: preset?.theme || "indigo",
      title: preset?.title,
      subtitle: preset?.subtitle,
      skipPctText: true, // FFmpeg will draw animated count-up % overlay
    });

    // slideCards: null = intro title slide, then cards in sorted order
    const slideCards: Array<CardData | null> = [null, ...sortedCards];

    console.log("\n━━━ Step 4: Rendering slideshow video ━━━");
    await renderSlideshow(slidePaths, videoPath, musicPath, duration, { slideCards });
  } else {
    // Grid: all cards on one image
    console.log("\n━━━ Step 3: Generating thumbnail ━━━");
    const imagePath = `${runDir}/thumbnail.png`;
    await generateImage(cards, imagePath, {
      period: config.period,
      theme: preset?.theme || "indigo",
      title: preset?.title,
      subtitle: preset?.subtitle,
    });

    console.log("\n━━━ Step 4: Rendering video ━━━");
    await renderVideo(imagePath, videoPath, musicPath, duration);
  }

  // Step 5: Upload
  if (!skipUpload) {
    console.log("\n━━━ Step 5: Uploading to YouTube ━━━");
    const marketTrends = await fetchMarketTrends();
    const { url, title } = await uploadToYouTube(videoPath, cards, config.period, usedTitles, marketTrends);
    usedTitles.push(title);
    console.log(`\n✅ Done! Video live at: ${url}`);
  } else {
    console.log("\n━━━ Step 5: Skipped upload (--no-upload) ━━━");
    console.log(`\n✅ Done! Output in: ${runDir}/`);
    console.log(`   📊 Cards data: ${runDir}/cards.json`);
    console.log(`   🖼️  Thumbnail: ${runDir}/thumbnail.png`);
    console.log(`   🎬 Video:     ${runDir}/short.mp4`);
  }
}

// CLI
const args = process.argv.slice(2);

if (args.includes("--auth")) {
  console.log("Visit this URL to authorize YouTube uploads:\n");
  console.log(getAuthUrl());
  console.log("\nThen run: npm start -- --code YOUR_CODE");
} else if (args.includes("--code")) {
  const codeIndex = args.indexOf("--code") + 1;
  await exchangeCode(args[codeIndex]);
} else if (args.includes("--list-presets")) {
  console.log("Available presets:\n");
  for (const p of CONTENT_PRESETS) {
    console.log(`  ${p.name}`);
    console.log(`    ${p.title} — ${p.subtitle}`);
    console.log(`    ${p.direction} | ${p.period} | price: ${p.priceFilter || "all"} | top ${p.topN} | theme: ${p.theme}\n`);
  }
  console.log("Dynamic set presets (latest sets):\n");
  const setPresets = await buildSetPresets(4);
  for (const p of setPresets) {
    console.log(`  ${p.name}`);
    console.log(`    ${p.title} — ${p.subtitle}`);
    console.log(`    set: ${p.setSlug} | ${p.period} | top ${p.topN} | theme: ${p.theme}\n`);
  }
  const today = await getPresetForTodayWithSets();
  console.log(`Today's auto-pick: ${today.name}`);
} else {
  const skipUpload = args.includes("--no-upload");
  const dualMode = args.includes("--dual");

  async function resolvePreset(name?: string): Promise<ContentPreset> {
    if (name) {
      let found = CONTENT_PRESETS.find((p) => p.name === name);
      if (!found && name.startsWith("set-")) {
        const setPresets = await buildSetPresets(4);
        found = setPresets.find((p) => p.name === name);
      }
      if (!found) {
        console.error(`Unknown preset: ${name}. Run --list-presets to see options.`);
        process.exit(1);
      }
      return found;
    }
    return getPresetForToday();
  }

  async function runPreset(preset: ContentPreset) {
    const config: PipelineConfig = {
      period: preset.period,
      priceFilter: preset.priceFilter,
      topN: preset.topN,
      outputDir: "output",
      direction: preset.direction,
    };

    const periodArg = args.find((a) => a.startsWith("--period="));
    if (periodArg) config.period = periodArg.split("=")[1] as PipelineConfig["period"];
    const topArg = args.find((a) => a.startsWith("--top="));
    if (topArg) config.topN = parseInt(topArg.split("=")[1]);

    console.log("\n🎬 YouTube Shorts Pipeline");
    console.log(`   Preset: ${preset.name}`);
    console.log(`   Title:  ${preset.title}`);
    console.log(`   ${config.direction} | ${config.period} | price: ${config.priceFilter || "all"} | top ${config.topN} | theme: ${preset.theme}`);
    console.log(`   Upload: ${!skipUpload}`);

    await run(config, preset, skipUpload);
  }

  if (dualMode) {
    // Pre-fetch market trends to inform preset selection
    const marketTrends = await fetchMarketTrends();
    const marketDirection = suggestDirection(marketTrends);

    // Pick generic preset — if PokePulse says market is crashing, swap to a losers preset
    let genericPreset = getPresetForToday();
    if (marketDirection && genericPreset.direction !== marketDirection) {
      const betterFit = CONTENT_PRESETS.find((p) => p.direction === marketDirection);
      if (betterFit) {
        const summary = formatMarketSummary(marketTrends);
        console.log(`[pipeline] Market trend (${summary}) → switching to ${betterFit.name}`);
        genericPreset = betterFit;
      }
    }

    let failures = 0;

    console.log("═══ DUAL MODE: 2 videos tonight ═══");

    console.log("\n── Video 1: Generic ──");
    try {
      await runPreset(genericPreset);
    } catch (err) {
      console.error(`[pipeline] Generic video failed: ${(err as Error).message}`);
      failures++;
    }

    // Video 2: PokePulse UK market movers — 10 cards, slideshow style
    const pokepulsePreset: ContentPreset = {
      name: "pokepulse-uk-movers",
      title: "UK MARKET MOVERS",
      subtitle: "Top movers from PulseTCG UK",
      direction: "gainers",
      period: "7d",
      priceFilter: "",
      topN: 10,
      theme: "emerald",
      source: "pokepulse",
      forceSlideshow: true,
    };

    console.log(`\n── Video 2: ${pokepulsePreset.title} ──`);
    try {
      await runPreset(pokepulsePreset);
    } catch (err) {
      console.error(`[pipeline] PokePulse video failed: ${(err as Error).message}`);
      failures++;
    }

    if (failures === 2) {
      process.exit(1);
    }
  } else {
    const presetArg = args.find((a) => a.startsWith("--preset="));
    const preset = await resolvePreset(presetArg?.split("=")[1]);
    await runPreset(preset);
  }
}
