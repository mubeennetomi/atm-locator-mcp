// server.js
// MCP: ATM locator (assumes Bank of America ATMs) using SerpApi Google Maps engine
// Transport: Legacy SSE (GET /sse + POST /messages) compatible with MCP Inspector + Netomi

const express = require("express");
const { z } = require("zod");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");

const USER_AGENT = "netomi-atm-locator-demo/1.0 (contact: mubeen@netomi.com)";
const SERPAPI_KEY = process.env.SERPAPI_KEY;

function logTool(label, data) {
  try {
    console.log(`[MCP][${label}]`, JSON.stringify(data, null, 2));
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
  const hay = [
    item.title,
    item.name,
    item.description,
    item.type,
    Array.isArray(item.categories) ? item.categories.join(" ") : "",
    item.address,
  ]
    .filter(Boolean)
    .join(" | ");

  const t = normalizeText(hay);

  const isBoa =
    t.includes("bank of america") ||
    t.includes("bofa") ||
    t.includes("bankofamerica");

  const isAtm = t.includes("atm");

  return isBoa && isAtm;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function serpApiMapsSearch({ userQuery, limit }) {
  if (!SERPAPI_KEY) {
    throw new Error("Missing SERPAPI_KEY env var");
  }

  // Force BoA ATM intent even if user doesn't mention it
  const q = `Bank of America ATM near ${userQuery}`;

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("type", "search");
  url.searchParams.set("google_domain", "google.com");
  url.searchParams.set("hl", "en");
  url.searchParams.set("q", q);
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    },
    8000
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `SerpApi error: ${res.status} ${String(body).slice(0, 300)}`
    );
  }

  const data = await res.json();
  const raw = Array.isArray(data.local_results) ? data.local_results : [];

  const filtered = raw
    .filter(looksLikeBoaAtm)
    .slice(0, Math.max(1, Math.min(limit ?? 5, 25)));

  const items = filtered.map((r) => {
    const gps = r.gps_coordinates || null;
    const lat = gps && typeof gps.latitude === "number" ? gps.latitude : null;
    const lon = gps && typeof gps.longitude === "number" ? gps.longitude : null;

    const mapsLink =
      toMapsLinkFromPlaceId(r.place_id) ||
      toMapsLinkFromLatLon(lat, lon) ||
      r.directions_link ||
      null;

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
      source: {
        data_id: r.data_id || null,
        type: r.type || null,
      },
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

// Register tool with explicit top-level description (Netomi shows this)
const LocateAtmsInput = {
  query: z
    .string()
    .min(3)
    .describe(
      'User location intent such as "times square new york", "near 94105", or full user sentence.'
    ),
  limit: z
    .number()
    .min(1)
    .max(25)
    .default(5)
    .describe("Max number of ATMs to return. Defaults to 5."),
};

server.registerTool(
  "locate_atms",
  {
    title: "Locate ATMs",
    description: [
      "Find nearby ATMs (assumes Bank of America ATMs even if the user does not mention the bank).",
      "Use this whenever the user asks for an ATM, nearest ATM, cash withdrawal, or ATM near a place/address/landmark/city.",
      "Input is free-form location text or the full user sentence. Returns 5 results by default.",
      "Output includes addresses and Google Maps links.",
      'Examples: "find me an atm near times square new york", "nearest atm", "atm near 94105", "where can I withdraw cash near me".',
    ].join(" "),
    inputSchema: LocateAtmsInput,
  },
  async (input) => {
    logTool("locate_atms:input", input);

    const query = input?.query;
    const limit = input?.limit ?? 5;

    if (!query) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Missing required field: query" },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const result = await serpApiMapsSearch({ userQuery: query, limit });

      logTool("locate_atms:output", result);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                assumption: "Results are limited to Bank of America ATMs by default.",
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
      console.error("[MCP][locate_atms:error]", err);

      const isAbort = err && err.name === "AbortError";
      const msg = isAbort
        ? "SerpApi request timed out. Try a more specific location or retry."
        : err?.message || String(err);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to locate ATMs",
                message: msg,
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

  // Only parse JSON for POST /messages
  app.use((req, res, next) => {
    if (req.method === "GET") return next();
    return express.json({ limit: "1mb" })(req, res, next);
  });

  app.get("/", (_req, res) =>
    res
      .status(200)
      .send("ATM Locator MCP running. Use GET /sse and POST /messages")
  );
  app.get("/health", (_req, res) => res.status(200).send("ok"));

  // Session registry: sessionId -> transport
  const transports = new Map();

  // SSE handshake endpoint
  app.get("/sse", async (req, res) => {
    try {
      console.log("[MCP][HTTP] GET /sse");

      // Helpful for proxies (nginx, cloudflare, etc.)
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);

      console.log("[MCP][SSE] session started:", transport.sessionId);

      res.on("close", () => {
        console.log("[MCP][SSE] session closed:", transport.sessionId);
        transports.delete(transport.sessionId);
      });

      await server.connect(transport);
    } catch (error) {
      console.error("[MCP][SSE] /sse error:", error);
      if (!res.headersSent) res.status(500).send("Failed to establish SSE session");
    }
  });

  // Client-to-server messages endpoint
  app.post("/messages", async (req, res) => {
    try {
      console.log("[MCP][HTTP] POST /messages");

      const sessionId = String(req.query.sessionId || "");
      const transport = transports.get(sessionId);

      if (!transport) {
        return res.status(400).send("No transport found for sessionId");
      }

      // Some SDK/inspector combos require passing req.body explicitly
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("[MCP][SSE] /messages error:", error);
      if (!res.headersSent) res.status(500).send("Internal server error");
    }
  });

  const PORT = Number(process.env.PORT || 3337);
  const httpServer = app.listen(PORT, () => {
    console.log(`ATM Locator MCP (SSE) running:`);
    console.log(`  SSE:       http://localhost:${PORT}/sse`);
    console.log(`  Messages:  http://localhost:${PORT}/messages`);
  });

  // Keep long-lived connections stable
  httpServer.keepAliveTimeout = 70_000;
  httpServer.headersTimeout = 75_000;
  httpServer.requestTimeout = 0;
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
