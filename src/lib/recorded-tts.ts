import "server-only";

import { promises as fs } from "fs";
import path from "path";

type RecordedVoiceManifest = {
  version?: number;
  phrases?: Record<string, string>;
};

export type RecordedSpeech = {
  audio: Buffer;
  contentType: string;
  fileName: string;
  phrase: string;
};

const AUDIO_ROOT = path.join(
  process.cwd(),
  "data",
  "private",
  "audio",
  "recorded"
);

const MANIFEST_PATH = path.join(AUDIO_ROOT, "manifest.json");

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("ka-GE")
    .replace(/[„“"'.…,:;!?()[\]{}\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTypeFor(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".m4a" || extension === ".aac") return "audio/mp4";
  return "audio/mpeg";
}

async function readManifest(): Promise<RecordedVoiceManifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(raw) as RecordedVoiceManifest;
  } catch {
    return { phrases: {} };
  }
}

export async function findRecordedGeorgianSpeech(
  text: string
): Promise<RecordedSpeech | null> {
  const clean = text.trim();
  if (!clean) return null;

  const manifest = await readManifest();
  const phrases = manifest.phrases ?? {};
  const wanted = normalizeText(clean);

  const entry = Object.entries(phrases).find(
    ([phrase]) => normalizeText(phrase) === wanted
  );

  if (!entry) return null;

  const [phrase, configuredFileName] = entry;
  const safeFileName = path.basename(configuredFileName);

  if (!safeFileName || safeFileName !== configuredFileName) {
    return null;
  }

  const filePath = path.join(AUDIO_ROOT, safeFileName);

  try {
    const audio = await fs.readFile(filePath);

    return {
      audio,
      contentType: contentTypeFor(safeFileName),
      fileName: safeFileName,
      phrase,
    };
  } catch {
    return null;
  }
}

export async function getRecordedVoiceStatus(text: string) {
  const result = await findRecordedGeorgianSpeech(text);

  return result
    ? {
        available: true,
        provider: "recorded" as const,
        fileName: result.fileName,
        phrase: result.phrase,
      }
    : {
        available: false,
        provider: null,
        fileName: null,
        phrase: null,
      };
}
