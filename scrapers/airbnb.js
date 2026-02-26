import { launchBrowser, rateLimit, sleep } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const DATE_RANGES = [
  { checkin: '2026-09-24', checkout: '2026-09-27', label: '24-27 Sep' },
  { checkin: '2026-09-25', checkout: '2026-09-28', label: '25-28 Sep' },
];

export async function scrapeAirbnb(options = {}) {
  console.log('[Airbnb] Starting Airbnb scraper...');
  const { browser, context } = await launchBrowser();
  const allProperties = new Map(); // key by URL for deduplication

  try {
    for (const range of DATE_RANGES) {
      console.log(`[Airbnb] Searching ${range.label}...`);
      try {
        const properties = await searchDateRange(context, range);
        console.log(`[Airbnb] Found ${properties.length} properties for ${range.label}`);

        for (const prop of properties) {
          const existing = allProperties.get(prop.url);
          if (existing) {
            // Merge available dates
            if (!existing.available_dates.includes(range.label)) {
              existing.available_dates.push(range.label);
            }
          } else {
            prop.available_dates = [range.label];
            allProperties.set(prop.url, prop);
          }
        }
      } catch (err) {
        console.error(`[Airbnb] Error searching ${range.label}: ${err.message}`);
      }

      await rateLimit();
    }

    // Visit each listing page to get real name and max guests
    const enriched = [];
    let entries = [...allProperties.values()];
    if (options.limit) entries = entries.slice(0, options.limit);
    console.log(`[Airbnb] Enriching ${entries.length} listings with detail pages...`);
    for (const prop of entries) {
      try {
        await rateLimit();
        const details = await scrapeListingPage(context, prop.url);
        if (details.maxGuests !== null && details.maxGuests < 20) {
          console.log(`[Airbnb] Skipping ${details.name || prop.name} (max ${details.maxGuests} guests)`);
          continue;
        }
        if (details.name) prop.name = details.name;
        if (details.maxGuests) prop.sleeps = details.maxGuests;
        if (details.location) prop.location = details.location;
        if (details.image) prop.image = details.image;
        if (details.games && details.games.length) prop.games = details.games;
        enriched.push(prop);
      } catch (err) {
        console.warn(`[Airbnb] Could not enrich ${prop.url}: ${err.message}`);
        enriched.push(prop); // keep it with search data
      }
    }

    const results = enriched.map(p => normalise(p, 'airbnb'));
    console.log(`[Airbnb] Total properties after filtering: ${results.length}`);
    return results;
  } finally {
    await browser.close();
  }
}

async function searchDateRange(context, range) {
  // adults=16 (Airbnb caps at 16), min_bedrooms=8 to force large properties, entire home only
  const baseUrl = `https://www.airbnb.co.uk/s/England/homes?adults=16&checkin=${range.checkin}&checkout=${range.checkout}&pets=1&price_max=6000&min_bedrooms=8&room_types%5B%5D=Entire%20home%2Fapt`;
  const allProperties = [];

  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const url = pageNum === 1 ? baseUrl : `${baseUrl}&items_offset=${(pageNum - 1) * 18}`;
    console.log(`[Airbnb] Processing page ${pageNum} for ${range.label}...`);

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[itemprop="itemListElement"], [data-testid="card-container"], [class*="listing"]', { timeout: 15000 }).catch(() => {});
      await sleep(3000);

      const properties = await extractListings(page);
      if (properties.length === 0) break;
      allProperties.push(...properties);
    } finally {
      await page.close();
    }

    await rateLimit();
  }

  return allProperties;
}

async function extractListings(page) {
  return page.evaluate(() => {
    // Build a map of listing ID -> coordinates from deferred state JSON.
    // Airbnb stores data in <script type="application/json" id="data-deferred-state-0">.
    // Parent objects have base64-encoded IDs like "RGVtYW5kU3RheUxpc3Rpbmc6NDk5ODMwMjY="
    // which decode to "DemandStayListing:49983026" — the number is the room ID.
    const coordsById = {};
    const priceById = {};

    function extractIdFromBase64(b64) {
      try {
        const decoded = atob(b64);
        const match = decoded.match(/:(\d+)$/);
        return match ? match[1] : null;
      } catch { return null; }
    }

    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 20) return;
      // Match objects with id + location.coordinate structure
      if (obj.id && obj.location && obj.location.coordinate) {
        const coord = obj.location.coordinate;
        if (coord.latitude && coord.longitude) {
          const numericId = extractIdFromBase64(String(obj.id)) || String(obj.id);
          coordsById[numericId] = { lat: coord.latitude, lng: coord.longitude };
        }
      }
      // Match objects with id + price data
      if (obj.id) {
        const numericId = extractIdFromBase64(String(obj.id)) || String(obj.id);
        if (!priceById[numericId]) {
          const priceStr = obj.avgPriceFormatted
            || obj.displayPrice
            || obj.price?.localizedAmount
            || obj.pricingQuote?.structuredStayDisplayPrice?.primaryLine?.accessibilityLabel
            || obj.pricingQuote?.price?.total?.amount;
          if (priceStr && typeof priceStr === 'string' && /[£$€\d]/.test(priceStr)) {
            priceById[numericId] = priceStr.trim();
          }
        }
      }
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item, depth + 1);
      } else {
        for (const key of Object.keys(obj)) {
          try { walk(obj[key], depth + 1); } catch {}
        }
      }
    }

    // Parse deferred state script tags
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.id || !script.id.startsWith('data-deferred-state')) continue;
      try {
        const data = JSON.parse(script.textContent);
        walk(data, 0);
      } catch {}
    }

    // Extract listing cards from DOM, matching IDs to coordinates
    const results = [];
    const listItems = document.querySelectorAll('[itemprop="itemListElement"]');
    const items = listItems.length > 0
      ? listItems
      : document.querySelectorAll('[data-testid="card-container"], .g1qv1ctd');

    for (const item of items) {
      const link = item.querySelector('a[href*="/rooms/"]');
      if (!link) continue;

      const href = link.href;
      const roomMatch = href.match(/\/rooms\/(\d+)/);
      if (!roomMatch) continue;

      const listingId = roomMatch[1];
      const url = 'https://www.airbnb.co.uk/rooms/' + listingId;

      const nameEl = item.querySelector('[id^="title_"]')
        || item.querySelector('div[data-testid="listing-card-title"]')
        || item.querySelector('span[style*="font-weight"]');
      const priceEl = item.querySelector('[data-testid="price-availability-row"] span')
        || item.querySelector('span[aria-label*="per night"]')
        || item.querySelector('span._1y74zjx, ._tyxjp1')
        || item.querySelector('[class*="price"] span, [class*="Price"] span');
      const imgEl = item.querySelector('img');

      const coord = coordsById[listingId];

      results.push({
        name: nameEl?.textContent?.trim() || 'Airbnb Property',
        url,
        price: priceById[listingId] || priceEl?.textContent?.trim() || null,
        image: imgEl?.src || null,
        location: 'England',
        lat: coord ? coord.lat : null,
        lng: coord ? coord.lng : null,
        games: [],
        sleeps: 20,
        available_dates: [],
      });
    }

    return results;
  });
}

async function scrapeListingPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    return await page.evaluate(() => {
      const result = { name: null, maxGuests: null, location: null, image: null, games: [] };

      // Real property name from the h1
      const h1 = document.querySelector('h1');
      if (h1) result.name = h1.textContent.trim();

      const pageText = document.body?.textContent || '';

      // "maximum of X guests" is the most reliable
      const maxMatch = pageText.match(/maximum\s+of\s+(\d+)\s+guests?/i);
      if (maxMatch) {
        result.maxGuests = parseInt(maxMatch[1], 10);
      } else {
        // Look for "X guests · Y bedrooms" pattern in the listing highlights
        // This appears near the top of the listing as a summary
        const summaryMatch = pageText.match(/(\d+)\s+guests?\s*[·•]\s*(\d+)\s+bedrooms?/i);
        if (summaryMatch) {
          result.maxGuests = parseInt(summaryMatch[1], 10);
        } else {
          // Fallback: "X guests" but only if X >= 8 (ignore "1 guest" per-room display)
          const guestMatches = [...pageText.matchAll(/(\d+)\s+guests?/gi)];
          for (const m of guestMatches) {
            const n = parseInt(m[1], 10);
            if (n >= 8) {
              result.maxGuests = n;
              break;
            }
          }
        }
      }

      // Location from breadcrumb or subtitle
      const locEl = document.querySelector('[data-testid="listing-card-subtitle"]')
        || document.querySelector('span[class*="location"]');
      if (locEl) result.location = locEl.textContent.trim();

      // Amenities — Airbnb renders them as [data-testid="amenity-row"] items,
      // or as text in a list under "What this place offers".
      // We collect all amenity text nodes and filter for ones we care about.
      const AMENITY_KEYWORDS = [
        'pool', 'hot tub', 'jacuzzi', 'sauna', 'snooker', 'billiard', 'pool table',
        'table tennis', 'ping pong', 'ping-pong', 'tennis court', 'games room',
        'games barn', 'cinema', 'home cinema', 'gym', 'bbq', 'barbecue', 'fire pit',
        'wood burner', 'open fire', 'fireplace', 'piano',
      ];
      const amenityEls = document.querySelectorAll(
        '[data-testid="amenity-row"], [data-section-id="AMENITIES"] li, [data-section-id="AMENITIES"] div[class]'
      );
      const seenAmenities = new Set();
      for (const el of amenityEls) {
        const text = el.textContent.trim().toLowerCase();
        for (const kw of AMENITY_KEYWORDS) {
          if (text.includes(kw) && !seenAmenities.has(kw)) {
            // Store original case from the element text (first ~40 chars)
            const display = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
            result.games.push(display);
            seenAmenities.add(kw);
            break;
          }
        }
      }
      // Fallback: if no amenity elements found, scan full page text for keywords
      if (result.games.length === 0) {
        for (const kw of AMENITY_KEYWORDS) {
          if (pageText.toLowerCase().includes(kw) && !seenAmenities.has(kw)) {
            result.games.push(kw.charAt(0).toUpperCase() + kw.slice(1));
            seenAmenities.add(kw);
          }
        }
      }

      // Main property photo — prefer JSON-LD schema (present in initial HTML before JS renders)
      // Airbnb embeds: <script type="application/ld+json"> { "@type":"LodgingBusiness", "image": [...] }
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent);
          const imgs = Array.isArray(data.image) ? data.image : (data.image ? [data.image] : []);
          const first = imgs.find(u => typeof u === 'string' && u.includes('muscache.com'));
          if (first) { result.image = first; break; }
        } catch {}
      }
      // Fallback: scan DOM img elements if JSON-LD had nothing
      if (!result.image) {
        const galleryImgs = document.querySelectorAll('picture img, div[data-testid*="photo"] img, main img');
        for (const img of galleryImgs) {
          const src = img.src || img.getAttribute('data-src') || '';
          if (!src) continue;
          if (src.includes('airbnb-platform-assets') || src.includes('AirbnbPlatformAssets')) continue;
          if (src.includes('icons/') || src.includes('favicon')) continue;
          if (src.includes('muscache.com') || src.includes('cloudfront') || src.includes('airbnb.com/im')) {
            result.image = src;
            break;
          }
        }
      }

      return result;
    });
  } finally {
    await page.close();
  }
}
