import { launchBrowser, fetchPage, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.groupaccommodation.com';

export async function scrapeGroupAccommodation(options = {}) {
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
    let propertyUrls = await searchProperties(context);
    console.log(`[GA] Found ${propertyUrls.length} property URLs from search`);
    if (options.limit) propertyUrls = propertyUrls.slice(0, options.limit);

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
      // Try range first (e.g. "sleeps 20-30" or "20 - 30 guests") — take upper bound
      const sleepsRangeMatch = pageText.match(/sleeps?\s*(\d+)\s*[-–]\s*(\d+)/i)
        || pageText.match(/(\d+)\s*[-–]\s*(\d+)\s*guests?/i);
      if (sleepsRangeMatch) {
        sleeps = Math.max(parseInt(sleepsRangeMatch[1], 10), parseInt(sleepsRangeMatch[2], 10));
      } else {
        const sleepsMatch = pageText.match(/sleeps?\s*(?:up\s*to\s*)?(\d+)/i);
        if (sleepsMatch) sleeps = parseInt(sleepsMatch[1], 10);
      }

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
      if (textLower.includes('piano')) games.push('Piano');

      // Image
      const image = document.querySelector('meta[property="og:image"]')?.content
        || document.querySelector('.property-image img, .gallery img, img[class*="property"]')?.src || null;

      // Detect hotels: description calls itself a hotel/hostel/inn (not just the name)
      const descriptionText = (
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('.property-description, [class*="description"], [class*="intro"]')?.textContent ||
        ''
      ).toLowerCase();
      const hotelDescKeywords = ['hotel', 'hostel', 'inn', 'bed and breakfast', 'b&b', 'guesthouse'];
      const isHotel = hotelDescKeywords.some(kw => descriptionText.includes(kw))
        || hotelDescKeywords.some(kw => textLower.slice(0, 500).includes(kw));

      return { name, sleeps, location, _rawLocation: location, lat, lng, petsAllowed, games, image, isHotel };
    });

    if (!details.name) return null;

    // Skip hotels/hostels — we only want full rental properties
    const nameLower = details.name.toLowerCase();
    const hotelKeywords = ['hotel', 'hostel', 'b&b', 'bed and breakfast', 'motel'];
    if (hotelKeywords.some(kw => nameLower.includes(kw)) || details.isHotel) {
      console.log(`[GA] Skipping non-rental property: ${details.name}`);
      return null;
    }

    // Clean up breadcrumb location: "Europe, UK, England, South West England, Cornwall, Newquay"
    // → extract last 2-3 meaningful parts (skip Europe, UK, England, region)
    if (details.location) {
      const parts = details.location.split(',').map(s => s.trim());
      const skipPrefixes = ['europe', 'uk', 'united kingdom', 'england', 'scotland', 'wales',
        'south west england', 'south east england', 'north west england', 'north east england',
        'east of england', 'east midlands', 'west midlands', 'yorkshire'];
      const useful = parts.filter(p => !skipPrefixes.includes(p.toLowerCase()));
      details.location = useful.length > 0 ? useful.join(', ') : parts.slice(-2).join(', ');
    }

    // Skip non-UK results
    const origBreadcrumb = (details._rawLocation || details.location || '').toLowerCase();
    const nonUkCountries = ['greece', 'france', 'spain', 'portugal', 'italy', 'australia',
      'new zealand', 'south africa', 'ireland', 'croatia', 'turkey', 'morocco', 'germany'];
    if (nonUkCountries.some(c => origBreadcrumb.includes(c))) {
      console.log(`[GA] Skipping non-UK property: ${details.name}`);
      return null;
    }

    // Enrich with property-details.json data — match on URL slug
    const urlSlug = url.split('/properties/')[1]?.replace(/\/$/, '') || '';
    const enriched = enrichmentData.find(e => {
      const eSlug = (e.url || '').split('/properties/')[1]?.replace(/\/$/, '') || '';
      if (eSlug && urlSlug && eSlug === urlSlug) return true;
      if (details.name.toLowerCase().includes(e.name.toLowerCase())) return true;
      if (e.name.toLowerCase().includes(details.name.toLowerCase())) return true;
      return false;
    });

    if (enriched) {
      console.log(`[GA] Enriched "${details.name}" from property-details.json`);
      if (enriched.key_features?.games?.length > details.games.length) {
        details.games = enriched.key_features.games;
      }
      if (!details.lat && enriched.location?.coordinates_approximate) {
        details.lat = enriched.location.coordinates_approximate.lat;
        details.lng = enriched.location.coordinates_approximate.lng;
      }
      if (enriched.location) {
        const loc = enriched.location;
        const enrichedLoc = [loc.village, loc.town, loc.county].filter(Boolean).join(', ');
        if (enrichedLoc) details.location = enrichedLoc;
      }
    }

    // Geocode if still no coordinates
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
