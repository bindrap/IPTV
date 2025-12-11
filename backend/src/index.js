import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 8080;
const DEFAULT_PLAYLIST = "http://xteve:34400/m3u/xteve.m3u8";
const ALLOW_INSECURE = `${process.env.ALLOW_INSECURE}`.toLowerCase() === "true";
const FETCH_TIMEOUT = 15000; // 15 second timeout
const TMDB_TOKEN = process.env.TMDB_TOKEN;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache for metadata APIs
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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

const runCommand = (command, args = [], { env = {}, timeout = 20000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}${stderr ? `: ${stderr}` : ""}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

const commandExists = async (command) => {
  try {
    await runCommand("which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const collectUrls = (text) => {
  if (!text) return [];
  const regex =
    /(https?:\/\/[^\s"'<>]+?(?:m3u8?|mp4|mov|mkv|avi|flv|mpd|webm|ts)[^\s"'<>]*)/gi;
  const matches = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.add(match[1]);
  }
  return [...matches];
};

const parseJsonFromText = (text) => {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const flattenValues = (value, collector) => {
  if (typeof value === "string") {
    collector.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => flattenValues(item, collector));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => flattenValues(item, collector));
  }
};

const VIDSRC_DOMAINS = [
  "https://vidsrc.xyz",
  "https://vidsrc.to",
  "https://vidsrc.me",
  "https://vidsrc.stream",
  "https://vidsrc.cc",
  "https://vidsrc.pro",
  "https://vidsrc.vip",
  "https://vidsrc.site",
  "https://vidsrc-embed.com",
  "https://vidsrc.icu",
  "https://vidsrc.nl",
  "https://vidsrc.pm",
];

const detectEpisodeFromQuery = (query = "", fallbackEpisode = 1) => {
  const match = query.match(/s(\d+)[^\d]?e(\d+)/i);
  const season = match ? parseInt(match[1], 10) || 1 : 1;
  const episodeNumber = match
    ? parseInt(match[2], 10) || Number(fallbackEpisode) || 1
    : Number(fallbackEpisode) || 1;

  return { season, episodeNumber };
};

const scrapeEmbedCandidates = async (urls = []) => {
  const found = new Set();

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          referer: url,
        },
      });
      if (!response.ok) continue;
      const body = await response.text();
      collectUrls(body).forEach((u) => found.add(u));
    } catch (error) {
      console.error(`Failed to scrape embed ${url}:`, error.message);
      // Try a second pass without keep-alive in case the upstream resets connections
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            referer: url,
          },
          redirect: "follow",
        });
        if (res.ok) {
          const body = await res.text();
          collectUrls(body).forEach((u) => found.add(u));
        }
      } catch (fallbackError) {
        console.error(`Second scrape attempt failed for ${url}:`, fallbackError.message);
      }
    }
  }

  return [...found];
};

const buildVidsrcEmbeds = ({ id, category = "movie", season = 1, episode = 1 }) =>
  category === "movie"
    ? VIDSRC_DOMAINS.map((base) => `${base}/embed/movie/${id}`)
    : VIDSRC_DOMAINS.map((base) => `${base}/embed/tv/${id}/${season}/${episode}`);

const resolveVidsrcById = async ({ id, category = "movie", season = 1, episode = 1 }) => {
  const embedTargets = buildVidsrcEmbeds({ id, category, season, episode });
  const scraped = await scrapeEmbedCandidates(embedTargets);
  const urls = scraped.filter(Boolean);

  if (!urls.length) {
    throw new Error("No playable URLs found from VidSrc mirrors");
  }

  return {
    title:
      category === "movie"
        ? `TMDB #${id}`
        : `TMDB #${id} S${String(season).padStart(2, "0")}E${String(
            episode
          ).padStart(2, "0")}`,
    urls,
    raw: embedTargets.join("\n"),
  };
};

const resolveWithAniCli = async ({ query, episode = "1" }) => {
  const args = ["--select-nth", "1"];
  if (episode) {
    args.push("--episode", String(episode));
  }
  args.push(query);

  const env = {
    ANI_CLI_PLAYER: "debug", // print URLs instead of playing
    ANI_CLI_EXIT_AFTER_PLAY: "1",
    ANI_CLI_NO_DETACH: "1",
    ANI_CLI_EXTERNAL_MENU: "0",
    FZF_DEFAULT_OPTS: "--select-1 --exit-0",
  };

  const { stdout } = await runCommand("ani-cli", args, {
    env,
    timeout: 30000,
  });

  const urls = collectUrls(stdout);
  if (urls.length === 0) {
    throw new Error("ani-cli did not return a playable URL");
  }

  return {
    title: query.replace(/\+/g, " "),
    urls,
    raw: stdout,
  };
};

const resolveWithLobster = async ({ query, quality, type = "movies" }) => {
  let lastError = null;
  const args = ["--json"];
  if (quality) {
    args.push("-q", String(quality));
  }
  args.push(query);

  const env = {
    FZF_DEFAULT_OPTS: "--select-1 --exit-0",
  };

  let stdout = "";
  try {
    const result = await runCommand("lobster", args, {
      env,
      timeout: 30000,
    });
    stdout = result.stdout;
  } catch (error) {
    lastError = error;
  }

  const urls = collectUrls(stdout);
  const parsed = parseJsonFromText(stdout);
  const collected = [];
  flattenValues(parsed, collected);
  const extraUrls = collectUrls(collected.join(" "));

  const allUrls = [...new Set([...urls, ...extraUrls])];
  if (allUrls.length > 0) {
    const title =
      (parsed && (parsed.title || parsed.name || parsed?.info?.title)) ||
      query.replace(/\+/g, " ");
    return { title, urls: allUrls, raw: stdout };
  }

  // Fallback to VidSrc if lobster returns nothing
  const hasTmdb = !!TMDB_TOKEN;
  console.warn("Lobster returned no URLs; attempting VidSrc fallback");

  if (!hasTmdb) {
    throw (
      lastError ||
      new Error(
        "lobster returned no URLs and TMDB_TOKEN is not set for the fallback resolver"
      )
    );
  }

  try {
    const fallback = await resolveWithVidsrc({
      query,
      episode: "1",
      type,
    });
    return { ...fallback, raw: `${stdout}\n[FALLBACK: vidsrc]` };
  } catch (fallbackError) {
    throw (
      lastError ||
      new Error(`lobster returned no URLs; fallback failed: ${fallbackError.message}`)
    );
  }
};

const resolveWithVidsrc = async ({ query, episode = "1", type = "movies" }) => {
  const category = ["tv", "tvshows", "tv show", "show"].includes(
    `${type}`.toLowerCase()
  )
    ? "tv"
    : "movie";

  const headers = tmdbHeadersOrThrow();
  const searchUrl = `https://api.themoviedb.org/3/search/${category}?query=${encodeURIComponent(
    query
  )}&include_adult=false&language=en-US&page=1`;

  const searchRes = await fetchWithTimeout(searchUrl, { headers });
  if (!searchRes.ok) {
    throw new Error(`TMDB search failed (${searchRes.status})`);
  }

  const payload = await searchRes.json();
  const match = (payload.results || [])[0];
  if (!match) {
    throw new Error("No matching title found");
  }

  const title = match.title || match.name || query.replace(/\+/g, " ");
  const { season, episodeNumber } = detectEpisodeFromQuery(query, episode);

  const embedded = await resolveVidsrcById({
    id: match.id,
    category,
    season,
    episode: episodeNumber,
  });

  const displayTitle =
    category === "tv"
      ? `${title} S${String(season).padStart(2, "0")}E${String(
          episodeNumber
        ).padStart(2, "0")}`
      : title;

  return {
    title: displayTitle,
    urls: embedded.urls,
    raw: embedded.raw,
  };
};

const vodProviders = {
  vidsrc: {
    id: "vidsrc",
    label: "Built-in (Movies/TV)",
    resolver: resolveWithVidsrc,
    description: "Scrapes VidSrc embeds for HLS/MP4 without external CLIs",
  },
  "ani-cli": {
    id: "ani-cli",
    label: "ani-cli (Anime)",
    resolver: resolveWithAniCli,
    description: "Headless ani-cli run with debug player to expose stream URLs",
    dependsOn: "ani-cli",
  },
  lobster: {
    id: "lobster",
    label: "lobster (Movies/TV)",
    resolver: resolveWithLobster,
    description: "Uses lobster --json output to get HLS/MP4 URLs",
    dependsOn: "lobster",
  },
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
      agent: agentSelector,
      headers: {
        "user-agent": DEFAULT_UA,
        accept: "*/*",
        ...(options.headers || {}),
      },
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

const requireTmdbHeaders = (res) => {
  if (!TMDB_TOKEN) {
    res.status(500).json({
      error: "TMDB_TOKEN environment variable is not set",
    });
    return null;
  }

  return {
    Authorization: `Bearer ${TMDB_TOKEN}`,
    accept: "application/json",
  };
};

const tmdbHeadersOrThrow = () => {
  if (!TMDB_TOKEN) {
    throw new Error("TMDB_TOKEN environment variable is not set");
  }

  return {
    Authorization: `Bearer ${TMDB_TOKEN}`,
    accept: "application/json",
  };
};

const slugify = (value = "") =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

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

// Simple in-memory cache for metadata calls
const metaCache = new Map();
const setCache = (key, value) => {
  metaCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
};
const getCache = (key) => {
  const entry = metaCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    metaCache.delete(key);
    return null;
  }
  return entry.value;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Movies/TV Shows/Anime API endpoints

// Search for movies
app.get("/api/movies/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      res.status(400).json({ error: "Missing search query" });
      return;
    }

    const searchUrl = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`;
    const headers = requireTmdbHeaders(res);
    if (!headers) return;

    const cacheKey = `tmdb:movie:search:${query}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const response = await fetchWithTimeout(searchUrl, { headers });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (error) {
    console.error("Movie search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search for TV shows
app.get("/api/tv/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      res.status(400).json({ error: "Missing search query" });
      return;
    }

    const searchUrl = `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`;
    const headers = requireTmdbHeaders(res);
    if (!headers) return;

    const cacheKey = `tmdb:tv:search:${query}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const response = await fetchWithTimeout(searchUrl, { headers });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (error) {
    console.error("TV search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search for anime
app.get("/api/anime/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      res.status(400).json({ error: "Missing search query" });
      return;
    }

    const searchUrl = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&sfw=true&limit=20`;
    const response = await fetchWithTimeout(searchUrl);

    if (!response.ok) {
      throw new Error(`Jikan API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Anime search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get popular movies
app.get("/api/movies/popular", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const url = `https://api.themoviedb.org/3/movie/popular?language=en-US&page=${page}`;
    const headers = requireTmdbHeaders(res);
    if (!headers) return;

    const cacheKey = `tmdb:movie:popular:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (error) {
    console.error("Popular movies error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get popular TV shows
app.get("/api/tv/popular", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const url = `https://api.themoviedb.org/3/tv/popular?language=en-US&page=${page}`;
    const headers = requireTmdbHeaders(res);
    if (!headers) return;

    const cacheKey = `tmdb:tv:popular:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (error) {
    console.error("Popular TV shows error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get popular anime
app.get("/api/anime/popular", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const url = `https://api.jikan.moe/v4/top/anime?page=${page}&limit=20`;
    const cacheKey = `jikan:anime:popular:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error(`Jikan API error: ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (error) {
    console.error("Popular anime error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get streaming sources for movies (using VidSrc)
app.get("/api/movies/:id/watch", async (req, res) => {
  try {
    const movieId = req.params.id;
    const resolved = await resolveVidsrcById({ id: movieId, category: "movie" });
    const [primary] = resolved.urls;

    res.json({
      success: true,
      title: resolved.title,
      streamUrl: `/api/stream?url=${encodeURIComponent(primary)}`,
      embedUrl: primary,
      alternateUrls: resolved.urls,
    });
  } catch (error) {
    console.error("Movie watch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get streaming sources for TV shows
app.get("/api/tv/:id/watch", async (req, res) => {
  try {
    const tvId = req.params.id;
    const season = req.query.season || 1;
    const episode = req.query.episode || 1;
    const resolved = await resolveVidsrcById({
      id: tvId,
      category: "tv",
      season,
      episode,
    });
    const [primary] = resolved.urls;

    res.json({
      success: true,
      title: resolved.title,
      streamUrl: `/api/stream?url=${encodeURIComponent(primary)}`,
      embedUrl: primary,
      alternateUrls: resolved.urls,
    });
  } catch (error) {
    console.error("TV watch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get streaming sources for anime (using Jikan + GogoAnime)
app.get("/api/anime/:id/watch", async (req, res) => {
  try {
    const animeId = req.params.id;
    const episode = req.query.episode || 1;

    // Fetch anime details from Jikan to get the title
    const animeUrl = `https://api.jikan.moe/v4/anime/${animeId}`;
    const animeResponse = await fetchWithTimeout(animeUrl);

    if (!animeResponse.ok) {
      throw new Error(`Failed to fetch anime details`);
    }

    const animeData = await animeResponse.json();
    const animeTitle = animeData.data.title;
    const animeSlug = slugify(animeTitle);

    res.json({
      success: true,
      animeTitle,
      episode,
      streamUrl: `https://gogoanime.lu/${animeSlug}-episode-${episode}`,
      embedUrl: `https://2anime.xyz/embed/${animeSlug}-episode-${episode}`,
      alternateUrls: [
        `https://animixplay.to/v1/${animeSlug}/ep${episode}`,
        `https://aniwave.to/watch/${animeSlug}-episode-${episode}`
      ]
    });
  } catch (error) {
    console.error("Anime watch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get TV show seasons and episodes
app.get("/api/tv/:id/seasons", async (req, res) => {
  try {
    const tvId = req.params.id;
    const url = `https://api.themoviedb.org/3/tv/${tvId}?language=en-US`;
    const headers = requireTmdbHeaders(res);
    if (!headers) return;

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("TV seasons error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get anime episodes
app.get("/api/anime/:id/episodes", async (req, res) => {
  try {
    const animeId = req.params.id;
    const url = `https://api.jikan.moe/v4/anime/${animeId}/episodes`;
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error(`Jikan API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Anime episodes error:", error);
    res.status(500).json({ error: error.message });
  }
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

app.get("/api/vod/providers", async (_req, res) => {
  const providers = await Promise.all(
    Object.values(vodProviders).map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      available: provider.dependsOn
        ? await commandExists(provider.dependsOn)
        : true,
    }))
  );

  res.json({ providers });
});

app.get("/api/vod/play", async (req, res) => {
  const providerId = req.query.provider || "vidsrc";
  const query = `${req.query.query || ""}`.trim();
  const episode = req.query.episode || "1";
  const quality = req.query.quality;
  const type = req.query.type || "movies";

  if (!query) {
    res.status(400).json({ error: "Missing query parameter" });
    return;
  }

  const provider = vodProviders[providerId];
  if (!provider) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }

  const needsBinary = !!provider.dependsOn;
  const isAvailable = needsBinary ? await commandExists(provider.dependsOn) : true;
  if (!isAvailable) {
    res.status(400).json({
      error: `${provider.label} is not installed. Please install ${provider.dependsOn} and ensure it is on PATH.`,
    });
    return;
  }

  try {
    const result = await provider.resolver({ query, episode, quality, type });
    if (!result.urls || result.urls.length === 0) {
      throw new Error("No playable URLs returned");
    }

    const [primary] = result.urls;
    res.json({
      provider: provider.id,
      title: result.title || query,
      url: primary,
      streamUrl: `/api/stream?url=${encodeURIComponent(primary)}`,
      alternatives: result.urls,
    });
  } catch (error) {
    console.error("VOD resolver error:", error);
    res.status(500).json({ error: error.message || "Failed to resolve VOD" });
  }
});

app.get("/api/channels", async (req, res) => {
  try {
    // Allow custom playlist URL via query parameter
    const customUrl = req.query.playlist;
    const macAddress = req.query.mac;
    let playlistUrl, text;

    // If MAC address is provided, use sm4k.688.org
    if (macAddress) {
      // Validate MAC address format (basic validation)
      const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^([0-9A-Fa-f]{12})$/;
      if (!macRegex.test(macAddress)) {
        res.status(400).json({ error: "Invalid MAC address format" });
        return;
      }

      // Format MAC address (remove colons/dashes)
      const formattedMac = macAddress.replace(/[:-]/g, '').toUpperCase();

      // Construct URL for sm4k.688.org with MAC address
      playlistUrl = `http://sm4k.688.org/get.php?username=${formattedMac}&password=${formattedMac}&type=m3u_plus&output=ts`;

      try {
        const response = await fetchWithTimeout(playlistUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch playlist from sm4k.688.org (${response.status})`);
        }
        text = await response.text();
      } catch (error) {
        console.error("Failed to load sm4k.688.org playlist:", error);
        res.status(502).json({ error: `Failed to connect to sm4k.688.org: ${error.message}` });
        return;
      }
    } else if (customUrl) {
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
    const targetUrl = new URL(target);
    const referer = `${targetUrl.protocol}//${targetUrl.host}`;
    const upstream = await fetchWithTimeout(target, {
      headers: {
        referer,
      },
    });

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
