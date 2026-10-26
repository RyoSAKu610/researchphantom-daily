// Minimal arXiv export API client (Atom parsing without dependencies).
const ENDPOINT = "https://export.arxiv.org/api/query";
const USER_AGENT = "PhantomresearchDaily/1.0 (research podcast demo)";

export function buildQueryUrl(keyword, max = 5) {
  const term = String(keyword ?? "").trim();
  const limit = Math.max(1, Math.floor(Number(max)) || 5);
  const encoded = encodeURIComponent(`all:"${term}"`);
  return `${ENDPOINT}?search_query=${encoded}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;
}

function safeFromCodePoint(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, " ");
}

function collapse(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function firstTag(entry, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
  return match ? match[1] : "";
}

function extractArxivId(entry) {
  const raw = collapse(stripTags(firstTag(entry, "id")));
  const match = /\/abs\/([^/?#\s]+)/.exec(raw);
  const candidate = (match ? match[1] : raw).replace(/v\d+$/i, "").trim();
  if (!candidate || /\s/.test(candidate) || !/\d/.test(candidate)) return "";
  return candidate;
}

function extractPublished(entry) {
  const raw = collapse(firstTag(entry, "published"));
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
}

// Pure Atom parser. Entries missing id/title/summary are skipped.
export function parseAtom(xml) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const papers = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const arxivId = extractArxivId(entry);
    const title = collapse(decodeEntities(stripTags(firstTag(entry, "title"))));
    const abstract = collapse(decodeEntities(stripTags(firstTag(entry, "summary"))));
    if (!arxivId || !title || !abstract) continue;
    const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)]
      .map((author) => collapse(decodeEntities(stripTags(firstTag(author[1], "name")))))
      .filter(Boolean)
      .slice(0, 8);
    const categoryMatch = /<arxiv:primary_category\b[^>]*\bterm="([^"]*)"/.exec(entry);
    papers.push({
      arxivId,
      title,
      authors,
      primaryCategory: categoryMatch ? decodeEntities(categoryMatch[1]) : "",
      published: extractPublished(entry),
      url: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      abstract,
    });
  }
  return papers;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// arXiv API etiquette: at most one request every 3 seconds from this process
// (https://info.arxiv.org/help/api/tou.html). Applied only to real network
// fetches (injected fetchImpl in tests skips it).
export const ARXIV_MIN_INTERVAL_MS = 3100;
let lastRequestAt = 0;

async function politeWait(minIntervalMs, sleep) {
  if (!(minIntervalMs > 0)) return;
  const wait = lastRequestAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// Retry-After (seconds or HTTP date) -> ms, clamped to [min, max].
function retryAfterMs(response, fallbackMs, maxMs) {
  const raw = response?.headers?.get?.("retry-after");
  let ms = NaN;
  if (raw) {
    ms = /^\d+$/.test(String(raw).trim()) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  }
  if (!Number.isFinite(ms) || ms <= 0) ms = fallbackMs;
  return Math.min(Math.max(ms, fallbackMs), maxMs);
}

// Fetch recent papers for a keyword. One retry after retryDelayMs on network
// error/timeout; 429/503 (arXiv throttling) get up to rateLimitRetries extra
// attempts with growing backoff (Retry-After honoured, capped). Returns [] on
// total failure so callers can use the prefetch cache / curated fallback.
export async function fetchPapers(keyword, options = {}) {
  const {
    max = 5,
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch,
    retryDelayMs = 3000,
    sleep = defaultSleep,
    requestUrl = null,
    rateLimitRetries = 2,
    rateLimitBackoffMs = [15000, 45000],
    maxBackoffMs = 90000,
    minIntervalMs = fetchImpl === globalThis.fetch ? ARXIV_MIN_INTERVAL_MS : 0,
    onEvent = null,
  } = options;
  const term = String(keyword ?? "").trim();
  if (!term) return [];
  if (typeof fetchImpl !== "function") return [];
  const url = requestUrl || buildQueryUrl(term, max);
  let errorAttempts = 0;
  let throttled = 0;
  for (;;) {
    let response;
    try {
      await politeWait(minIntervalMs, sleep);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      response = null;
      onEvent?.({ type: "error", message: String(error?.message ?? error) });
    }
    const status = response?.status;
    if (response && (status === 429 || status === 503) && throttled < rateLimitRetries) {
      const backoff = retryAfterMs(response, rateLimitBackoffMs[Math.min(throttled, rateLimitBackoffMs.length - 1)] ?? 15000, maxBackoffMs);
      throttled += 1;
      onEvent?.({ type: "throttled", status, backoffMs: backoff });
      await sleep(backoff);
      continue;
    }
    if (response && response.ok) {
      try {
        return parseAtom(await response.text());
      } catch {
        // fall through to the generic retry
      }
    } else if (response) {
      onEvent?.({ type: "status", status: status ?? "unknown" });
    }
    errorAttempts += 1;
    if (errorAttempts >= 2 || (status === 429 || status === 503)) return [];
    await sleep(retryDelayMs);
  }
}
