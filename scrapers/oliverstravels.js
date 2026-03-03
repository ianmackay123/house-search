import { launchBrowser, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';

const BASE = 'https://www.oliverstravels.com';
const API_BASE = 'https://booking.oliverstravels.com/api';
const TIMEOUT = 20000;
const PER_PAGE = 500;

export async function scrapeOliversTravels(options = {}) {
  console.log("[OT] Starting Oliver's Travels scraper...");

  // Phase 1: Fetch all properties via API and filter to UK sleeps >= 20
  const candidates = await fetchCandidates();
  console.log(`[OT] ${candidates.length} UK properties sleeping 20+`);

  if (candidates.length === 0) return [];

  const toScrape = options.limit ? candidates.slice(0, options.limit) : candidates;

  // Phase 2: Visit detail pages to check pets and extract games
  const { browser, context } = await launchBrowser();
  try {
    // Accept cookies on first page load
    const firstPage = await context.newPage();
    await firstPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await firstPage.waitForTimeout(2000);
    await firstPage.locator('.cky-btn-accept').click().catch(() => {});
    await firstPage.waitForTimeout(500);
    await firstPage.close();

    const results = [];
    for (const candidate of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, candidate);
        if (prop) results.push(normalise(prop, 'oliverstravels'));
      } catch (err) {
        console.error(`[OT] Error scraping ${candidate.name}: ${err.message}`);
      }
    }

    console.log(`[OT] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function fetchCandidates() {
  // The API ignores all filter params — fetch all and filter client-side
  const allResults = [];
  const firstResp = await fetch(`${API_BASE}/search?per_page=${PER_PAGE}&page=1&currency=GBP`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  if (!firstResp.ok) throw new Error(`API returned ${firstResp.status}`);
  const firstData = await firstResp.json();
  const totalPages = firstData.data.searchResults.pagination.last_page;
  allResults.push(...firstData.data.searchResults.listResults.results);
  console.log(`[OT] API: page 1/${totalPages} (${allResults.length} results)`);

  // Fetch remaining pages concurrently in batches of 5
  for (let batch = 2; batch <= totalPages; batch += 5) {
    const promises = [];
    for (let p = batch; p <= Math.min(batch + 4, totalPages); p++) {
      promises.push(
        fetch(`${API_BASE}/search?per_page=${PER_PAGE}&page=${p}&currency=GBP`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        })
          .then(r => r.json())
          .then(d => d.data.searchResults.listResults.results)
          .catch(err => { console.warn(`[OT] API page ${p} failed: ${err.message}`); return []; })
      );
    }
    const batchResults = await Promise.all(promises);
    for (const results of batchResults) allResults.push(...results);
    console.log(`[OT] API: fetched through page ${Math.min(batch + 4, totalPages)}/${totalPages} (${allResults.length} total)`);
  }

  // Filter: UK only, sleeps >= 20
  return allResults
    .filter(r => r.listing.uri.startsWith('/britain-ireland'))
    .filter(r => r.listing.capacity.max >= 20)
    .map(r => ({
      id: r.listing.id,
      name: r.listing.name,
      uri: r.listing.uri,
      url: BASE + r.listing.uri + '/',
      sleeps: r.listing.capacity.max,
      location: r.location
        .filter(l => !l.hide_on_dwelling_cards && l.title !== 'Britain & Ireland')
        .map(l => l.title)
        .reverse()
        .join(', '),
      image: r.images.list.length > 0 ? r.images.list[0].src : null,
    }));
}

async function scrapeProperty(context, candidate) {
  const page = await context.newPage();
  try {
    await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();

      // Check for pets
      const hasPets = text.includes('pets on request') || text.includes('pet friendly') || text.includes('dog friendly');

      // Games/amenities detection
      const games = [];
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
      if (text.includes('hot tub') || text.includes('jacuzzi')) games.push('Hot tub');
      if (text.includes('indoor pool') || text.includes('indoor swimming')) games.push('Indoor pool');
      else if (text.includes('outdoor pool') || text.includes('outdoor swimming') || text.includes('lido')) games.push('Outdoor pool');
      else if (text.includes('heated pool')) games.push('Heated pool');
      else if (text.includes('swimming pool') || text.includes('private pool')) games.push('Swimming pool');
      if (text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna') || text.includes('steam room')) games.push('Sauna');
      if (text.includes('games room') || text.includes('games barn')) games.push('Games room');
      if (text.includes('fire pit') || text.includes('fire-pit') || text.includes('firepit')) games.push('Fire pit');
      if (/\bmoated?\b/.test(text) && !/house on the moat/.test(text)) games.push('Moat');

      // Extract coordinates from JSON-LD GeoCoordinates in page HTML
      // Quotes may be raw or HTML-encoded (&quot;)
      let lat = null, lng = null;
      const html = document.documentElement.innerHTML;
      const latMatch = html.match(/latitude(?:&quot;|")[:\s]*(?:&quot;|")?(-?[\d.]+)/);
      const lngMatch = html.match(/longitude(?:&quot;|")[:\s]*(?:&quot;|")?(-?[\d.]+)/);
      if (latMatch && lngMatch) {
        lat = parseFloat(latMatch[1]);
        lng = parseFloat(lngMatch[1]);
      }

      return { hasPets, games, lat, lng };
    });

    if (!details.hasPets) {
      console.log(`[OT] Skipping ${candidate.name} — not pet-friendly`);
      return null;
    }

    // Use page coordinates if found, fall back to geocoding
    let lat = details.lat;
    let lng = details.lng;
    let coords_exact = !!(lat && lng);
    if (!lat || !lng) {
      const coords = await geocode(candidate.location);
      lat = coords?.lat || null;
      lng = coords?.lng || null;
    }

    return {
      name: candidate.name,
      sleeps: candidate.sleeps,
      location: candidate.location,
      lat,
      lng,
      coords_exact,
      games: details.games,
      image: candidate.image,
      url: candidate.url,
      price: null,
      available_dates: [],
    };
  } finally {
    await page.close();
  }
}
