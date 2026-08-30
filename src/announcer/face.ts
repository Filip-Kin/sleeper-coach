// The coach's face: a tiny HTTP server that streams "here is what I am about to
// say, and here is the mouth shape for every 20ms of it" to a browser page.
//
// WHY THE PAGE PLAYS ITS OWN AUDIO. The obvious design broadcasts a start
// timestamp and lets the page animate against wall-clock, which then has to be
// nudged to match Discord's jitter buffer, per viewer, forever. Instead the page
// gets the WAV itself and drives the mouth off <audio>.currentTime. One clock,
// one element, sync is exact by construction. Anyone sitting in the Discord call
// instead loads the page with ?mute=1 and gets a latency slider, because THEIR
// audio is coming down a path we do not control.
//
// Discord bots cannot send video (that is an undocumented client-side Go Live
// negotiation, and the libraries that reimplement it break constantly), so this
// page IS the video. To put it in the call, a human screen-shares the tab.
//
// SSE rather than a websocket: it is one-directional, it survives the existing
// reverse proxy with no upgrade handling, and the Bun trap is already known
// (idleTimeout: 0 plus a heartbeat, or the stream dies after 10 seconds).

import { envelopeFromWav, type Envelope } from "./envelope.ts";
import { synthesize } from "./tts.ts";

const PORT = Number(process.env.FACE_PORT ?? 8771);
const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;
// Keep a few clips addressable so a viewer who joins or reloads mid-line can
// still fetch the audio; older ones fall off. In memory because the announcer's
// /data mount is read-only and a temp dir would need its own cleanup.
const KEEP_CLIPS = 8;

type Payload = Record<string, unknown>;

export type FaceState = "idle" | "thinking" | "annoyed" | "angry" | "pleased";

const clips = new Map<string, ArrayBuffer>();
const clients = new Set<(chunk: string) => void>();
let seq = 0;
let lastEvent: string | null = null; // replayed to a client that connects late

function broadcast(event: string, data: Payload): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (event === "speak") lastEvent = frame;
  for (const send of clients) {
    try {
      send(frame);
    } catch {
      clients.delete(send); // a dead pipe must never break the speech path
    }
  }
}

// Announce a line that is ABOUT to be played into Discord. Returns the clip
// length so a caller with no voice connection can still pace itself. Never
// throws: a broken face page must not stop the bot talking.
//
// `mood` is the expression to WEAR while saying it. The mouth always comes from
// the envelope, and the brows and eyes always come from the mood, so the two are
// independent: it can scowl through a sentence without the lip sync suffering.
export function publishSpeech(text: string, wav: ArrayBuffer, mood?: FaceState): number | null {
  try {
    const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const env: Envelope = envelopeFromWav(new Uint8Array(wav));
    clips.set(id, wav);
    while (clips.size > KEEP_CLIPS) clips.delete(clips.keys().next().value as string);
    broadcast("speak", {
      id,
      url: `/audio/${id}.wav`,
      text,
      mood: mood ?? null,
      frameMs: env.frameMs,
      durationMs: env.durationMs,
      frames: env.frames,
    });
    return env.durationMs;
  } catch (err) {
    console.error(`[face] could not publish speech: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Coarse mood for the look between lines. The face decays back to idle on its
// own, so a caller never has to remember to clear one.
export function publishState(state: FaceState, detail?: string): void {
  broadcast("state", { state, detail: detail ?? "" });
}

export function startFaceServer(): void {
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 0, // SSE dies at 10s on the default; see reuse-index
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true, viewers: clients.size, clips: clips.size });
      }

      // Make the face say something on demand. This exists because there is no
      // way to rehearse otherwise: the only other trigger is a real coach event,
      // and faking one means writing to the live activity log that the draft
      // engine and the blog both read. FACE ONLY — it never reaches Discord.
      if (req.method === "POST" && url.pathname === "/say") {
        const key = process.env.ANNOUNCER_API_KEY;
        if (!key) return new Response("ANNOUNCER_API_KEY is not set; /say disabled", { status: 503 });
        if (req.headers.get("x-api-key") !== key) return new Response("forbidden", { status: 403 });
        const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return new Response('expected {"text": "..."}', { status: 400 });
        const speech = await synthesize(text);
        try {
          const durationMs = publishSpeech(text, await Bun.file(speech.path).arrayBuffer());
          return Response.json({ ok: true, durationMs, viewers: clients.size });
        } finally {
          speech.cleanup();
        }
      }

      if (url.pathname === "/events") {
        // `send` is hoisted out of start() so cancel() can remove THIS client.
        // Sweeping the whole set on a disconnect instead would leak every closed
        // stream until some later write happened to throw.
        let send: ((chunk: string) => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const drop = (): void => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          if (send) clients.delete(send);
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            send = (chunk: string): void => controller.enqueue(enc.encode(chunk));
            send(": connected\n\n");
            if (lastEvent) send(lastEvent); // late joiner catches the current line
            clients.add(send);
            // 15s comment frames: stops an intermediary buffering the stream and
            // stops the connection being reaped as idle.
            heartbeat = setInterval(() => {
              try {
                send?.(": ping\n\n");
              } catch {
                drop();
              }
            }, 15_000);
          },
          cancel: drop,
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        });
      }

      const audio = /^\/audio\/([A-Za-z0-9-]+)\.wav$/.exec(url.pathname);
      if (audio) {
        const clip = clips.get(audio[1]!);
        if (!clip) return new Response("gone", { status: 404 });
        return new Response(clip, {
          headers: { "content-type": "audio/wav", "cache-control": "no-store" },
        });
      }

      if (url.pathname === "/" || url.pathname === "/face" || url.pathname === "/index.html") {
        return new Response(Bun.file(`${PUBLIC_DIR}face.html`), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  console.log(`[face] serving the coach's face on :${server.port} (GET / , stream at /events)`);
}
