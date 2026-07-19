import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "./config";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

// Voice notes are short; if ffmpeg or whisper wedges, fail the transcription rather than
// stalling the whole message pipeline.
const STEP_TIMEOUT_MS = 3 * 60 * 1000;

/** Whether local speech-to-text is available (whisper.cpp binary + model configured). */
export function transcriptionEnabled(): boolean {
  return Boolean(config.whisper.bin && config.whisper.model);
}

/**
 * Transcribes an audio file (e.g. a WhatsApp .ogg voice note) using local whisper.cpp.
 * Returns the transcript text, or null if transcription is unavailable or fails - callers
 * fall back to treating the message as an opaque audio file.
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  if (!transcriptionEnabled()) return null;

  // whisper.cpp wants 16kHz mono WAV; WhatsApp sends ogg/opus. ffmpeg converts anything.
  const wavPath = `${audioPath}.wav`;
  try {
    await execFileAsync(
      "ffmpeg",
      ["-nostdin", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
      { timeout: STEP_TIMEOUT_MS }
    );

    // -nt: no timestamps, plain text on stdout. -l auto: detect language (handles Hindi/English mixing).
    const { stdout } = await execFileAsync(
      config.whisper.bin,
      ["-m", config.whisper.model, "-f", wavPath, "-nt", "-l", "auto", "--no-prints"],
      { timeout: STEP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );

    const text = stdout.replace(/\s+/g, " ").trim();
    if (!text) return null;
    log("transcription_done", { audioPath, chars: text.length });
    return text;
  } catch (err) {
    log("transcription_failed", { audioPath, error: String(err).slice(0, 500) });
    return null;
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* never created, or already gone */
    }
  }
}
