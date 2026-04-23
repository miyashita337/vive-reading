import { getMessages, insertMessage, updateFilteredText, type Message } from "./db";
import { join } from "path";
import { filterForTts } from "../../filter/filter";

const PORT = 3456;
const CLIENT_DIR = join(import.meta.dir, "../../client");
const TTS_URL = process.env.TTS_URL ?? "http://localhost:8000/tts";

// Track active TTS playback
let activePlayback: { fromId: number; aborted: boolean } | null = null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Call TTS FastAPI server to synthesize speech.
 * Returns WAV audio bytes, or null on failure.
 */
async function synthesize(text: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`[TTS] HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    return await res.arrayBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TTS] request failed: ${msg}`);
    return null;
  }
}

/**
 * Get filtered text for a message. Runs LLM filter on demand
 * and caches the result in the database.
 */
async function getFilteredText(msg: Message): Promise<string> {
  if (msg.filtered_text) return msg.filtered_text;
  const filtered = await filterForTts(msg.content);
  updateFilteredText(msg.id, filtered);
  return filtered;
}

const server = Bun.serve({
  port: PORT,
  // Long audio synthesis can take tens of seconds on MPS (RTF ~2.88x).
  // Raise the per-request idle timeout to accommodate long-form TTS.
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // REST API
    if (url.pathname === "/api/messages" && req.method === "GET") {
      const fromId = url.searchParams.get("from_id");
      const messages = getMessages(fromId ? Number(fromId) : undefined);
      return Response.json(messages, { headers: corsHeaders });
    }

    if (url.pathname === "/api/play" && req.method === "POST") {
      const body = (await req.json()) as { from_id: number };
      if (!body.from_id) {
        return Response.json(
          { error: "from_id required" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (activePlayback) activePlayback.aborted = true;
      activePlayback = { fromId: body.from_id, aborted: false };

      return Response.json(
        { status: "playing", from_id: body.from_id },
        { headers: corsHeaders }
      );
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      if (activePlayback) {
        activePlayback.aborted = true;
        activePlayback = null;
      }
      return Response.json({ status: "stopped" }, { headers: corsHeaders });
    }

    // Audio endpoint: fetch audio for a specific message
    // GET /api/audio/:id -> audio/wav
    if (url.pathname.startsWith("/api/audio/") && req.method === "GET") {
      const id = Number(url.pathname.slice("/api/audio/".length));
      if (!id || isNaN(id)) {
        return Response.json(
          { error: "invalid message id" },
          { status: 400, headers: corsHeaders }
        );
      }

      const messages = getMessages(id, 1);
      const msg = messages.find((m) => m.id === id);
      if (!msg) {
        return Response.json(
          { error: "message not found" },
          { status: 404, headers: corsHeaders }
        );
      }

      const filtered = await getFilteredText(msg);
      const audio = await synthesize(filtered);
      if (!audio) {
        return Response.json(
          { error: "tts failed" },
          { status: 503, headers: corsHeaders }
        );
      }

      return new Response(audio, {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(audio.byteLength),
          ...corsHeaders,
        },
      });
    }

    // Webhook receiver (from claude-hub)
    if (url.pathname === "/api/webhook" && req.method === "POST") {
      const body = (await req.json()) as {
        source?: string;
        channel?: string;
        author?: string;
        content?: string;
      };

      if (!body.content) {
        return Response.json(
          { error: "content required" },
          { status: 400, headers: corsHeaders }
        );
      }

      const msg = insertMessage(
        body.source ?? "discord",
        body.channel ?? "",
        body.author ?? "",
        body.content
      );

      // Broadcast new message notification to WS clients (fire-and-forget)
      server.publish(
        "messages",
        JSON.stringify({ type: "new_message", message: msg })
      );

      return Response.json(
        { status: "received", id: msg.id },
        { headers: corsHeaders }
      );
    }

    // Serve PWA client
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = Bun.file(join(CLIENT_DIR, "index.html"));
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html", ...corsHeaders },
        });
      }
    }

    if (
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname === "/manifest.json"
    ) {
      const file = Bun.file(join(CLIENT_DIR, url.pathname));
      if (await file.exists()) {
        return new Response(file, { headers: corsHeaders });
      }
    }

    return Response.json(
      { error: "not found" },
      { status: 404, headers: corsHeaders }
    );
  },

  websocket: {
    open(ws) {
      ws.subscribe("messages");
      console.log("WS client connected");
    },
    message(ws, message) {
      try {
        const data = JSON.parse(String(message));
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // ignore malformed messages
      }
    },
    close(ws) {
      ws.unsubscribe("messages");
      console.log("WS client disconnected");
    },
  },
});

console.log(`vive-reading server running on http://localhost:${PORT}`);
console.log(`  POST /api/webhook     — receive messages from claude-hub`);
console.log(`  GET  /api/messages    — list messages`);
console.log(`  POST /api/play        — start reading from position`);
console.log(`  POST /api/stop        — stop reading`);
console.log(`  GET  /api/audio/:id   — fetch TTS audio for a message`);
console.log(`  WS   /ws              — message notifications (subscribe "messages")`);
console.log(`  TTS:  ${TTS_URL}`);
