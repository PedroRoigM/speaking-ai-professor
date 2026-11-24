import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const searchCache = new Map();
const pageCache = new Map();

// Low-trust SEO content farms, homework mills, social media, and non-peer-reviewed Q&A sites
const BLOCKED_LOW_TRUST_DOMAINS = [
  'brainly.',
  'chegg.com',
  'coursehero.com',
  'studocu.com',
  'scribd.com',
  'rincondelvago.com',
  'monografias.com',
  'buenastareas.com',
  'lifeder.com',
  'significados.com',
  'concepto.de',
  'enciclopedia.net',
  'ejemplos.co',
  'quora.com',
  'reddit.com',
  'pinterest.',
  'tiktok.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'slideshare.net',
  'prezi.com',
  'amazon.',
  'ebay.',
  'mercadolibre.',
  'aliexpress.',
];

// Tier 1: Academic, standards, peer-reviewed, university, official technical documentation
const TIER1_DOMAIN_PATTERNS = [
  /\.edu(?:\.[a-z]{2})?$/i,
  /\.ac\.[a-z]{2}$/i,
  /\.gov(?:\.[a-z]{2})?$/i,
  /(?:^|\.)(?:mit|stanford|caltech|berkeley|ethz|ox|cam|upm|upc|uc3m|nebrija)\.edu/i,
  /(?:^|\.)(?:arxiv\.org|doi\.org|openalex\.org|ieee\.org|sae\.org|asme\.org|iso\.org|nist\.gov|nasa\.gov)$/i,
  /(?:^|\.)(?:sciencedirect\.com|springer\.com|nature\.com|tandfonline\.com|wiley\.com|mdpi\.com|cambridge\.org)$/i,
  /(?:^|\.)(?:libretexts\.org|openstax\.org|hyperphysics\.phy-astr\.gsu\.edu|mathworld\.wolfram\.com|engineeringtoolbox\.com)$/i,
  /(?:^|\.)(?:docs\.python\.org|numpy\.org|scipy\.org|developer\.mozilla\.org)$/i,
];

// Tier 2: Reputable encyclopedic & recognized engineering/educational references
const TIER2_DOMAIN_PATTERNS = [
  /(?:^|\.)wikipedia\.org$/i,
  /(?:^|\.)britannica\.com$/i,
  /(?:^|\.)khanacademy\.org$/i,
  /(?:^|\.)wolfram\.com$/i,
  /(?:^|\.)researchgate\.net$/i,
  /(?:^|\.)semanticscholar\.org$/i,
  /(?:^|\.)racecar-engineering\.com$/i,
  /(?:^|\.)optimumg\.com$/i,
  /(?:^|\.)fia\.com$/i,
  /(?:^|\.)fisicalab\.com$/i,
  /(?:^|\.)sc\.ehu\.es$/i,
];

export function extractDomain(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isBlockedLowTrustDomain(urlOrDomain) {
  const domain = urlOrDomain.includes('://') ? extractDomain(urlOrDomain) : String(urlOrDomain || '').toLowerCase().replace(/^www\./, '');
  if (!domain) return true;
  return BLOCKED_LOW_TRUST_DOMAINS.some((bad) =>
    bad.endsWith('.') ? domain.includes(bad) : domain === bad || domain.endsWith(`.${bad}`),
  );
}

/**
 * Deterministic source authority evaluator:
 * - Tier 1 (90-100): University (.edu/.ac), government/standards (.gov/NIST/ISO/SAE/IEEE), peer-reviewed (arXiv/OpenAlex/Springer/Elsevier), LibreTexts/Wolfram/HyperPhysics
 * - Tier 2 (75-86): Wikipedia, Britannica, Khan Academy, respected engineering references
 * - Tier 3 (55-68): General non-blocked technical websites
 * - Tier 0 (0): Blocked SEO farms / homework mills / social media
 */
export function scoreSourceAuthority(urlOrDomain) {
  const domain = urlOrDomain.includes('://') ? extractDomain(urlOrDomain) : String(urlOrDomain || '').toLowerCase().replace(/^www\./, '');
  if (!domain || isBlockedLowTrustDomain(domain)) {
    return { tier: 0, score: 0, label: 'blocked', domain };
  }
  if (TIER1_DOMAIN_PATTERNS.some((re) => re.test(domain))) {
    return { tier: 1, score: 96, label: 'academic', domain };
  }
  if (TIER2_DOMAIN_PATTERNS.some((re) => re.test(domain))) {
    return { tier: 2, score: 82, label: 'reference', domain };
  }
  return { tier: 3, score: 60, label: 'general', domain };
}

function getCached(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), value });
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function isPrivateOrBlockedIp(ip) {
  const clean = String(ip || '').trim().toLowerCase();
  if (!clean) return true;

  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (net.isIPv4(mapped)) return isPrivateOrBlockedIp(mapped);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return isPrivateOrBlockedIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return true;
  }

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true;
    if (/^(fc|fd)/i.test(clean)) return true;
    if (/^fe[89ab]/i.test(clean)) return true;
    if (/^ff/i.test(clean)) return true;
    return false;
  }

  return true;
}

/**
 * Strict SSRF guard: only permits public http(s) URLs whose resolved IPs are all globally routable.
 */
export async function validatePublicHttpUrl(rawUrl, { resolveDns = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, error: 'URL inválida' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Protocolo bloqueado: ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Credenciales en URL no permitidas' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'Host local o interno bloqueado' };
  }
  if (net.isIP(host)) {
    if (isPrivateOrBlockedIp(host)) {
      return { ok: false, error: 'Dirección IP privada o reservada bloqueada' };
    }
    return { ok: true, url: parsed.toString(), host };
  }

  if (!resolveDns) {
    return { ok: true, url: parsed.toString(), host };
  }

  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    if (!addrs.length) return { ok: false, error: 'No se pudo resolver el dominio' };
    for (const entry of addrs) {
      if (isPrivateOrBlockedIp(entry.address)) {
        return { ok: false, error: 'El dominio resuelve a una IP interna/privada bloqueada' };
      }
    }
    return { ok: true, url: parsed.toString(), host };
  } catch {
    return { ok: false, error: 'No se pudo resolver DNS del dominio' };
  }
}

function unwrapDuckDuckGoUrl(href) {
  let raw = decodeHtmlEntities(String(href || '').trim());
  if (!raw) return '';
  if (raw.startsWith('//')) raw = 'https:' + raw;
  try {
    const u = new URL(raw, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {}
  return '';
}

function reconstructOpenAlexAbstract(invertedIdx) {
  if (!invertedIdx || typeof invertedIdx !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIdx)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (Number.isInteger(pos) && pos >= 0 && pos < 160) {
        words[pos] = word;
      }
    }
  }
  return words.filter(Boolean).join(' ').trim().slice(0, 340);
}

async function searchDuckDuckGoHtml(query, { maxResults = 6, timeoutMs = 6500, signal } = {}) {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (!html || /anomaly-modal|cc=botnet|Please complete the following challenge/i.test(html)) {
      return [];
    }

    const results = [];
    const blockRe = /<div class="result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let m;
    while ((m = blockRe.exec(html)) !== null && results.length < maxResults * 2) {
      const block = m[1];
      if (/result--ad|badge--ad/i.test(block)) continue;
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      const url = unwrapDuckDuckGoUrl(linkMatch[1]);
      if (!url || /duckduckgo\.com\/y\.js/i.test(url)) continue;
      const auth = scoreSourceAuthority(url);
      if (auth.tier === 0) continue; // Strictly filter low-trust SEO farms!
      const title = stripTags(linkMatch[2]).slice(0, 150);
      const snipMatch = block.match(/<(?:a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
      const snippet = snipMatch ? stripTags(snipMatch[1]).slice(0, 340) : '';
      if (!title) continue;
      results.push({
        title,
        url,
        domain: auth.domain,
        tier: auth.tier,
        authorityScore: auth.score,
        snippet,
        source: 'web',
      });
    }

    return results.slice(0, maxResults);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

async function searchWikipedia(query, { lang = 'es', maxResults = 3, timeoutMs = 5000, signal } = {}) {
  const wikiLang = lang === 'en' ? 'en' : 'es';
  const endpoint = `https://${wikiLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query,
  )}&srlimit=${Math.min(5, Math.max(1, maxResults))}&utf8=1&format=json&origin=*`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': 'SpeakingAIProfessor/1.0 (Educational Study Assistant)' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
    return hits.map((h) => {
      const title = String(h.title || '').trim();
      const url = `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
      const auth = scoreSourceAuthority(url);
      return {
        title,
        url,
        domain: auth.domain,
        tier: auth.tier,
        authorityScore: auth.score,
        snippet: stripTags(h.snippet || '').slice(0, 340),
        source: 'wikipedia',
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

/**
 * Free, zero-API-key peer-reviewed academic literature search via OpenAlex API.
 */
async function searchOpenAlexAcademic(query, { maxResults = 2, timeoutMs = 4500, signal } = {}) {
  const endpoint = `https://api.openalex.org/works?search=${encodeURIComponent(
    query,
  )}&per-page=${Math.min(4, Math.max(1, maxResults))}&select=id,doi,display_name,publication_year,cited_by_count,abstract_inverted_index,primary_location`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': 'SpeakingAIProfessor/1.0 (mailto:opensource@example.org)' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const works = Array.isArray(data?.results) ? data.results : [];
    const out = [];
    for (const w of works) {
      const title = String(w.display_name || '').trim();
      if (!title) continue;
      const landingUrl = w.primary_location?.landing_page_url || w.doi || w.id || '';
      if (!landingUrl || !/^https?:\/\//i.test(landingUrl)) continue;
      const abstractText = reconstructOpenAlexAbstract(w.abstract_inverted_index);
      const year = w.publication_year ? ` (${w.publication_year})` : '';
      const cites = Number(w.cited_by_count || 0);
      out.push({
        title: `${title}${year}`.slice(0, 150),
        url: landingUrl,
        domain: extractDomain(landingUrl) || 'openalex.org',
        tier: 1,
        authorityScore: cites >= 20 ? 98 : 93,
        snippet: abstractText || `Publicación académica revisada (${w.publication_year || 's.f.'}, ${cites} citas).`,
        source: 'academic',
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

function scoreRelevance(item, queryTokens) {
  if (!queryTokens.length) return 0;
  const hay = `${item.title || ''} ${item.snippet || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let hits = 0;
  for (const t of queryTokens) {
    if (hay.includes(t)) hits += t.length >= 6 ? 2 : 1;
  }
  return hits;
}

/**
 * Multi-source, zero-API-key, authority-ranked web search with TTL cache and low-trust filtering.
 * Combines live web (DuckDuckGo HTML), encyclopedic reference (Wikipedia ES/EN), and peer-reviewed academic search (OpenAlex).
 */
export async function searchWeb(
  query,
  { maxResults = 5, lang = 'es', includeAcademic = false, timeoutMs = 7500, signal } = {},
) {
  const cleanQuery = String(query || '').trim().slice(0, 220);
  if (!cleanQuery) {
    return { ok: false, query: '', results: [], error: 'La consulta de búsqueda está vacía.' };
  }

  const normalizedLang = lang === 'en' ? 'en' : 'es';
  const limit = Math.max(1, Math.min(8, Number(maxResults) || 5));
  const cacheKey = `${normalizedLang}|${limit}|${includeAcademic ? 1 : 0}|${cleanQuery.toLowerCase()}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return { ...cached, cached: true };

  const tasks = [
    searchDuckDuckGoHtml(cleanQuery, { maxResults: limit, timeoutMs, signal }),
    searchWikipedia(cleanQuery, { lang: normalizedLang, maxResults: 3, timeoutMs: Math.min(5000, timeoutMs), signal }),
  ];
  if (normalizedLang !== 'en') {
    tasks.push(searchWikipedia(cleanQuery, { lang: 'en', maxResults: 2, timeoutMs: Math.min(4500, timeoutMs), signal }));
  }
  if (includeAcademic) {
    tasks.push(searchOpenAlexAcademic(cleanQuery, { maxResults: 2, timeoutMs: Math.min(4500, timeoutMs), signal }));
  }

  const batches = await Promise.all(tasks);
  const rawMerged = batches.flat();

  const stop = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'y', 'o', 'que', 'por', 'para', 'con', 'the', 'and', 'of', 'in', 'to', 'for']);
  const queryTokens = cleanQuery
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stop.has(t));

  // Deduplicate by canonical URL and rank deterministically by (authority + relevance)
  const seenUrls = new Set();
  const scored = [];
  for (const item of rawMerged) {
    if (!item?.url) continue;
    const normUrl = item.url.replace(/#.*$/, '').replace(/\/$/, '');
    if (seenUrls.has(normUrl)) continue;
    const auth = item.tier ? { tier: item.tier, score: item.authorityScore || 60, domain: item.domain } : scoreSourceAuthority(item.url);
    if (auth.tier === 0) continue;
    seenUrls.add(normUrl);
    const rel = scoreRelevance(item, queryTokens);
    // Require minimal topical overlap when multiple candidates exist; reward authoritative sources strongly
    const combinedScore = auth.score + rel * 7 + (item.snippet?.length > 50 ? 6 : 0);
    scored.push({
      title: item.title,
      url: item.url,
      domain: auth.domain || extractDomain(item.url),
      tier: auth.tier,
      authorityScore: auth.score,
      relevanceHits: rel,
      combinedScore,
      snippet: item.snippet || '',
      source: item.source || 'web',
    });
  }

  scored.sort((a, b) => b.combinedScore - a.combinedScore || a.url.localeCompare(b.url));

  // Enforce domain diversity in top results so cross-checking uses independent sources (max 2 per domain)
  const domainCounts = new Map();
  const finalResults = [];
  for (const r of scored) {
    const cnt = domainCounts.get(r.domain) || 0;
    if (cnt >= 2) continue;
    domainCounts.set(r.domain, cnt + 1);
    finalResults.push({
      title: r.title,
      url: r.url,
      domain: r.domain,
      tier: r.tier,
      snippet: r.snippet,
      source: r.source,
    });
    if (finalResults.length >= limit) break;
  }

  const distinctDomains = new Set(finalResults.map((r) => r.domain)).size;
  const payload = {
    ok: finalResults.length > 0,
    query: cleanQuery,
    results: finalResults,
    sourcesCount: finalResults.length,
    distinctDomains,
    note:
      finalResults.length > 0
        ? 'Resultados filtrados por fiabilidad (sin granjas SEO). Úsalos SOLO para contrastar rigor y enriquecer sin desviarte de los apuntes.'
        : 'No se obtuvieron fuentes fiables en internet. Continúa estrictamente con los apuntes originales.',
  };

  if (finalResults.length > 0) {
    setCached(searchCache, cacheKey, payload);
  }
  return payload;
}

function extractReadableTextFromHtml(html, maxChars = 4200) {
  let raw = String(html || '');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 160) : '';

  raw = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:nav|footer|aside|header|form)[^>]*>[\s\S]*?<\/(?:nav|footer|aside|header|form)>/gi, ' ');

  const mainMatch = raw.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  const target = mainMatch && mainMatch[1].length > 350 ? mainMatch[1] : raw;

  const text = decodeHtmlEntities(
    target
      .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title,
    excerpt: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

/**
 * Fetches and extracts clean readable text from a public web page (SSRF-hardened, redirect-checked, size-capped).
 */
export async function fetchWebPage(rawUrl, { maxChars = 4200, timeoutMs = 8000, signal } = {}) {
  const initialCheck = await validatePublicHttpUrl(rawUrl, { resolveDns: true });
  if (!initialCheck.ok) {
    return { ok: false, url: String(rawUrl || ''), error: initialCheck.error };
  }

  const limitChars = Math.max(500, Math.min(8000, Number(maxChars) || 4200));
  const cacheKey = `${initialCheck.url}|${limitChars}`;
  const cached = getCached(pageCache, cacheKey);
  if (cached) return { ...cached, cached: true };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });

  try {
    let currentUrl = initialCheck.url;
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: ctrl.signal,
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const nextUrl = new URL(res.headers.get('location'), currentUrl).toString();
        const nextCheck = await validatePublicHttpUrl(nextUrl, { resolveDns: true });
        if (!nextCheck.ok) {
          return { ok: false, url: currentUrl, error: `Redirección bloqueada: ${nextCheck.error}` };
        }
        currentUrl = nextCheck.url;
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      return { ok: false, url: currentUrl, error: `HTTP ${res?.status || 'error'} al leer la página` };
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!/(text\/html|text\/plain|application\/xhtml|application\/json)/i.test(contentType)) {
      return { ok: false, url: currentUrl, error: `Tipo de contenido no legible: ${contentType || 'desconocido'}` };
    }

    const MAX_BYTES = 512 * 1024;
    const reader = res.body?.getReader?.();
    let rawText = '';
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        rawText += decoder.decode(value, { stream: true });
        if (received >= MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {}
          break;
        }
      }
      rawText += decoder.decode();
    } else {
      rawText = (await res.text()).slice(0, MAX_BYTES);
    }

    const extracted = contentType.includes('text/plain')
      ? { title: extractDomain(currentUrl), excerpt: rawText.trim().slice(0, limitChars), truncated: rawText.length > limitChars }
      : extractReadableTextFromHtml(rawText, limitChars);

    const auth = scoreSourceAuthority(currentUrl);
    const payload = {
      ok: Boolean(extracted.excerpt),
      url: currentUrl,
      domain: auth.domain || extractDomain(currentUrl),
      tier: auth.tier,
      title: extracted.title || extractDomain(currentUrl),
      excerpt: extracted.excerpt,
      truncated: extracted.truncated,
    };
    if (payload.ok) setCached(pageCache, cacheKey, payload);
    return payload;
  } catch (err) {
    return {
      ok: false,
      url: initialCheck.url,
      error: err?.name === 'AbortError' ? 'Tiempo de espera agotado al leer la página' : err?.message || 'Error leyendo página',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

const SLIDE_BOILERPLATE_RE =
  /^(?:p[aá]gina|page|diapositiva|slide|cap[ií]tulo|tema|m[aá]ster|universidad|profesor|demo|material|índice|indice|\d+\s*(?:\/\s*\d+)?)\b/i;

/**
 * Extracts a concise, accurate search query strictly anchored to a PDF slide's core concept
 * and subject folder so the Web Research Agent never drifts off-topic.
 */
export function buildSlideSearchQuery(bundle, folderName = '') {
  const lines = (bundle?.layout?.lines || [])
    .map((l) => String(l.text || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 6 && t.length <= 110 && !SLIDE_BOILERPLATE_RE.test(t) && !/^\d+$/.test(t));

  let coreTopic = lines[0] || '';
  if (coreTopic.length < 18 && lines[1]) {
    coreTopic = `${coreTopic} ${lines[1]}`;
  }
  if (!coreTopic) {
    coreTopic = String(bundle?.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
  }
  coreTopic = coreTopic.replace(/[^\p{L}\p{N}\s\-μΔαβθωλρσ_./]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!coreTopic || coreTopic.length < 5) return '';

  const cleanFolder = String(folderName || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanFolder && cleanFolder.length <= 42 && !coreTopic.toLowerCase().includes(cleanFolder.toLowerCase().slice(0, 10))) {
    return `${coreTopic.slice(0, 85)} ${cleanFolder}`.trim();
  }
  return coreTopic.slice(0, 110);
}
