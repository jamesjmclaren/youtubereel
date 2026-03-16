import { execFile } from "child_process";
import { promisify } from "util";
import { access, mkdir, writeFile } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

const DURATION = 10; // seconds
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
  musicPath?: string
): Promise<string> {
  const ffmpeg = await checkFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });

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

/**
 * Render a slideshow video from individual slide images.
 * Each slide shows for (duration / slides) seconds with crossfade transitions.
 */
export async function renderSlideshow(
  slidePaths: string[],
  outputPath: string,
  musicPath?: string
): Promise<string> {
  const ffmpeg = await checkFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });

  const slideCount = slidePaths.length;
  const slideDuration = DURATION / slideCount; // 2s each for 5 cards
  const fadeLen = 0.4;

  // Build FFmpeg concat with crossfade
  // Create a concat file listing each image with its duration
  const concatDir = path.dirname(outputPath);
  const concatFile = path.join(concatDir, "slides.txt");
  const lines = slidePaths.map((p) => `file '${path.resolve(p)}'\nduration ${slideDuration}`);
  // FFmpeg concat demuxer needs the last file listed again
  lines.push(`file '${path.resolve(slidePaths[slidePaths.length - 1])}'`);
  await writeFile(concatFile, lines.join("\n"));

  const inputArgs: string[] = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
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
    inputArgs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  }

  const vf = [
    `scale=${WIDTH}:${HEIGHT}`,
    `fade=t=in:st=0:d=${fadeLen}`,
    `fade=t=out:st=${DURATION - fadeLen}:d=${fadeLen}`,
  ].join(",");

  const outputArgs: string[] = [
    "-vf", vf,
    "-c:v", "libx264",
    "-t", String(DURATION),
    "-pix_fmt", "yuv420p",
    "-preset", "medium",
    "-crf", "18",
    "-vsync", "cfr",
    "-r", String(FPS),
  ];

  if (hasMusic) {
    outputArgs.push(
      "-c:a", "aac", "-b:a", "192k",
      "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${DURATION - 1}:d=1`,
      "-shortest",
    );
  } else {
    outputArgs.push("-c:a", "aac", "-shortest");
  }

  outputArgs.push(outputPath);
  const args = [...inputArgs, ...outputArgs];

  console.log(`[video] Rendering slideshow (${slideCount} slides, ${slideDuration}s each)...`);

  try {
    const { stderr } = await execFileAsync(ffmpeg, args, { timeout: 120_000 });
    if (stderr) console.log(`[video] FFmpeg output: ${stderr.slice(-500)}`);
    console.log(`[video] Saved slideshow to ${outputPath}`);
    return outputPath;
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    console.error(`[video] FFmpeg error:`, error.stderr || error.message);
    throw error;
  }
}

// CLI entry point
if (process.argv[1]?.includes("video-renderer")) {
  const imagePath = process.argv[2] || "output/thumbnail.png";
  const musicPath = process.argv[3] || "assets/music.mp3";
  await renderVideo(imagePath, "output/short.mp4", musicPath);
}
