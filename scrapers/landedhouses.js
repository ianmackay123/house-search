import { launchBrowser, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const BASE = 'https://www.landedhouses.co.uk';
const API_URL = `${BASE}/wp-json/lh/v1/properties`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export async function scrapeLandedHouses(options = {}) {
  console.log('[LH] Starting Landed Houses scraper...');

  // Phase 1: Fetch all pet-friendly properties via API (paginated)
  const candidates = await fetchCandidates();
  console.log(`[LH] ${candidates.length} qualifying properties (pet-friendly, 20+ guests, UK)`);

  if (candidates.length === 0) return [];

  const toScrape = options.limit ? candidates.slice(0, options.limit) : candidates;

  // Phase 2: Visit detail pages for games detection
  const { browser, context } = await launchBrowser();
  try {
    const results = [];
    for (const candidate of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, candidate);
        if (prop) results.push(normalise(prop, 'landedhouses'));
      } catch (err) {
        console.error(`[LH] Error scraping ${candidate.name}: ${err.message}`);
      }
    }

    console.log(`[LH] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function fetchCandidates() {
  const allCandidates = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${API_URL}?type=stays&features[]=pet-friendly&page=${page}`;
    console.log(`[LH] Fetching API page ${page}...`);

    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();

    if (page === 1) {
      totalPages = data.pages || 1;
      console.log(`[LH] ${data.count} pet-friendly properties across ${totalPages} pages`);
    }

    // Parse cards from mapHtml (has coordinates) and html (has details)
    const cards = parseCards(data.mapHtml, data.html);
    allCandidates.push(...cards);

    console.log(`[LH] Page ${page}: parsed ${cards.length} cards`);
    page++;
  }

  // Filter: sleeps >= 20
  return allCandidates.filter(c => {
    if (!c.sleeps || c.sleeps < 20) return false;
    return true;
  });
}

function parseCards(mapHtml, gridHtml) {
  const cards = [];

  // Extract coordinates from mapHtml using data-marker attributes
  // Markers use HTML entities: data-marker='{&quot;lat&quot;:&quot;52.1&quot;,...}'
  const coordMap = new Map();
  const markerRegex = /data-marker='(\{[^']+\})'/g;
  let markerMatch;
  while ((markerMatch = markerRegex.exec(mapHtml)) !== null) {
    try {
      const raw = markerMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const marker = JSON.parse(raw);
      if (marker.lat && marker.lng) {
        // Find the property URL after this marker (it's inside the same div)
        const afterMarker = mapHtml.substring(markerMatch.index, markerMatch.index + 3000);
        const urlMatch = afterMarker.match(/href="(https:\/\/www\.landedhouses\.co\.uk\/properties\/[^"]+)"/);
        if (urlMatch) {
          coordMap.set(urlMatch[1].replace(/\/$/, ''), { lat: parseFloat(marker.lat), lng: parseFloat(marker.lng) });
        }
      }
    } catch {}
  }

  // Parse property cards from gridHtml
  const cardRegex = /<article class="property-preview">([\s\S]*?)<\/article>/g;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(gridHtml)) !== null) {
    const cardHtml = cardMatch[1];

    // Extract name and URL from h3 heading link
    const nameMatch = cardHtml.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
    if (!nameMatch) continue;
    const url = nameMatch[1].replace(/\/$/, '');
    const name = nameMatch[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim();

    // Extract guests count
    const guestsMatch = cardHtml.match(/(\d+)\s*Guests/i);
    const sleeps = guestsMatch ? parseInt(guestsMatch[1], 10) : null;

    // Extract image — prefer source srcset (higher res) over img src
    const sourceMatch = cardHtml.match(/<source[^>]*srcset="([^"]+)"/);
    const imgMatch = cardHtml.match(/<img[^>]*src="([^"]+)"[^>]*>/);
    const image = (sourceMatch ? sourceMatch[1] : null) || (imgMatch ? imgMatch[1] : null);

    // Extract region
    const regionMatch = cardHtml.match(/<p[^>]*text-brand[^>]*>([^<]+)<\/p>/);
    const location = regionMatch ? regionMatch[1].trim() : '';

    // Extract price
    const priceMatch = cardHtml.match(/From\s*<span[^>]*>([^<]+)<\/span>/);
    const price = priceMatch ? `From ${priceMatch[1].trim()}` : null;

    // Get coordinates from mapHtml
    const coords = coordMap.get(url) || { lat: null, lng: null };

    cards.push({
      name,
      url: url + '/',
      sleeps,
      lat: coords.lat,
      lng: coords.lng,
      location,
      image,
      price,
    });
  }

  return cards;
}

async function scrapeProperty(context, candidate) {
  const page = await context.newPage();
  try {
    await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const games = await page.evaluate(() => {
      const games = [];

      // Use JSON-LD amenityFeature for reliable pool/hot tub detection
      // (full page text includes filter nav with "Indoor Pool", "Outdoor Pool" etc.)
      const amenities = new Set();
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent);
          if (data.amenityFeature) {
            for (const f of data.amenityFeature) {
              if (f.value === true || typeof f.value === 'string') {
                amenities.add(f.name.toLowerCase());
              }
            }
          }
        } catch {}
      }

      // Pool/hot tub from JSON-LD amenities (authoritative)
      if (amenities.has('hot tub')) games.push('Hot tub');
      if (amenities.has('indoor pool')) games.push('Indoor pool');
      else if (amenities.has('outdoor pool')) games.push('Outdoor pool');

      // Use description text for games detection (not filter nav)
      // Target the main content area, not the full page
      const contentEl = document.querySelector('.property-content, .entry-content, main, article') || document.body;
      const fullText = contentEl.innerText.toLowerCase();
      // Discard everything after "Similar houses" to avoid false positives from other property listings
      const similarIdx = fullText.indexOf('similar houses');
      const text = similarIdx > -1 ? fullText.slice(0, similarIdx) : fullText;

      if (text.includes('table tennis') || text.includes('ping pong') || text.includes('ping-pong')) games.push('Table tennis');
      if (text.includes('snooker') || text.includes('billiard')) {
        var isFull = /full[\s-]?size[d]?\s+(?:snooker|billiard)/.test(text) || /(?:12[\s-]?f(?:oo)?t|tournament[\s-]?size[d]?|professional[\s-]?size[d]?)\s+(?:snooker|billiard)/.test(text);
        games.push(isFull ? 'Full-size snooker' : 'Snooker');
      }
      if (/pool table|\btable.*pool\b|\bpool\b.*table/.test(text) || text.includes('pool/snooker')) games.push('Pool');
      if (text.includes('table football') || text.includes('foosball')) games.push('Table football');
      if (text.includes('darts') || text.includes('dartboard')) games.push('Darts');
      if (text.includes('air hockey')) games.push('Air hockey');
      if (text.includes('games console') || text.includes('playstation') || text.includes('xbox') || text.includes('nintendo')) games.push('Games console');
      if (text.includes('cinema') || text.includes('movie room') || text.includes('film room') || text.includes('home cinema')) games.push('Cinema');
      if (text.includes('piano')) games.push('Piano');
      // Only detect pool/hot tub from text if not already found via JSON-LD
      if (games.indexOf('Hot tub') === -1 && (text.includes('hot tub') || text.includes('jacuzzi'))) games.push('Hot tub');
      if (games.indexOf('Indoor pool') === -1 && games.indexOf('Outdoor pool') === -1) {
        if (text.includes('indoor pool') || text.includes('indoor swimming')) games.push('Indoor pool');
        else if (text.includes('outdoor pool') || text.includes('outdoor swimming')) games.push('Outdoor pool');
        else if (text.includes('heated pool')) games.push('Heated pool');
        else if (text.includes('swimming pool') || text.includes('private pool')) games.push('Swimming pool');
      }
      if (amenities.has('tennis court') || text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna') || text.includes('steam room')) games.push('Sauna');
      if (amenities.has('games table') || text.includes('games room') || text.includes('games barn')) games.push('Games room');
      if (text.includes('fire pit') || text.includes('fire-pit') || text.includes('firepit')) games.push('Fire pit');
      if (/\bmoated?\b/.test(text) && !/house on the moat/.test(text)) games.push('Moat');
      return games;
    });

    return {
      name: candidate.name,
      sleeps: candidate.sleeps,
      location: candidate.location,
      lat: candidate.lat,
      lng: candidate.lng,
      coords_exact: !!(candidate.lat && candidate.lng),
      games,
      image: candidate.image,
      url: candidate.url,
      price: candidate.price,
      available_dates: [],
    };
  } finally {
    await page.close();
  }
}
