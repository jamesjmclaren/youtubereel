import { execFile } from "child_process";
import { promisify } from "util";
import { access, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { CardData, SlideDisplayMode } from "./types.js";

const execFileAsync = promisify(execFile);

/** Calculate video duration from card count: 3 seconds per card (5 cards = 15s, 10 cards = 30s) */
export function videoDuration(cardCount: number): number {
  return cardCount * 3;
}
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

async function checkFfmpeg(): Promise<string> {
  for (const bin of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      await execFileAsync(bin, ["-version"]);
      return bin;
    } catch {
      continue;
    }
  }
  throw new Error(
    "FFmpeg not found. Install it with: brew install ffmpeg"
  );
}

export async function renderVideo(
  imagePath: string,
  outputPath: string,
  musicPath?: string,
  duration?: number
): Promise<string> {
  const ffmpeg = await checkFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });

  const DURATION = duration ?? 15;

  // Slow zoom (Ken Burns) effect so the Short doesn't feel static
  // zoompan: slowly zoom from 1.0x to 1.08x over the duration
  const totalFrames = DURATION * FPS;
  const zoomFilter = [
    `zoompan=z='1+0.08*in/${totalFrames}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    `fade=t=in:st=0:d=0.5`,
    `fade=t=out:st=${DURATION - 0.5}:d=0.5`,
  ].join(",");

  // Build input args first, then filters, then output
  const inputArgs: string[] = [
    "-y",
    "-loop", "1",
    "-i", imagePath,
  ];

  let hasMusic = false;
  if (musicPath) {
    try {
      await access(musicPath);
      inputArgs.push("-i", musicPath);
      hasMusic = true;
    } catch {
      console.warn(`[video] Music file not found: ${musicPath}, rendering without music`);
    }
  }

  if (!hasMusic) {
    // Silent audio track must be declared as input before filters
    inputArgs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  }

  const outputArgs: string[] = [
    "-vf", zoomFilter,
    "-c:v", "libx264",
    "-t", String(DURATION),
    "-pix_fmt", "yuv420p",
    "-preset", "medium",
    "-crf", "18",
  ];

  if (hasMusic) {
    outputArgs.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${DURATION - 1}:d=1`,
      "-shortest",
    );
  } else {
    outputArgs.push(
      "-c:a", "aac",
      "-shortest",
    );
  }

  outputArgs.push(outputPath);

  const args = [...inputArgs, ...outputArgs];

  console.log(`[video] Rendering ${DURATION}s video...`);
  console.log(`[video] Command: ${ffmpeg} ${args.join(" ")}`);

  try {
    const { stderr } = await execFileAsync(ffmpeg, args, {
      timeout: 120_000,
    });
    if (stderr) console.log(`[video] FFmpeg output: ${stderr.slice(-500)}`);
    console.log(`[video] Saved video to ${outputPath}`);
    return outputPath;
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    console.error(`[video] FFmpeg error:`, error.stderr || error.message);
    throw error;
  }
}

// Transitions that cycle between card slides
const CARD_TRANSITIONS = ["slideleft", "wipeleft", "smoothleft", "slideright", "wiperight"];

/**
 * Render a cinematic slideshow video from individual slide images.
 *
 * Features (when slideCards is provided):
 * - xfade transitions between slides (varied, dramatic zoomin for the #1 reveal)
 * - Count-up % animation via FFmpeg drawtext per card slide
 * - Scrolling price ticker at bottom
 * - Bass "boom" sound at the #1 card reveal
 */
export async function renderSlideshow(
  slidePaths: string[],
  outputPath: string,
  musicPath?: string,
  duration?: number,
  options?: { slideCards?: Array<CardData | null>; displayMode?: SlideDisplayMode }
): Promise<string> {
  const ffmpeg = await checkFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });

  const slideCards = options?.slideCards ?? null;
  const displayMode = options?.displayMode ?? "price-and-percent";
  const N = slidePaths.length;

  // Determine per-slide durations
  const INTRO_DUR = 2;
  const FADE = 0.4;
  const hasIntro = slideCards !== null && slideCards.length > 0 && slideCards[0] === null;
  const cardCount = N - (hasIntro ? 1 : 0);
  const slideDur = Math.ceil((duration ?? videoDuration(cardCount)) / Math.max(cardCount, 1));

  const durations = slidePaths.map((_, i) =>
    (slideCards && slideCards[i] === null) ? INTRO_DUR : slideDur
  );

  // Pre-compute xfade offsets and total duration
  // offset[i] = start of transition i→(i+1) in the accumulated output timeline
  const xfadeOffsets: number[] = [];
  let accDur = durations[0];
  for (let i = 0; i < N - 1; i++) {
    xfadeOffsets.push(accDur - FADE);
    accDur += durations[i + 1] - FADE;
  }
  const totalDuration = accDur;

  // Time at which the #1 card (last slide) becomes fully visible
  const lastRevealTime = xfadeOffsets.length > 0
    ? xfadeOffsets[xfadeOffsets.length - 1] + FADE
    : 0;
  const boomDelayMs = Math.round(lastRevealTime * 1000);

  // Font file for drawtext count-up
  const fontFile = path.resolve("assets/fonts/Inter-Bold.ttf");
  const hasFontFile = existsSync(fontFile);
  const fontArg = hasFontFile ? `:fontfile=${fontFile.replace(/ /g, "\\ ")}` : "";

  // --- INPUT ARGS ---
  const inputArgs: string[] = ["-y"];
  // Image inputs — each looped slightly longer than needed so xfade has overlap material
  for (let i = 0; i < N; i++) {
    inputArgs.push("-loop", "1", "-t", String(durations[i] + FADE + 0.1), "-i", slidePaths[i]);
  }

  const musicInputIdx = N;
  let hasMusic = false;
  if (musicPath) {
    try {
      await access(musicPath);
      inputArgs.push("-i", musicPath);
      hasMusic = true;
    } catch {
      console.warn(`[video] Music file not found: ${musicPath}, rendering without music`);
    }
  }
  if (!hasMusic) {
    inputArgs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  }

  // Bass boom input for #1 reveal — decaying sine at 80 Hz
  const boomInputIdx = musicInputIdx + 1;
  inputArgs.push(
    "-f", "lavfi",
    "-i", "aevalsrc=0.4*sin(2*PI*80*t)*exp(-2*t):duration=1.5:sample_rate=44100",
  );

  // --- FILTER COMPLEX ---
  const filterParts: string[] = [];

  // 1. Prep each stream: scale, fps, optional count-up drawtext
  for (let i = 0; i < N; i++) {
    const card = slideCards?.[i] ?? null;
    let prep = `[${i}:v]scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=${FPS},setpts=PTS-STARTPTS`;

    if (card !== null && displayMode === "price-and-percent") {
      const pct = Math.round(Math.abs(card.percentChange));
      const isPos = card.percentChange >= 0;
      const sign = isPos ? "+" : "-";
      const color = isPos ? "0x34d399FF" : "0xf87171FF";
      const dur = durations[i];
      // Count-up: floor(pct * min(1, t/dur)) — integer steps, holds at pct when t >= dur
      const countExpr = `floor(${pct}*min(1\\,t/${dur}))`;
      const textVal = `${sign}%{eif\\:${countExpr}\\:d\\:0}%%`;
      prep += `,drawtext=x=(w-tw)/2:y=1065:fontsize=115:fontcolor=${color}${fontArg}:text='${textVal}'`;
    }

    filterParts.push(`${prep}[v${i}]`);
  }

  // 2. Xfade chain
  let lastVideoLabel = "v0";
  for (let i = 0; i < N - 1; i++) {
    const outputLabel = i === N - 2 ? "xchain" : `xf${i}`;
    const offset = xfadeOffsets[i];
    let transition: string;
    if (i === 0) {
      transition = "fade"; // intro → first card: smooth
    } else if (i === N - 2) {
      transition = "zoomin"; // → #1 card: dramatic
    } else {
      transition = CARD_TRANSITIONS[(i - 1) % CARD_TRANSITIONS.length];
    }
    filterParts.push(
      `[${lastVideoLabel}][v${i + 1}]xfade=transition=${transition}:duration=${FADE}:offset=${offset.toFixed(3)}[${outputLabel}]`
    );
    lastVideoLabel = outputLabel;
  }

  // 3. Overall fade in/out
  filterParts.push(
    `[${lastVideoLabel}]fade=t=in:st=0:d=0.5,fade=t=out:st=${(totalDuration - 0.5).toFixed(3)}:d=0.5[faded]`
  );

  // 4. Scrolling price ticker at bottom
  let tickerLabel = "faded";
  if (slideCards !== null) {
    const cardSlides = slideCards.filter((c): c is CardData => c !== null);
    if (cardSlides.length > 0) {
      const tickerItems = cardSlides.map(c => {
        const cur = c.currency || "$";
        if (displayMode === "sales-7d") {
          return `#${c.rank}  ${c.salesVolume7d ?? 0} sold  ${cur}${c.price.toFixed(2)}`;
        } else if (displayMode === "sales-30d") {
          return `#${c.rank}  ${c.salesVolume30d ?? 0} sold  ${cur}${c.price.toFixed(2)}`;
        }
        const sign = c.percentChange >= 0 ? "+" : "";
        return `#${c.rank}  ${sign}${c.percentChange.toFixed(0)}%%  ${cur}${c.price.toFixed(2)}`;
      });
      const tickerText = tickerItems.join("   *   ") + "   *   ";
      filterParts.push(
        `[faded]drawtext=x=w-mod(t*220\\,w+tw):y=h-68:fontsize=28:fontcolor=white@0.9:box=1:boxcolor=black@0.55:boxborderw=14${fontArg}:text='${tickerText}'[tickered]`
      );
      tickerLabel = "tickered";
    }
  }

  // 5. Audio: music + bass boom at #1 reveal
  if (hasMusic) {
    filterParts.push(
      `[${musicInputIdx}:a]afade=t=in:st=0:d=1,afade=t=out:st=${(totalDuration - 1).toFixed(3)}:d=1,volume=0.85[music_faded]`
    );
  } else {
    filterParts.push(`[${musicInputIdx}:a]aformat=channel_layouts=stereo[music_faded]`);
  }
  filterParts.push(
    `[${boomInputIdx}:a]aformat=channel_layouts=stereo,adelay=${boomDelayMs}|${boomDelayMs},volume=0.6[boom]`
  );
  filterParts.push(
    `[music_faded][boom]amix=inputs=2:normalize=0:duration=longest[audio_out]`
  );

  // --- OUTPUT ARGS ---
  const outputArgs: string[] = [
    "-filter_complex", filterParts.join(";\n"),
    "-map", `[${tickerLabel}]`,
    "-map", "[audio_out]",
    "-c:v", "libx264",
    "-t", totalDuration.toFixed(3),
    "-pix_fmt", "yuv420p",
    "-preset", "medium",
    "-crf", "18",
    "-r", String(FPS),
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ];

  const args = [...inputArgs, ...outputArgs];

  console.log(`[video] Rendering cinematic slideshow (${N} slides, ~${totalDuration.toFixed(1)}s)...`);

  try {
    const { stderr } = await execFileAsync(ffmpeg, args, { timeout: 180_000 });
    if (stderr) console.log(`[video] FFmpeg output: ${stderr.slice(-800)}`);
    console.log(`[video] Saved slideshow to ${outputPath}`);
    return outputPath;
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    console.error(`[video] FFmpeg error:`, error.stderr?.slice(-1000) || error.message);
    throw error;
  }
}

// CLI entry point
if (process.argv[1]?.includes("video-renderer")) {
  const imagePath = process.argv[2] || "output/thumbnail.png";
  const musicPath = process.argv[3] || "assets/music.mp3";
  await renderVideo(imagePath, "output/short.mp4", musicPath);
}
