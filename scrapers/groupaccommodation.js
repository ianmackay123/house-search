import { launchBrowser, fetchPage, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.groupaccommodation.com';

export async function scrapeGroupAccommodation() {
  console.log('[GA] Starting groupaccommodation.com scraper...');
  const { browser, context } = await launchBrowser();

  // Load enrichment data from property-details.json
  let enrichmentData = [];
  try {
    const raw = await readFile(join(__dirname, '..', 'property-details.json'), 'utf-8');
    enrichmentData = JSON.parse(raw);
  } catch (err) {
    console.warn('[GA] Could not load property-details.json for enrichment:', err.message);
  }

  try {
    // Phase 1: Search for properties
    const propertyUrls = await searchProperties(context);
    console.log(`[GA] Found ${propertyUrls.length} property URLs from search`);

    // Phase 2: Scrape each property
    const results = [];
    for (const url of propertyUrls) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, url, enrichmentData);
        if (prop) {
          results.push(normalise(prop, 'groupaccommodation'));
        }
      } catch (err) {
        console.error(`[GA] Error scraping ${url}: ${err.message}`);
      }
    }

    console.log(`[GA] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function searchProperties(context) {
  const searchUrl = `${BASE}/property-search?guests=20&facilities[0]=dog-friendly&country=united-kingdom`;
  const page = await context.newPage();
  const allUrls = new Set();

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for results to load
    await page.waitForSelector('.property-card, .search-result, [class*="property"]', { timeout: 10000 }).catch(() => {});

    // Collect property URLs from current page and paginate
    let pageNum = 1;
    while (true) {
      console.log(`[GA] Scraping search page ${pageNum}...`);

      const urls = await page.evaluate(() => {
        // Try multiple selectors for property links
        const links = [
          ...document.querySelectorAll('a[href*="/properties/"]'),
        ];
        return [...new Set(links
          .map(a => a.href)
          .filter(href => href.includes('/properties/') && !href.includes('/property-search'))
        )];
      });

      urls.forEach(u => allUrls.add(u));

      // Check for next page
      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector('a[rel="next"], .pagination a:last-child, a.next');
        if (nextBtn && !nextBtn.classList.contains('disabled')) {
          nextBtn.click();
          return true;
        }
        return false;
      });

      if (!hasNext) break;

      pageNum++;
      await page.waitForTimeout(2000);
      await page.waitForSelector('.property-card, .search-result, [class*="property"]', { timeout: 10000 }).catch(() => {});
    }
  } finally {
    await page.close();
  }

  return [...allUrls];
}

async function scrapeProperty(context, url, enrichmentData) {
  const page = await fetchPage(context, url);
  try {
    const details = await page.evaluate(() => {
      // Extract JSON-LD Schema.org data
      let jsonLd = null;
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data['@type'] === 'LodgingBusiness' || data['@type'] === 'VacationRental' ||
              data['@type'] === 'House' || data['@type'] === 'Accommodation' ||
              data['@type'] === 'Product' || data.geo) {
            jsonLd = data;
            break;
          }
          // Check for nested types
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.geo || item['@type']?.includes('Lodging')) {
                jsonLd = item;
                break;
              }
            }
          }
        } catch {}
      }

      // Extract from page content
      const name = document.querySelector('h1')?.textContent?.trim() || '';

      // Sleeps from page text
      let sleeps = null;
      const pageText = document.body?.textContent || '';
      const sleepsMatch = pageText.match(/sleeps?\s*(?:up\s*to\s*)?(\d+)/i);
      if (sleepsMatch) sleeps = parseInt(sleepsMatch[1], 10);

      // Location
      let location = '';
      const breadcrumbs = document.querySelectorAll('.breadcrumb a, [class*="breadcrumb"] a');
      if (breadcrumbs.length > 1) {
        location = [...breadcrumbs].slice(1).map(a => a.textContent.trim()).join(', ');
      }

      // Coordinates from JSON-LD
      let lat = null, lng = null;
      if (jsonLd?.geo) {
        lat = parseFloat(jsonLd.geo.latitude);
        lng = parseFloat(jsonLd.geo.longitude);
      }

      // Pets allowed
      let petsAllowed = null;
      if (jsonLd?.petsAllowed !== undefined) {
        petsAllowed = jsonLd.petsAllowed;
      }
      // Also check page text
      if (petsAllowed === null) {
        petsAllowed = /dog[s]?\s*(welcome|allowed|friendly)/i.test(pageText) ||
                      /pet[s]?\s*(welcome|allowed|friendly)/i.test(pageText);
      }

      // Features/games from page
      const games = [];
      const textLower = pageText.toLowerCase();
      if (textLower.includes('table tennis') || textLower.includes('ping pong')) games.push('Table tennis');
      if (textLower.includes('snooker')) games.push('Snooker');
      if (/pool\s*table/.test(textLower) || /\bpool\b/.test(textLower) && textLower.includes('games')) games.push('Pool');
      if (textLower.includes('table football') || textLower.includes('foosball')) games.push('Table football');
      if (textLower.includes('darts')) games.push('Darts');
      if (textLower.includes('hot tub')) games.push('Hot tub');

      // Image
      const image = document.querySelector('meta[property="og:image"]')?.content
        || document.querySelector('.property-image img, .gallery img, img[class*="property"]')?.src || null;

      return { name, sleeps, location, lat, lng, petsAllowed, games, image };
    });

    if (!details.name) return null;

    // Enrich with property-details.json data
    const enriched = enrichmentData.find(e =>
      details.name.toLowerCase().includes(e.name.toLowerCase()) ||
      e.name.toLowerCase().includes(details.name.toLowerCase()) ||
      (e.url && url.includes(e.url.split('/properties/')[1]?.split('?')[0] || '___'))
    );

    if (enriched) {
      // Use enriched games data if our page extraction found less
      if (enriched.key_features?.games?.length > details.games.length) {
        details.games = enriched.key_features.games;
      }
      // Use enriched coordinates if page didn't have them
      if (!details.lat && enriched.location?.coordinates_approximate) {
        details.lat = enriched.location.coordinates_approximate.lat;
        details.lng = enriched.location.coordinates_approximate.lng;
      }
      // Use enriched location
      if (!details.location && enriched.location) {
        const loc = enriched.location;
        details.location = [loc.village, loc.town, loc.county].filter(Boolean).join(', ');
      }
    }

    // Geocode if no coordinates
    if (!details.lat && details.location) {
      const coords = await geocode(details.location);
      if (coords) {
        details.lat = coords.lat;
        details.lng = coords.lng;
      }
    }

    return {
      name: details.name,
      sleeps: details.sleeps,
      location: details.location,
      lat: details.lat,
      lng: details.lng,
      games: details.games,
      image: details.image,
      url,
      price: null,
      available_dates: [],
    };
  } finally {
    await page.close();
  }
}
