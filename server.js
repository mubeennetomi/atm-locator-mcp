const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

// Identify your app to upstream services
const USER_AGENT = "netomi-atm-locator-demo/1.0 (contact: mubeen@netomi.com)";

// Geocoding
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

// Overpass endpoints (fallback helps with 504s)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Nominatim throttle + cache
let lastNominatimCallAt = 0;
const geoCache = new Map();

async function geocodePlace(query) {
  const key = query.trim().toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);

  const now = Date.now();
  const waitMs = Math.max(0, 1100 - (now - lastNominatimCallAt));
  if (waitMs) await sleep(waitMs);
  lastNominatimCallAt = Date.now();

  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Accept-Language": "en",
      "Referer": "http://localhost/",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Nominatim error: ${res.status} ${body}`.slice(0, 300));
  }

  const data = await res.json();
  const result =
    data && data.length
      ? {
          lat: Number(data[0].lat),
          lon: Number(data[0].lon),
          display_name: data[0].display_name,
        }
      : null;

  geoCache.set(key, result);
  return result;
}

// Overpass query with endpoint fallback + retry on 504/429
async function overpassQuery(query) {
  let lastErr;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    // small retry loop per endpoint
    const delays = [0, 600, 1200];
    for (const d of delays) {
      if (d) await sleep(d);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": USER_AGENT,
          },
          body: new URLSearchParams({ data: query }).toString(),
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const msg = `Overpass error: ${res.status} ${txt}`.slice(0, 300);

          // Retry on overload-ish codes
          if (res.status === 429 || res.status === 504) {
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(msg);
        }

        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error("Overpass error: all endpoints failed");
}

async function findAtms(lat, lon, radiusM, limit) {
  // Keep query cheap to reduce 504s: timeout 15, output capped
  const q = `
[out:json][timeout:15];
(
  nwr(around:${radiusM},${lat},${lon})["amenity"="atm"];
);
out center tags 200;
`;

  const data = await overpassQuery(q);
  const elements = data && data.elements ? data.elements : [];

  const items = elements
    .map((el) => {
      const centerLat = el.type === "node" ? el.lat : el.center && el.center.lat;
      const centerLon = el.type === "node" ? el.lon : el.center && el.center.lon;

      if (typeof centerLat !== "number" || typeof centerLon !== "number") return null;

      const tags = el.tags || {};
      const distance_m = Math.round(haversineMeters(lat, lon, centerLat, centerLon));

      return {
        name: tags.name || "ATM",
        operator: tags.operator || null,
        brand: tags.brand || null,
        address: {
          street: tags["addr:street"] || null,
          housenumber: tags["addr:housenumber"] || null,
          city: tags["addr:city"] || null,
          state: tags["addr:state"] || null,
          postcode: tags["addr:postcode"] || null,
        },
        location: { lat: centerLat, lon: centerLon },
        distance_m,
        osm: { type: el.type, id: el.id },
        tags,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, Math.max(1, Math.min(limit, 25)));

  return items;
}

// MCP server
const server = new McpServer({
  name: "atm-locator-mcp",
  version: "0.2.0",
});

server.tool(
  "geocode_place",
  { query: z.string().min(2) },
  async ({ query }) => {
    const result = await geocodePlace(query);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              result,
              attribution:
                "Geocoding by OpenStreetMap Nominatim. Data © OpenStreetMap contributors (ODbL).",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "find_atms",
  {
    lat: z.number(),
    lon: z.number(),
    radius_m: z.number().min(200).max(50000).default(3000),
    limit: z.number().min(1).max(25).default(10),
  },
  async ({ lat, lon, radius_m, limit }) => {
    const items = await findAtms(lat, lon, radius_m, limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: items.length,
              items,
              attribution:
                "ATM data from OpenStreetMap via Overpass API. Data © OpenStreetMap contributors (ODbL).",
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
    // Use a real session id generator to avoid SSE Conflict issues in some clients
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await server.connect(transport);

  // Important: allow GET (SSE) + POST on the same path
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
