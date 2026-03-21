import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { CardData, SlideDisplayMode } from "./types.js";

// Approximate fixed exchange rates for basic currency conversion
const GBP_TO_USD = 1.27;
const GBP_TO_EUR = 1.17;
const USD_TO_GBP = 1 / GBP_TO_USD;
const USD_TO_EUR = GBP_TO_EUR / GBP_TO_USD;

/** Format a price in multiple currencies given the source currency */
function multiCurrencyPrice(price: number, sourceCurrency: string): string {
  let gbp: number, usd: number, eur: number;
  if (sourceCurrency === "£") {
    gbp = price;
    usd = price * GBP_TO_USD;
    eur = price * GBP_TO_EUR;
  } else if (sourceCurrency === "€") {
    eur = price;
    gbp = price / GBP_TO_EUR;
    usd = gbp * GBP_TO_USD;
  } else {
    // Default: USD
    usd = price;
    gbp = price * USD_TO_GBP;
    eur = price * USD_TO_EUR;
  }
  return `£${gbp.toFixed(2)} / $${usd.toFixed(2)} / €${eur.toFixed(2)}`;
}

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

function getCardTheme(card: CardData): ThemeColors {
  if (card.percentChange < 0) return THEMES.crimson;
  if (card.percentChange > 100) return THEMES.amber;
  if (card.percentChange > 30) return THEMES.emerald;
  return THEMES.indigo;
}

function drawSparkles(ctx: Ctx) {
  const stars: [number, number, number][] = [
    [80, 280, 3], [210, 140, 2], [960, 210, 4], [1010, 460, 2],
    [45, 680, 3], [140, 510, 2], [930, 590, 3], [1040, 820, 2],
    [95, 1180, 3], [310, 990, 2], [790, 1070, 4], [1000, 940, 2],
    [55, 1580, 3], [270, 1490, 2], [880, 1380, 3], [1030, 1640, 2],
    [155, 1790, 3], [895, 1720, 2], [490, 95, 3], [595, 1880, 2],
    [680, 400, 2], [380, 720, 3], [760, 1500, 2], [430, 1250, 3],
  ];
  for (const [x, y, r] of stars) {
    ctx.save();
    ctx.translate(x, y);
    const outer = r * 2.5;
    const inner = r * 0.5;
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const radius = i % 2 === 0 ? outer : inner;
      if (i === 0) ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      else ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
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
  ctx.font = `bold 68px ${F}`;
  ctx.textAlign = "center";
  ctx.fillText(title ?? "POKEMON TCG", WIDTH / 2, 115);

  // Subtitle with period
  ctx.font = `bold 46px ${F}`;
  ctx.fillStyle = theme.accent;
  ctx.fillText(subtitle ?? `TOP 5 MOVERS — ${periodLabel}`, WIDTH / 2, 175);

  // Description line
  ctx.fillStyle = theme.textMuted;
  ctx.font = `20px ${F}`;
  ctx.fillText("Pokemon TCG Price Watch", WIDTH / 2, 210);
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

  // Compute data-area font sizes up front so we can size the image region
  const nameSize = Math.round(cardWidth * 0.075);
  const priceFontSize = Math.round(cardWidth * 0.11);
  const changeSize = Math.round(cardWidth * 0.06);
  // 8 = top offset, 4 = gap after name, 4 = gap after price, 10 = bottom pad
  const dataAreaH = Math.max(115, nameSize + priceFontSize + changeSize + 26);

  // Card image — fills most of the container
  const imgPad = 10;
  const imgX = x + imgPad;
  const imgY = y + imgPad;
  const imgW = cardWidth - imgPad * 2;
  const imgH = cardHeight - dataAreaH - imgPad;

  let imageLoaded = false;
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
      imageLoaded = true;
    } catch { /* fall through to placeholder */ }
  }
  if (!imageLoaded) {
    // Placeholder: gradient panel with card name
    const grad = ctx.createLinearGradient(imgX, imgY, imgX + imgW, imgY + imgH);
    grad.addColorStop(0, theme.glass);
    grad.addColorStop(1, theme.accentGlow);
    drawRoundedRect(ctx, imgX, imgY, imgW, imgH, 10);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = theme.glassBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Card name centred in placeholder
    const nameSize = Math.max(Math.round(cardWidth * 0.07), 11);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = theme.textMuted;
    ctx.font = `${nameSize}px ${F}`;
    ctx.textAlign = "center";
    const words = card.name.split(" ");
    const lineH = nameSize + 4;
    const startTextY = imgY + imgH / 2 - ((words.length - 1) * lineH) / 2;
    for (let w = 0; w < words.length; w++) {
      ctx.fillText(words[w], imgX + imgW / 2, startTextY + w * lineH);
    }
    ctx.restore();
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

  // Data area below image: card name, price, % change + dollar change
  const centerX = x + cardWidth / 2;
  const dataStartY = y + cardHeight - dataAreaH + 8;

  // Card name — truncate if too long
  ctx.font = `bold ${nameSize}px ${F}`;
  ctx.fillStyle = theme.textWhite;
  ctx.textAlign = "center";
  let displayName = card.name;
  while (ctx.measureText(displayName).width > cardWidth - 16 && displayName.length > 8) {
    displayName = displayName.slice(0, -1);
  }
  if (displayName !== card.name) displayName += "…";
  ctx.fillText(displayName, centerX, dataStartY + nameSize);

  // Price
  const cur = card.currency || "$";
  ctx.font = `bold ${priceFontSize}px ${F}`;
  ctx.fillStyle = theme.textWhite;
  ctx.fillText(`${cur}${card.price.toFixed(2)}`, centerX, dataStartY + nameSize + priceFontSize + 4);

  // % change + dollar change on same line
  ctx.font = `bold ${changeSize}px ${F}`;
  ctx.fillStyle = changeColor;
  const pctLabel = `${isPositive ? "+" : ""}${card.percentChange.toFixed(0)}%`;
  const dollarLabel = `${isPositive ? "↑" : "↓"} ${cur}${Math.abs(card.dollarChange).toFixed(2)}`;
  const changeText = `${pctLabel}  ${dollarLabel}`;
  ctx.fillText(changeText, centerX, dataStartY + nameSize + priceFontSize + changeSize + 10);
}


export async function generateTitleSlide(
  outputPath: string,
  options: { theme?: string; title?: string; subtitle?: string } = {}
): Promise<string> {
  const theme = getTheme(options.theme);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, theme);
  drawSparkles(ctx);

  ctx.textAlign = "center";

  // Accent line
  const lineW = 80;
  ctx.fillStyle = theme.accent;
  drawRoundedRect(ctx, (WIDTH - lineW) / 2, HEIGHT * 0.27, lineW, 5, 3);
  ctx.fill();

  // Main title — auto-scale to fit within canvas (with padding)
  const titleText = options.title || "TOP MOVERS";
  const maxTitleWidth = WIDTH - 80; // 40px padding each side
  let titleSize = 100;
  ctx.font = `bold ${titleSize}px ${F}`;
  while (ctx.measureText(titleText).width > maxTitleWidth && titleSize > 40) {
    titleSize -= 4;
    ctx.font = `bold ${titleSize}px ${F}`;
  }
  ctx.fillStyle = theme.textWhite;
  ctx.fillText(titleText, WIDTH / 2, HEIGHT * 0.38);

  // Subtitle — auto-scale similarly
  const subtitleText = options.subtitle || "POKEMON TCG";
  const maxSubWidth = WIDTH - 100;
  let subSize = 54;
  ctx.font = `bold ${subSize}px ${F}`;
  while (ctx.measureText(subtitleText).width > maxSubWidth && subSize > 28) {
    subSize -= 2;
    ctx.font = `bold ${subSize}px ${F}`;
  }
  ctx.fillStyle = theme.accent;
  ctx.fillText(subtitleText, WIDTH / 2, HEIGHT * 0.46);

  // Divider
  const divW = 320;
  ctx.fillStyle = theme.glassBorder;
  drawRoundedRect(ctx, (WIDTH - divW) / 2, HEIGHT * 0.495, divW, 2, 1);
  ctx.fill();

  // Caption
  ctx.fillStyle = theme.textMuted;
  ctx.font = `26px ${F}`;
  ctx.fillText("Pokemon TCG Price Watch", WIDTH / 2, HEIGHT * 0.535);

  // Faint ghost rank behind
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = theme.gold;
  ctx.font = `bold 320px ${F}`;
  ctx.fillText("#1", WIDTH / 2, HEIGHT * 0.80);
  ctx.restore();

  // "STARTING NOW" label
  ctx.fillStyle = theme.accent;
  ctx.font = `bold 30px ${F}`;
  ctx.fillText("STARTING NOW  \u25BA", WIDTH / 2, HEIGHT * 0.885);

  await mkdir(path.dirname(outputPath), { recursive: true });
  const buffer = canvas.toBuffer("image/png");
  await writeFile(outputPath, buffer);
  console.log(`[image-gen] Generated title slide`);
  return outputPath;
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

  await mkdir(path.dirname(outputPath), { recursive: true });
  const buffer = canvas.toBuffer("image/png");
  await writeFile(outputPath, buffer);
  console.log(`[image-gen] Saved image to ${outputPath}`);
  return outputPath;
}

/**
 * Generate individual full-screen slides for each card (for slideshow video).
 * Returns array of image paths.
 *
 * @param displayMode - Controls what data is shown:
 *   - "price-and-percent": price + % gain (Videos 1 & 4)
 *   - "sales-7d": price + 7-day sales count (Video 2)
 *   - "sales-30d": price + 30-day sales count (Video 3)
 */
export async function generateSlides(
  cards: CardData[],
  outputDir: string,
  options: { theme?: string; title?: string; subtitle?: string; skipPctText?: boolean; displayMode?: SlideDisplayMode } = {}
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });

  const displayMode = options.displayMode || "price-and-percent";
  const paths: string[] = [];

  // Intro title slide first
  const titlePath = path.join(outputDir, "slide-0-title.png");
  await generateTitleSlide(titlePath, {
    theme: options.theme,
    title: options.title,
    subtitle: options.subtitle,
  });
  paths.push(titlePath);

  for (const card of cards) {
    // Dynamic theme per card based on performance
    const theme = getCardTheme(card);
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");
    const isPositive = card.percentChange >= 0;
    const changeColor = isPositive ? theme.positive : theme.negative;

    drawBackground(ctx, theme);
    drawSparkles(ctx);

    // Rank badge at top
    ctx.textAlign = "center";

    // Rank number with glow
    ctx.save();
    ctx.shadowColor = theme.gold;
    ctx.shadowBlur = 30;
    ctx.fillStyle = theme.gold;
    ctx.font = `bold 72px ${F}`;
    ctx.fillText(`#${card.rank}`, WIDTH / 2, 120);
    ctx.restore();

    ctx.fillStyle = theme.textWhite;
    ctx.font = `bold 42px ${F}`;
    ctx.fillText(options.title || "TOP MOVERS", WIDTH / 2, 175);

    // Large card image in center
    const imgW = 580;
    const imgH = 810;
    const imgX = (WIDTH - imgW) / 2;
    const imgY = 220;

    let slideImageLoaded = false;
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
        ctx.shadowBlur = 50;
        drawRoundedRect(ctx, drawX - 4, drawY - 4, drawW + 8, drawH + 8, 16);
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fill();
        ctx.restore();

        ctx.save();
        drawRoundedRect(ctx, drawX, drawY, drawW, drawH, 12);
        ctx.clip();
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
        slideImageLoaded = true;
      } catch { /* fall through to placeholder */ }
    }
    if (!slideImageLoaded) {
      // Gradient placeholder with card name
      const grad = ctx.createLinearGradient(imgX, imgY, imgX + imgW, imgY + imgH);
      grad.addColorStop(0, theme.glass);
      grad.addColorStop(1, theme.accentGlow);
      drawRoundedRect(ctx, imgX, imgY, imgW, imgH, 16);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = theme.glassBorder;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = theme.textMuted;
      ctx.font = `bold 36px ${F}`;
      ctx.textAlign = "center";
      const words = card.name.split(" ");
      const lineH = 44;
      const startY = imgY + imgH / 2 - ((words.length - 1) * lineH) / 2;
      words.forEach((w, i) => ctx.fillText(w, WIDTH / 2, startY + i * lineH));
    }

    // Data section below card — content varies by displayMode
    const dataY = imgY + imgH + 60;
    const slideCur = card.currency || "$";

    if (displayMode === "price-and-percent") {
      // Percentage — huge (skip if FFmpeg will draw it via count-up animation)
      if (!options.skipPctText) {
        ctx.fillStyle = changeColor;
        ctx.font = `bold 120px ${F}`;
        ctx.textAlign = "center";
        const pctText = `${isPositive ? "+" : ""}${card.percentChange.toFixed(0)}%`;
        ctx.fillText(pctText, WIDTH / 2, dataY + 100);
      }

      // Multi-currency price
      ctx.fillStyle = theme.textWhite;
      ctx.font = `bold 48px ${F}`;
      ctx.textAlign = "center";
      ctx.fillText(multiCurrencyPrice(card.price, slideCur), WIDTH / 2, dataY + 175);

    } else if (displayMode === "sales-7d" || displayMode === "sales-30d") {
      // Sales count — big and prominent
      const salesCount = displayMode === "sales-7d"
        ? (card.salesVolume7d ?? 0)
        : (card.salesVolume30d ?? 0);
      const salesLabel = displayMode === "sales-7d" ? "7-DAY SALES" : "30-DAY SALES";

      ctx.fillStyle = theme.accent;
      ctx.font = `bold 100px ${F}`;
      ctx.textAlign = "center";
      ctx.fillText(`${salesCount}`, WIDTH / 2, dataY + 90);

      ctx.fillStyle = theme.textMuted;
      ctx.font = `bold 32px ${F}`;
      ctx.fillText(salesLabel, WIDTH / 2, dataY + 130);

      // Multi-currency price below
      ctx.fillStyle = theme.textWhite;
      ctx.font = `bold 44px ${F}`;
      ctx.fillText(multiCurrencyPrice(card.price, slideCur), WIDTH / 2, dataY + 195);
    }

    // Card name at bottom
    ctx.fillStyle = theme.textMuted;
    ctx.font = `24px ${F}`;
    ctx.textAlign = "center";
    ctx.fillText(card.name, WIDTH / 2, HEIGHT - 110);

    // Set name below card name
    ctx.font = `20px ${F}`;
    ctx.fillText(card.setName, WIDTH / 2, HEIGHT - 80);

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
