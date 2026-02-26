import { launchBrowser, fetchPage, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';

const BASE = 'https://www.thebigdomain.com';
const IMAGE_BASE_HC = 'https://files.holidaycottages.co.uk/FCImages';
const IMAGE_BASE_OC = 'https://files.originalcottages.co.uk/TOCCL';

// Search params for each date range (3-night stays)
const DATE_RANGES = [
  { arrivalDate: '24/09/2026', label: '24-27 Sep' },
  { arrivalDate: '25/09/2026', label: '25-28 Sep' },
];

export async function scrapeTheBigDomain(options = {}) {
  console.log('[TBD] Starting The Big Domain scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Visit homepage first to establish session + dismiss cookie banner
    const homePage = await fetchPage(context, BASE);
    await homePage.evaluate(() => {
      const btn = document.getElementById('onetrust-accept-btn-handler');
      if (btn) btn.click();
    });
    await homePage.waitForTimeout(500);
    await homePage.close();

    // Phase 1: Collect property URLs + images from search results for both date ranges
    const propertyMap = new Map(); // url -> { url, image, dates: [] }

    for (const range of DATE_RANGES) {
      const urls = await searchProperties(context, range.arrivalDate, range.label, options.limit);
      for (const { url, image } of urls) {
        if (!propertyMap.has(url)) {
          propertyMap.set(url, { url, image, dates: [] });
        }
        propertyMap.get(url).dates.push(range.label);
      }
    }

    console.log(`[TBD] Found ${propertyMap.size} unique properties across both date ranges`);

    // Phase 2: Scrape each property detail page
    const results = [];
    const entries = [...propertyMap.values()];
    const toScrape = options.limit ? entries.slice(0, options.limit) : entries;

    for (const entry of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, entry);
        if (prop) results.push(normalise(prop, 'thebigdomain'));
      } catch (err) {
        console.error(`[TBD] Error scraping ${entry.url}: ${err.message}`);
      }
    }

    console.log(`[TBD] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function searchProperties(context, arrivalDate, label, limit) {
  const results = [];
  let page = 1;

  while (true) {
    const encoded = encodeURIComponent(arrivalDate);
    const url = `${BASE}/cottages?getSearch=true&Dogs=1&Duration=3&PartySize=20&ArrivalDate=${encoded}&daysf=1&SortBy=Relevance&rpp=12&page=${page}&viewmap=false`;

    const pg = await fetchPage(context, url);
    try {
      await pg.waitForTimeout(1500);
      const data = await pg.evaluate(() => {
        const links = [...document.querySelectorAll('a[href*="/cottage/"]')];
        const seen = new Set();
        const props = [];
        for (const link of links) {
          const href = link.href.split('?')[0];
          if (seen.has(href)) continue;
          seen.add(href);
          const img = link.closest('[class]')?.querySelector('img')?.src || null;
          props.push({ url: href, image: img });
        }
        // Total count
        const bodyText = document.body.innerText;
        const countMatch = bodyText.match(/(\d[\d,]*)\s+propert/i);
        return { props, total: countMatch ? parseInt(countMatch[1].replace(',', ''), 10) : null };
      });

      if (data.props.length === 0) break;

      console.log(`[TBD] ${label} page ${page}: ${data.props.length} properties (total: ${data.total || '?'})`);

      for (const p of data.props) {
        if (!results.find(r => r.url === p.url)) results.push(p);
      }

      if (limit && results.length >= limit) break;

      const totalPages = data.total ? Math.ceil(data.total / 12) : 1;
      if (page >= totalPages) break;
      page++;
    } finally {
      await pg.close();
    }
  }

  return results;
}

async function scrapeProperty(context, entry) {
  const page = await fetchPage(context, entry.url + '?n=3');
  try {
    const details = await page.evaluate(() => {
      const name = document.querySelector('h1')?.textContent?.trim() || '';
      const meta = document.querySelector('meta[name="description"]')?.content || '';

      // Sleeps
      const allText = document.body.innerText;
      const sleepsMatch = allText.match(/[Ss]leeps?[\s:]*(\d+)/);
      const sleeps = sleepsMatch ? parseInt(sleepsMatch[1], 10) : null;

      // Location from meta description: "accommodation in South Wales"
      const locMatch = meta.match(/(?:in|near)\s+([A-Z][A-Za-z ,]+?)(?:\s*[-–]|\s*$)/);
      const location = locMatch ? locMatch[1].trim() : '';

      // Price
      const priceMatch = allText.match(/£[\d,]+(?:\s*-\s*£[\d,]+)?/);
      const price = priceMatch ? priceMatch[0] : null;

      // Rating
      const ratingMatch = allText.match(/(\d+\.?\d*)\s*(?:\/\s*5|out\s*of\s*5)/i)
        || allText.match(/(\d)\s*star/i);
      const rating = ratingMatch ? ratingMatch[1] : null;

      // Amenities from the property description list (3rd ul usually)
      const uls = [...document.querySelectorAll('ul')];
      const amenityItems = [];
      for (const ul of uls) {
        const items = [...ul.querySelectorAll('li')]
          .map(li => li.textContent.trim())
          .filter(t => t.length > 5 && t.length < 100 && !['Search','Inspire me','Big journal','Contact','Wishlist','Let your property'].includes(t));
        if (items.length >= 3) {
          amenityItems.push(...items);
          break;
        }
      }

      // Extract games from amenities text
      const amenText = amenityItems.join(' ').toLowerCase() + ' ' + allText.toLowerCase();
      const games = [];
      if (amenText.includes('table tennis') || amenText.includes('ping pong') || amenText.includes('ping-pong')) games.push('Table tennis');
      if (amenText.includes('snooker')) games.push('Snooker');
      if (/\bpool table\b|table.*\bpool\b|\bpool\b.*table/.test(amenText)) games.push('Pool');
      if (amenText.includes('table football') || amenText.includes('foosball')) games.push('Table football');
      if (amenText.includes('darts') || amenText.includes('dartboard')) games.push('Darts');
      if (amenText.includes('air hockey')) games.push('Air hockey');
      if (amenText.includes('games console') || amenText.includes('playstation') || amenText.includes('xbox') || amenText.includes('nintendo')) games.push('Games console');
      if (amenText.includes('cinema') || amenText.includes('movie room') || amenText.includes('film room')) games.push('Cinema');
      if (amenText.includes('piano')) games.push('Piano');
      if (amenText.includes('hot tub')) games.push('Hot tub');
      if (amenText.includes('indoor pool') || amenText.includes('swimming pool')) games.push('Swimming pool');
      if (amenText.includes('sauna')) games.push('Sauna');
      if (amenText.includes('tennis court')) games.push('Tennis court');
      if (amenText.includes('games room') || amenText.includes('games/play')) games.push('Games room');

      // Main image from page
      const img = document.querySelector('.owl-carousel img, [class*="gallery"] img, [class*="photo"] img, [class*="hero"] img')?.src || null;

      // Coordinates from maplat/maplng JS vars embedded in page scripts
      let lat = null, lng = null;
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent;
        const latM = t.match(/maplat[^=]*=\s*["']?(-?\d+\.\d+)/);
        const lngM = t.match(/maplng[^=]*=\s*["']?(-?\d+\.\d+)/);
        if (latM && lngM) { lat = parseFloat(latM[1]); lng = parseFloat(lngM[1]); break; }
      }

      return { name, meta, location, sleeps, price, rating, games, img, lat, lng };
    });

    if (!details.name) return null;
    if (details.sleeps && details.sleeps < 20) return null;

    // Fall back to geocoding only if page had no coords
    let lat = details.lat, lng = details.lng;
    if (!lat || !lng) {
      if (details.location) {
        const coords = await geocode(details.location + ', UK');
        if (coords) { lat = coords.lat; lng = coords.lng; }
      }
    }

    // Use search result image if detail page image not found
    const image = details.img || entry.image || null;

    return {
      name: details.name,
      sleeps: details.sleeps,
      location: details.location,
      lat, lng,
      games: details.games,
      image,
      url: entry.url,
      price: details.price,
      rating: details.rating ? `${details.rating}/5` : null,
      available_dates: entry.dates,
    };
  } finally {
    await page.close();
  }
}
