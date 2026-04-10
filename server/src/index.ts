import { getMessages, insertMessage, type Message } from "./db";
import { join } from "path";

const PORT = 3456;
const CLIENT_DIR = join(import.meta.dir, "../../client");

// Track active TTS playback
let activePlayback: { fromId: number; aborted: boolean } | null = null;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

      // Abort any active playback
      if (activePlayback) {
        activePlayback.aborted = true;
      }
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

    // Serve static client files
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
      console.log("WebSocket client connected");
    },
    message(ws, message) {
      // Client can send control messages via WebSocket too
      try {
        const data = JSON.parse(String(message));
        if (data.type === "play" && data.from_id) {
          if (activePlayback) activePlayback.aborted = true;
          activePlayback = { fromId: data.from_id, aborted: false };
          ws.send(JSON.stringify({ type: "playing", from_id: data.from_id }));
        } else if (data.type === "stop") {
          if (activePlayback) activePlayback.aborted = true;
          activePlayback = null;
          ws.send(JSON.stringify({ type: "stopped" }));
        }
      } catch {
        // ignore malformed messages
      }
    },
    close(ws) {
      console.log("WebSocket client disconnected");
    },
  },
});

console.log(`vive-reading server running on http://localhost:${PORT}`);
console.log(`  POST /api/webhook  — receive messages from claude-hub`);
console.log(`  GET  /api/messages — list messages`);
console.log(`  POST /api/play     — start reading from position`);
console.log(`  POST /api/stop     — stop reading`);
console.log(`  WS   /ws/audio     — audio stream (TODO)`);
