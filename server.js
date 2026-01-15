const express = require("express");
const crypto = require("crypto");
const { z } = require("zod/v3");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const USER_AGENT = "netomi-atm-locator-demo/1.0 (contact: mubeen@netomi.com)";

// Never hardcode secrets. Set this in env:
// export SERPAPI_KEY="..."
const SERPAPI_KEY = process.env.SERPAPI_KEY;

function logTool(label, data) {
  try {
    console.log(
      `[MCP][${label}]`,
      JSON.stringify(data, null, 2)
    );
  } catch {
    console.log(`[MCP][${label}]`, data);
  }
}


function toMapsLinkFromLatLon(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${lat},${lon}`
  )}`;
}

function toMapsLinkFromPlaceId(placeId) {
  if (!placeId) return null;
  return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(
    placeId
  )}`;
}

function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function looksLikeBoaAtm(item) {
  // SerpApi results vary, so we check several fields.
  // Keep it simple and transparent.
  const hay = [
    item.title,
    item.name,
    item.description,
    item.type,
    item.categories && item.categories.join(" "),
    item.address,
  ]
    .filter(Boolean)
    .join(" | ");

  const t = normalizeText(hay);

  // "Bank of America" / "BofA" and "ATM"
  const isBoa =
    t.includes("bank of america") ||
    t.includes("bofa") ||
    t.includes("bankofamerica");
  const isAtm = t.includes("atm");

  // Often Google Maps listings are "Bank of America (with Drive-thru ATM)" etc.
  return isBoa && (isAtm || t.includes("drive") || t.includes("cash"));
}

async function serpApiMapsSearch({ userQuery, limit }) {
  if (!SERPAPI_KEY) {
    throw new Error(
      "Missing SERPAPI_KEY env var. Set it before running the server."
    );
  }

  // Force brand + intent in the query so results skew strongly to BoA ATMs
  // Even if user says "find me an atm near ...", we rewrite to "Bank of America ATM near ..."
  const q = `Bank of America ATM near ${userQuery}`;

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("type", "search");
  url.searchParams.set("google_domain", "google.com");
  url.searchParams.set("hl", "en");
  url.searchParams.set("q", q);
  url.searchParams.set("api_key", SERPAPI_KEY);

  // Optional: If you have user lat/lon, you can pass ll in the request.
  // For now we rely on the "near <place>" query text.

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SerpApi error: ${res.status} ${body}`.slice(0, 500));
  }

  const data = await res.json();

  // SerpApi Google Maps engine typically returns `local_results`
  const raw = Array.isArray(data.local_results) ? data.local_results : [];

  // Filter to BoA ATMs and cap
  const filtered = raw.filter(looksLikeBoaAtm).slice(0, Math.max(1, Math.min(limit, 25)));

  // Map into a stable shape
  const items = filtered.map((r) => {
    const gps = r.gps_coordinates || r.gps_coordinates || null;
    const lat = gps && typeof gps.latitude === "number" ? gps.latitude : null;
    const lon = gps && typeof gps.longitude === "number" ? gps.longitude : null;

    // Try place_id first, then lat/lon, else fallback to query link
    const mapsLink =
      toMapsLinkFromPlaceId(r.place_id) ||
      toMapsLinkFromLatLon(lat, lon) ||
      (r.directions_link || r.website || null);

return {
  name: r.title || r.name || "Bank of America ATM",
  address: r.address || null,
  phone: r.phone || null,
  rating: typeof r.rating === "number" ? r.rating : null,
  reviews: typeof r.reviews === "number" ? r.reviews : null,
  hours: r.hours || r.open_state || null,
  location: lat !== null && lon !== null ? { lat, lon } : null,
  maps_link: mapsLink,
  place_id: r.place_id || null,

  // Optional small debug only:
  source: {
    data_id: r.data_id || null,
    type: r.type || null
  }
};

  });

  return {
    count: items.length,
    items,
    meta: {
      rewritten_query: q,
    },
  };
}

// MCP server
const server = new McpServer({
  name: "atm-locator-mcp",
  version: "1.0.0",
});

const LocateAtmsInput = {
  query: z
    .string()
    .min(3)
    .describe(
      'User location intent such as "times square new york", "near 94105", or the full user sentence.'
    ),

  limit: z
    .number()
    .min(1)
    .max(25)
    .default(5)
    .describe("Maximum number of Bank of America ATMs to return. Defaults to 5."),
};


function forceToolDescription(mcpServer, toolName, description) {
  // Try to find an internal Map that stores tools by name and patch it.
  for (const k of Object.keys(mcpServer)) {
    const v = mcpServer[k];
    if (v && typeof v.get === "function" && typeof v.set === "function") {
      const tool = v.get(toolName);
      if (tool && typeof tool === "object") {
        tool.description = description;
        return true;
      }
    }
  }
  return false;
}




server.registerTool(
  "locate_atms",
  {
    title: "Locate ATMs",
    description: [
      "Find nearby ATMs.",
      "IMPORTANT: This tool ALWAYS returns Bank of America ATMs, even if the user does not mention the bank name.",
      "Use whenever the user asks for an ATM, nearest ATM, cash withdrawal location, or ATM near a place.",
      "Do NOT ask which bank.",
      "Returns 5 results by default (unless limit is specified).",
      'Examples: "find me an atm near times square new york", "nearest atm", "atm near 94105".',
      "Output includes Google Maps links.",
    ].join(" "),
    inputSchema: LocateAtmsInput,
  },
  async (input) => {
    // 🔹 LOG INPUT
    logTool("locate_atms:input", input);

    try {
      const { query, limit } = input;

      const result = await serpApiMapsSearch({
        userQuery: query,
        limit,
      });

      // 🔹 LOG OUTPUT
      logTool("locate_atms:output", result);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                assumption:
                  "Results are limited to Bank of America ATMs by default.",
                attribution:
                  "Results powered by SerpApi Google Maps engine; map links point to Google Maps.",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      // 🔹 LOG ERROR (THIS IS CRITICAL)
      console.error("[MCP][locate_atms:error]", err);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to fetch ATMs",
                message: err?.message || String(err),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);






async function main() {
  const app = express();

  // Parse JSON only for non-GET (SSE GET should not be parsed)
  app.use((req, res, next) => {
    if (req.method === "GET") return next();
    return express.json({ limit: "1mb" })(req, res, next);
  });

  app.get("/", (_req, res) => {
    res.status(200).send("ATM Locator MCP is running. Use /mcp");
  });

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  // One MCP server instance is fine
  const mcpServer = server;

  // One transport per session
  const sessions = new Map(); // sessionId -> transport

  function getSessionId(req) {
    // MCP Streamable HTTP uses a session id. Depending on client, it can appear in:
    // - query param: ?sessionId=...
    // - header: mcp-session-id
    // We support both.
    return (
      (req.query && (req.query.sessionId || req.query.session_id)) ||
      req.headers["mcp-session-id"] ||
      req.headers["mcp-sessionid"] ||
      null
    );
  }

  async function getOrCreateTransport(req) {
    let sessionId = getSessionId(req);

    // If client did not provide one yet, create one and return it in a header.
    // Some clients will send a new session id on the next request.
    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }

    if (!sessions.has(sessionId)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      await mcpServer.connect(transport);
      sessions.set(sessionId, transport);
    }

    return { sessionId, transport: sessions.get(sessionId) };
  }

  app.use("/mcp", (req, res, next) => {
  console.log(`[MCP][HTTP] ${req.method} /mcp`);
  res.on("close", () => console.log(`[MCP][HTTP] ${req.method} /mcp closed`));
  res.on("finish", () => console.log(`[MCP][HTTP] ${req.method} /mcp finished`));
  next();
});


  app.all("/mcp", async (req, res) => {
    try {
      // SSE hints
      if (req.method === "GET") {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
      }

      const { sessionId, transport } = await getOrCreateTransport(req);

      // Help clients keep the session
      res.setHeader("mcp-session-id", sessionId);

if (req.method === "GET") {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}


      await transport.handleRequest(req, res, req.body);

      // Cleanup on DELETE if client ends session
      if (req.method === "DELETE") {
        sessions.delete(sessionId);
      }
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const PORT = Number(process.env.PORT || 3337);
  app.listen(PORT, () => {
    console.log(`ATM Locator MCP running on http://localhost:${PORT}/mcp`);
  });
}


main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
