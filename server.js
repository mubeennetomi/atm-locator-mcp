const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const USER_AGENT = "netomi-atm-locator-demo/1.0 (contact: mubeen@netomi.com)";

// Never hardcode secrets. Set this in env:
// export SERPAPI_KEY="..."
const SERPAPI_KEY = process.env.SERPAPI_KEY;

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
      raw: r,
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

server.tool(
  "locate_atms",
  {
    query: z
      .string()
      .min(3)
      .describe(
        [
          "User's location intent for finding nearby ATMs.",
          "IMPORTANT: This tool ALWAYS returns Bank of America ATMs, even if the user does not mention the bank name.",
          "Call this tool whenever the user asks about:",
          "- ATMs",
          "- cash withdrawal locations",
          "- nearest ATM",
          "- ATM near a place, address, landmark, or city",
          "",
          "Do NOT ask a follow-up question about which bank.",
          "",
          "Examples of user input that SHOULD trigger this tool:",
          '"find me an atm near times square new york"',
          '"nearest atm"',
          '"where can I withdraw cash near me"',
          '"atm near 94105"',
          '"cash machine near san jose"',
          "",
          "You may pass either:",
          "- the full user sentence, or",
          "- just the extracted location text (recommended when available).",
        ].join(" ")
      ),

    limit: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe(
        "Maximum number of Bank of America ATMs to return. Use 5 for concise answers and up to 10–15 for detailed listings."
      ),
  },
  async ({ query, limit }) => {
    const result = await serpApiMapsSearch({
      userQuery: query,
      limit,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              assumption:
                "Results are limited to Bank of America ATMs by default.",
              usage_notes:
                "Use this response to present nearby Bank of America ATMs with addresses and Google Maps links for directions.",
              attribution:
                "Results powered by SerpApi Google Maps engine; map links point to Google Maps.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);


async function main() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.status(200).send("ATM Locator MCP is running. Use /mcp");
  });

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await server.connect(transport);

  app.all("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
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
