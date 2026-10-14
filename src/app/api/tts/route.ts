import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findRecordedGeorgianSpeech,
  getRecordedVoiceStatus,
} from "@/lib/recorded-tts";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const voiceSchema = z.enum([
  "ka-GE-EkaNeural",
  "ka-GE-GiorgiNeural",
]);

const postSchema = z.object({
  text: z.string().trim().min(1).max(500),
  // Kept only for backward compatibility with saved checkpoints.
  // Recorded files are selected by phrase, not by Azure voice.
  voice: voiceSchema.optional(),
});

const getSchema = z.object({
  text: z.string().trim().min(1).max(500),
  lang: z.string().trim().optional(),
  voice: voiceSchema.optional(),
  meta: z.enum(["0", "1"]).optional(),
});

function recordedAudioResponse(
  audio: Buffer,
  contentType: string,
  fileName: string
) {
  return new NextResponse(new Uint8Array(audio), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store, max-age=0",
      "X-TTS-Provider": "recorded",
      "X-TTS-Status": "ready",
      "X-TTS-Recording": fileName,
    },
  });
}

function missingRecordingResponse() {
  // Missing audio is an expected configuration state while the voice pack
  // is still being filled. 204 keeps browser Network/Console clean.
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "X-TTS-Provider": "recorded",
      "X-TTS-Status": "missing",
    },
  });
}

async function resolveRecordedSpeech(text: string) {
  return findRecordedGeorgianSpeech(text);
}

export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user || (user.role !== "admin" && !user.canUseRoutes)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const input = getSchema.parse({
      text: url.searchParams.get("text"),
      lang: url.searchParams.get("lang") ?? undefined,
      voice: url.searchParams.get("voice") ?? undefined,
      meta: url.searchParams.get("meta") ?? undefined,
    });

    if (input.lang && !input.lang.toLowerCase().startsWith("ka")) {
      return NextResponse.json(
        { error: "ამ ეტაპზე მხარდაჭერილია მხოლოდ ქართული ხმა." },
        { status: 400 }
      );
    }

    if (input.meta === "1") {
      const recorded = await getRecordedVoiceStatus(input.text);

      return NextResponse.json({
        text: input.text,
        language: "ka",
        provider: "recorded",
        recorded,
        fallback: null,
      });
    }

    const result = await resolveRecordedSpeech(input.text);

    if (!result) {
      return missingRecordingResponse();
    }

    return recordedAudioResponse(
      result.audio,
      result.contentType,
      result.fileName
    );
  } catch (error) {
    console.error("Recorded audio endpoint failed:", error);

    const message =
      error instanceof Error ? error.message : "Recorded audio request failed.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user || (user.role !== "admin" && !user.canUseRoutes)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = postSchema.parse(await request.json());
    const result = await resolveRecordedSpeech(input.text);

    if (!result) {
      return missingRecordingResponse();
    }

    return recordedAudioResponse(
      result.audio,
      result.contentType,
      result.fileName
    );
  } catch (error) {
    console.error("Recorded audio endpoint failed:", error);

    const message =
      error instanceof Error ? error.message : "Recorded audio request failed.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
