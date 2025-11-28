import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;
const DEFAULT_PLAYLIST = "http://xteve:34400/m3u/xteve.m3u8";
const ALLOW_INSECURE = `${process.env.ALLOW_INSECURE}`.toLowerCase() === "true";
const FETCH_TIMEOUT = 15000; // 15 second timeout

const httpsAgent = new https.Agent({
  rejectUnauthorized: !ALLOW_INSECURE,
  timeout: FETCH_TIMEOUT,
  keepAlive: true
});

const httpAgent = new http.Agent({
  timeout: FETCH_TIMEOUT,
  keepAlive: true
});

const agentSelector = (parsedUrl) => {
  if (parsedUrl.protocol === "https:") return httpsAgent;
  if (parsedUrl.protocol === "http:") return httpAgent;
  return undefined;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

// Helper function to fetch with timeout
const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      agent: agentSelector
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Request timeout after ${FETCH_TIMEOUT}ms`);
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  }
};

const parseAttributes = (line) => {
  const attributes = {};
  const regex = /([a-zA-Z0-9\-]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
};

const parseM3U = (content) => {
  const lines = content.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const [_, title] = line.split(",", 2);
      current = {
        name: (title || "Unknown").trim(),
        ...parseAttributes(line),
      };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      current.streamUrl = `/api/stream?url=${encodeURIComponent(line)}`;
      channels.push(current);
      current = null;
    }
  }

  return channels;
};

const getPlaylistUrl = () => {
  const envUrl = process.env.PLAYLIST_URL;
  if (envUrl && envUrl.trim().length > 0) return envUrl.trim();
  return DEFAULT_PLAYLIST;
};

const fetchPlaylist = async () => {
  const playlistUrl = getPlaylistUrl();
  const response = await fetchWithTimeout(playlistUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist (${response.status})`);
  }

  const text = await response.text();
  return { playlistUrl, text };
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const isManifest = (contentType = "") =>
  contentType.includes("application/vnd.apple.mpegurl") ||
  contentType.includes("application/x-mpegURL") ||
  contentType.includes("application/octet-stream");

const rewriteManifestWithProxy = (body, sourceUrl) => {
  const base = new URL(sourceUrl);
  const lines = body.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed === "" ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("DATA:")
      ) {
        return trimmed;
      }
      const absolute = new URL(trimmed, base).toString();
      return `/api/stream?url=${encodeURIComponent(absolute)}`;
    })
    .join("\n");
};

app.get("/api/channels", async (req, res) => {
  try {
    // Allow custom playlist URL via query parameter
    const customUrl = req.query.playlist;
    let playlistUrl, text;

    if (customUrl) {
      // Validate URL
      try {
        const url = new URL(customUrl);
        if (!["http:", "https:"].includes(url.protocol)) {
          throw new Error("Invalid protocol");
        }
      } catch {
        res.status(400).json({ error: "Invalid playlist URL" });
        return;
      }

      const response = await fetchWithTimeout(customUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch playlist (${response.status})`);
      }
      text = await response.text();
      playlistUrl = customUrl;
    } else {
      const result = await fetchPlaylist();
      playlistUrl = result.playlistUrl;
      text = result.text;
    }

    const channels = parseM3U(text);
    res.json({ playlistUrl, count: channels.length, channels });
  } catch (error) {
    console.error("Failed to load playlist:", error);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/stream", async (req, res) => {
  const target = req.query.url;
  if (!target) {
    res.status(400).json({ error: "Missing url parameter" });
    return;
  }

  try {
    const targetUrl = new URL(target);
    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      res.status(400).json({ error: "Invalid protocol" });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const upstream = await fetchWithTimeout(target);

    if (!upstream.ok) {
      console.error(`Stream proxy failed for ${target}: HTTP ${upstream.status}`);
      res.status(upstream.status).json({
        error: `Upstream returned ${upstream.status}`,
        url: target
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (isManifest(contentType)) {
      const manifest = await upstream.text();
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.send(rewriteManifestWithProxy(manifest, target));
      return;
    }

    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");
    if (upstream.body && upstream.body.pipe) {
      upstream.body.pipe(res);
    } else {
      const buffer = await upstream.arrayBuffer();
      res.end(Buffer.from(buffer));
    }
  } catch (error) {
    const errorCode = error.code || error.errno || 'UNKNOWN';
    const errorMsg = error.message || 'Unknown error';

    // Only log DNS errors once to reduce noise
    if (errorCode === 'ENOTFOUND') {
      console.error(`DNS resolution failed for stream: ${target}`);
    } else if (errorCode === 'ETIMEDOUT') {
      console.error(`Request timeout for stream: ${target}`);
    } else {
      console.error(`Stream proxy error (${errorCode}):`, errorMsg);
    }

    res.status(502).json({
      error: "Failed to proxy stream",
      code: errorCode,
      message: errorMsg
    });
  }
});

app.listen(PORT, () => {
  console.log(`IPTV web server running on port ${PORT}`);
});
