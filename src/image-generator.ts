import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { CardData } from "./types.js";

// Register bundled Inter font for consistent rendering across platforms
const fontDir = path.join(import.meta.dirname, "..", "assets", "fonts");
if (existsSync(path.join(fontDir, "Inter-Bold.ttf"))) {
  GlobalFonts.registerFromPath(path.join(fontDir, "Inter-Bold.ttf"), "Inter");
  GlobalFonts.registerFromPath(path.join(fontDir, "Inter-Regular.ttf"), "Inter");
}
const F = "Inter, sans-serif";

const WIDTH = 1080;
const HEIGHT = 1920;

interface ThemeColors {
  bgTop: string;
  bgMid: string;
  bgBottom: string;
  accent: string;
  accentGlow: string;
  positive: string;
  negative: string;
  glass: string;
  glassBorder: string;
  textWhite: string;
  textMuted: string;
  gold: string;
}

const THEMES: Record<string, ThemeColors> = {
  indigo: {
    bgTop: "#0f172a",
    bgMid: "#1e1b4b",
    bgBottom: "#0c0a1d",
    accent: "#34d399",
    accentGlow: "rgba(139, 92, 246, 0.18)",
    positive: "#34d399",
    negative: "#f87171",
    glass: "rgba(255, 255, 255, 0.06)",
    glassBorder: "rgba(255, 255, 255, 0.12)",
    textWhite: "#f8fafc",
    textMuted: "rgba(248, 250, 252, 0.5)",
    gold: "#fbbf24",
  },
  crimson: {
    bgTop: "#1a0a0a",
    bgMid: "#3b1010",
    bgBottom: "#1c1414",
    accent: "#f87171",
    accentGlow: "rgba(239, 68, 68, 0.18)",
    positive: "#34d399",
    negative: "#f87171",
    glass: "rgba(255, 255, 255, 0.06)",
    glassBorder: "rgba(255, 255, 255, 0.12)",
    textWhite: "#f8fafc",
    textMuted: "rgba(248, 250, 252, 0.5)",
    gold: "#fbbf24",
  },
  emerald: {
    bgTop: "#052e16",
    bgMid: "#064e3b",
    bgBottom: "#021a0e",
    accent: "#34d399",
    accentGlow: "rgba(20, 184, 166, 0.18)",
    positive: "#34d399",
    negative: "#f87171",
    glass: "rgba(255, 255, 255, 0.06)",
    glassBorder: "rgba(255, 255, 255, 0.12)",
    textWhite: "#f8fafc",
    textMuted: "rgba(248, 250, 252, 0.5)",
    gold: "#fbbf24",
  },
  amber: {
    bgTop: "#1c1507",
    bgMid: "#451a03",
    bgBottom: "#1a1008",
    accent: "#fbbf24",
    accentGlow: "rgba(251, 191, 36, 0.18)",
    positive: "#34d399",
    negative: "#f87171",
    glass: "rgba(255, 255, 255, 0.06)",
    glassBorder: "rgba(255, 255, 255, 0.12)",
    textWhite: "#f8fafc",
    textMuted: "rgba(248, 250, 252, 0.5)",
    gold: "#fbbf24",
  },
};

function getTheme(name?: string): ThemeColors {
  return THEMES[name ?? "indigo"] ?? THEMES.indigo;
}

type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]> extends infer T ? T : never;

function drawRoundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBackground(ctx: Ctx, theme: ThemeColors) {
  // Rich gradient
  const gradient = ctx.createLinearGradient(0, 0, WIDTH * 0.3, HEIGHT);
  gradient.addColorStop(0, theme.bgTop);
  gradient.addColorStop(0.4, theme.bgMid);
  gradient.addColorStop(1, theme.bgBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Warm glow top-right
  const glow1 = ctx.createRadialGradient(WIDTH * 0.85, HEIGHT * 0.15, 0, WIDTH * 0.85, HEIGHT * 0.15, WIDTH * 0.6);
  glow1.addColorStop(0, theme.accentGlow);
  glow1.addColorStop(1, "transparent");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Accent glow bottom-left
  const glow2 = ctx.createRadialGradient(WIDTH * 0.15, HEIGHT * 0.75, 0, WIDTH * 0.15, HEIGHT * 0.75, WIDTH * 0.5);
  glow2.addColorStop(0, theme.accentGlow.replace(/[\d.]+\)$/, "0.10)"));
  glow2.addColorStop(1, "transparent");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle grid overlay
  ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
  ctx.lineWidth = 1;
  const gridSize = 60;
  for (let x = 0; x <= WIDTH; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= HEIGHT; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }

  // Decorative diagonal accent lines
  ctx.strokeStyle = theme.accentGlow.replace(/[\d.]+\)$/, "0.08)");
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT * 0.3);
  ctx.lineTo(WIDTH, HEIGHT * 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT * 0.9);
  ctx.lineTo(WIDTH, HEIGHT * 0.7);
  ctx.stroke();
}

function drawTitle(ctx: Ctx, theme: ThemeColors, period: string, title?: string, subtitle?: string) {
  const periodLabel =
    period === "24h" ? "24 HOURS"
      : period === "7d" ? "THIS WEEK"
        : period === "30d" ? "THIS MONTH"
          : "90 DAYS";

  // Accent line above title
  const lineW = 60;
  ctx.fillStyle = theme.accent;
  drawRoundedRect(ctx, (WIDTH - lineW) / 2, 48, lineW, 4, 2);
  ctx.fill();

  // Main title
  ctx.fillStyle = theme.textWhite;
  ctx.font = `bold 56px ${F}`;
  ctx.textAlign = "center";
  ctx.fillText(title ?? "POKEMON TCG", WIDTH / 2, 110);

  // Subtitle with period
  ctx.font = `bold 42px ${F}`;
  ctx.fillStyle = theme.accent;
  ctx.fillText(subtitle ?? `TOP 5 MOVERS — ${periodLabel}`, WIDTH / 2, 165);

  // Description line
  ctx.fillStyle = theme.textMuted;
  ctx.font = `20px ${F}`;
  ctx.fillText("Biggest price gainers · $100+ singles · TCGPlayer", WIDTH / 2, 200);
}

async function drawCard(
  ctx: Ctx,
  card: CardData,
  x: number,
  y: number,
  cardWidth: number,
  cardHeight: number,
  theme: ThemeColors
) {
  const isPositive = card.percentChange >= 0;
  const changeColor = isPositive ? theme.positive : theme.negative;

  // Glass card container
  drawRoundedRect(ctx, x, y, cardWidth, cardHeight, 16);
  ctx.fillStyle = theme.glass;
  ctx.fill();
  ctx.strokeStyle = theme.glassBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Card image — fills most of the container
  const imgPad = 10;
  const imgX = x + imgPad;
  const imgY = y + imgPad;
  const imgW = cardWidth - imgPad * 2;
  const dataAreaH = 90;
  const imgH = cardHeight - dataAreaH - imgPad;

  if (card.imageUrl) {
    try {
      const img = await loadImage(card.imageUrl);
      const scale = Math.min(imgW / img.width, imgH / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const drawX = imgX + (imgW - drawW) / 2;
      const drawY = imgY + (imgH - drawH) / 2;

      ctx.save();
      drawRoundedRect(ctx, imgX, imgY, imgW, imgH, 10);
      ctx.clip();
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.restore();
    } catch {
      drawRoundedRect(ctx, imgX, imgY, imgW, imgH, 10);
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fill();
    }
  }

  // Rank badge — top-left corner, overlaid on image
  const rankSize = Math.round(cardWidth * 0.09);
  const rankPadX = 8;
  const rankPadY = 4;
  const rankText = `#${card.rank}`;
  ctx.font = `bold ${rankSize}px ${F}`;
  const rankW = ctx.measureText(rankText).width + rankPadX * 2;
  const rankH = rankSize + rankPadY * 2;
  const rankX = imgX + 6;
  const rankY = imgY + 6;

  drawRoundedRect(ctx, rankX, rankY, rankW, rankH, 8);
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fill();
  ctx.fillStyle = theme.gold;
  ctx.font = `bold ${rankSize}px ${F}`;
  ctx.textAlign = "left";
  ctx.fillText(rankText, rankX + rankPadX, rankY + rankSize + rankPadY - 4);

  // Percentage badge — top-right corner, overlaid on image
  const pctSize = Math.round(cardWidth * 0.1);
  const pctText = `${isPositive ? "+" : ""}${card.percentChange.toFixed(0)}%`;
  ctx.font = `bold ${pctSize}px ${F}`;
  const pctW = ctx.measureText(pctText).width + 16;
  const pctH = pctSize + 10;
  const pctX = imgX + imgW - pctW - 6;
  const pctY = imgY + 6;

  drawRoundedRect(ctx, pctX, pctY, pctW, pctH, 8);
  ctx.fillStyle = isPositive ? "rgba(6, 78, 59, 0.85)" : "rgba(127, 29, 29, 0.85)";
  ctx.fill();
  ctx.fillStyle = changeColor;
  ctx.font = `bold ${pctSize}px ${F}`;
  ctx.textAlign = "center";
  ctx.fillText(pctText, pctX + pctW / 2, pctY + pctSize + 2);

  // Price — below the image, centered in the data area
  const priceY = y + cardHeight - dataAreaH / 2;
  const priceFontSize = Math.round(cardWidth * 0.12);
  ctx.font = `bold ${priceFontSize}px ${F}`;
  ctx.fillStyle = theme.textWhite;
  ctx.textAlign = "center";
  ctx.fillText(`$${card.price.toFixed(2)}`, x + cardWidth / 2, priceY + priceFontSize / 3);

  // Dollar change — small, muted, below price
  const dollarSize = Math.round(cardWidth * 0.065);
  ctx.font = `${dollarSize}px ${F}`;
  ctx.fillStyle = changeColor;
  const dollarText = `${isPositive ? "↑" : "↓"} $${Math.abs(card.dollarChange).toFixed(2)}`;
  ctx.fillText(dollarText, x + cardWidth / 2, priceY + priceFontSize / 3 + dollarSize + 6);
}

function drawFooter(ctx: Ctx, theme: ThemeColors) {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Divider line
  const divW = 200;
  ctx.fillStyle = theme.glassBorder;
  drawRoundedRect(ctx, (WIDTH - divW) / 2, HEIGHT - 130, divW, 2, 1);
  ctx.fill();

  ctx.textAlign = "center";

  ctx.fillStyle = theme.textMuted;
  ctx.font = `18px ${F}`;
  ctx.fillText(`tcgmarketnews.com · ${dateStr}`, WIDTH / 2, HEIGHT - 90);

  ctx.fillStyle = theme.textWhite;
  ctx.font = `bold 24px ${F}`;
  ctx.fillText("@YourChannel", WIDTH / 2, HEIGHT - 55);
}

export async function generateImage(
  cards: CardData[],
  outputPath: string,
  options: {
    period?: string;
    theme?: string;
    title?: string;
    subtitle?: string;
  } = {}
): Promise<string> {
  const { period = "30d", theme: themeName, title, subtitle } = options;
  const theme = getTheme(themeName);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, theme);
  drawTitle(ctx, theme, period, title, subtitle);

  const margin = 24;
  const gap = 16;
  const startY = 230;

  if (cards.length > 5) {
    // 10-card layout: rows of 2, 3, 3, 2
    const row1 = cards.slice(0, 2);
    const row2 = cards.slice(2, 5);
    const row3 = cards.slice(5, 8);
    const row4 = cards.slice(8, 10);

    const row1CardW = (WIDTH - margin * 2 - gap) / 2;
    const row1CardH = 430;

    for (let i = 0; i < row1.length; i++) {
      const x = margin + i * (row1CardW + gap);
      await drawCard(ctx, row1[i], x, startY, row1CardW, row1CardH, theme);
    }

    const row2Y = startY + row1CardH + gap;
    const row23CardW = (WIDTH - margin * 2 - gap * 2) / 3;
    const row23CardH = 380;

    for (let i = 0; i < row2.length; i++) {
      const x = margin + i * (row23CardW + gap);
      await drawCard(ctx, row2[i], x, row2Y, row23CardW, row23CardH, theme);
    }

    const row3Y = row2Y + row23CardH + gap;

    for (let i = 0; i < row3.length; i++) {
      const x = margin + i * (row23CardW + gap);
      await drawCard(ctx, row3[i], x, row3Y, row23CardW, row23CardH, theme);
    }

    if (row4.length > 0) {
      const row4Y = row3Y + row23CardH + gap;
      const row4CardW = (WIDTH - margin * 2 - gap) / 2;
      const row4CardH = 380;

      for (let i = 0; i < row4.length; i++) {
        const x = margin + i * (row4CardW + gap);
        await drawCard(ctx, row4[i], x, row4Y, row4CardW, row4CardH, theme);
      }
    }
  } else {
    // 5-card layout: rows of 2, 3
    const topCards = cards.slice(0, 2);
    const topCardWidth = (WIDTH - margin * 2 - gap) / 2;
    const topCardHeight = 620;

    for (let i = 0; i < topCards.length; i++) {
      const x = margin + i * (topCardWidth + gap);
      await drawCard(ctx, topCards[i], x, startY, topCardWidth, topCardHeight, theme);
    }

    const bottomCards = cards.slice(2, 5);
    const bottomY = startY + topCardHeight + gap;
    const bottomCardWidth = (WIDTH - margin * 2 - gap * 2) / 3;
    const bottomCardHeight = 520;

    for (let i = 0; i < bottomCards.length; i++) {
      const x = margin + i * (bottomCardWidth + gap);
      await drawCard(ctx, bottomCards[i], x, bottomY, bottomCardWidth, bottomCardHeight, theme);
    }
  }

  drawFooter(ctx, theme);

  await mkdir(path.dirname(outputPath), { recursive: true });
  const buffer = canvas.toBuffer("image/png");
  await writeFile(outputPath, buffer);
  console.log(`[image-gen] Saved image to ${outputPath}`);
  return outputPath;
}

/**
 * Generate individual full-screen slides for each card (for slideshow video).
 * Returns array of image paths.
 */
export async function generateSlides(
  cards: CardData[],
  outputDir: string,
  options: { theme?: string; title?: string } = {}
): Promise<string[]> {
  const theme = THEMES[options.theme || "indigo"] || THEMES.indigo;
  await mkdir(outputDir, { recursive: true });

  const paths: string[] = [];

  for (const card of cards) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");
    const isPositive = card.percentChange >= 0;
    const changeColor = isPositive ? theme.positive : theme.negative;

    // Background
    drawBackground(ctx, theme);

    // Rank + title at top
    ctx.fillStyle = theme.gold;
    ctx.font = `bold 72px ${F}`;
    ctx.textAlign = "center";
    ctx.fillText(`#${card.rank}`, WIDTH / 2, 120);

    ctx.fillStyle = theme.textWhite;
    ctx.font = `bold 36px ${F}`;
    ctx.fillText(options.title || "TOP MOVERS", WIDTH / 2, 175);

    // Large card image in center
    const imgW = 580;
    const imgH = 810;
    const imgX = (WIDTH - imgW) / 2;
    const imgY = 220;

    if (card.imageUrl) {
      try {
        const img = await loadImage(card.imageUrl);
        const scale = Math.min(imgW / img.width, imgH / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const drawX = imgX + (imgW - drawW) / 2;
        const drawY = imgY + (imgH - drawH) / 2;

        // Card glow
        ctx.save();
        ctx.shadowColor = isPositive ? theme.accentGlow : "rgba(248, 113, 113, 0.3)";
        ctx.shadowBlur = 40;
        drawRoundedRect(ctx, drawX - 4, drawY - 4, drawW + 8, drawH + 8, 16);
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fill();
        ctx.restore();

        ctx.save();
        drawRoundedRect(ctx, drawX, drawY, drawW, drawH, 12);
        ctx.clip();
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
      } catch {
        // placeholder
      }
    }

    // Price section below card
    const dataY = imgY + imgH + 60;

    // Percentage — huge
    ctx.fillStyle = changeColor;
    ctx.font = `bold 120px ${F}`;
    ctx.textAlign = "center";
    const pctText = `${isPositive ? "+" : ""}${card.percentChange.toFixed(0)}%`;
    ctx.fillText(pctText, WIDTH / 2, dataY + 100);

    // Price
    ctx.fillStyle = theme.textWhite;
    ctx.font = `bold 64px ${F}`;
    ctx.fillText(`$${card.price.toFixed(2)}`, WIDTH / 2, dataY + 185);

    // Dollar change
    ctx.fillStyle = changeColor;
    ctx.font = `36px ${F}`;
    const dollarText = `${isPositive ? "↑" : "↓"} $${Math.abs(card.dollarChange).toFixed(2)}`;
    ctx.fillText(dollarText, WIDTH / 2, dataY + 235);

    // Card name + set at bottom
    ctx.fillStyle = theme.textWhite;
    ctx.font = `bold 32px ${F}`;
    ctx.fillText(card.name, WIDTH / 2, HEIGHT - 140);

    ctx.fillStyle = theme.textMuted;
    ctx.font = `22px ${F}`;
    ctx.fillText(card.setName, WIDTH / 2, HEIGHT - 100);

    const slidePath = path.join(outputDir, `slide-${card.rank}.png`);
    await writeFile(slidePath, canvas.toBuffer("image/png"));
    paths.push(slidePath);
    console.log(`[image-gen] Generated slide ${card.rank}: ${card.name}`);
  }

  return paths;
}

// CLI entry point
if (process.argv[1]?.includes("image-generator")) {
  const cardsPath = process.argv[2] || "output/cards.json";
  const data = JSON.parse(await readFile(cardsPath, "utf-8")) as CardData[];
  const themeName = process.argv[3] || "indigo";
  await generateImage(data, "output/thumbnail.png", { period: "30d", theme: themeName });
}
