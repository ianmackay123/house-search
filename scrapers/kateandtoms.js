import { launchBrowser, fetchPage, rateLimit, sleep } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';

const BASE = 'https://kateandtoms.com';
const TARGET_DATES_SEP = [24, 25, 26, 27, 28]; // Sep 2026 days we care about
const MIN_SLEEPS = 20;

export async function scrapeKateAndToms(options = {}) {
  console.log('[K&T] Starting Kate & Tom\'s scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Phase 1: Get all property URLs from searchItems
    const allProperties = await getAllProperties(context);
    console.log(`[K&T] Found ${allProperties.length} total houses in searchItems`);

    // Phase 2: Filter by dog-friendly taxonomy page to get dog-friendly slugs
    const dogFriendlySlugs = await getDogFriendlySlugs(context);
    console.log(`[K&T] Found ${dogFriendlySlugs.size} dog-friendly properties`);

    // Phase 3: Get sleeps-20+ slugs
    const sleeps20Slugs = await getSleeps20Slugs(context);
    console.log(`[K&T] Found ${sleeps20Slugs.size} properties sleeping 20+`);

    // Intersect: must be both dog-friendly AND sleep 20+
    let candidateSlugs = [...dogFriendlySlugs].filter(s => sleeps20Slugs.has(s));
    console.log(`[K&T] ${candidateSlugs.length} properties are dog-friendly AND sleep 20+`);
    if (options.limit) candidateSlugs = candidateSlugs.slice(0, options.limit);

    // Phase 4: Scrape each property detail + availability
    const results = [];
    for (const slug of candidateSlugs) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, slug);
        if (prop) {
          results.push(normalise(prop, 'kateandtoms'));
          if (options.onBatch && results.length % 5 === 0) {
            await options.onBatch(results);
          }
        }
      } catch (err) {
        console.error(`[K&T] Error scraping ${slug}: ${err.message}`);
      }
    }

    console.log(`[K&T] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function getAllProperties(context) {
  const page = await fetchPage(context, `${BASE}/feature/dog-friendly/`);
  try {
    const items = await page.evaluate(() => {
      // searchItems is embedded in a global JS var on every page
      for (const script of document.querySelectorAll('script')) {
        const text = script.textContent;
        const match = text.match(/\"searchItems\"\s*:\s*(\[[\s\S]*?\])\s*\}/);
        if (match) {
          try { return JSON.parse(match[1]); } catch {}
        }
      }
      return [];
    });
    return items.filter(i => i.category === 'Houses');
  } finally {
    await page.close();
  }
}

async function getDogFriendlySlugs(context) {
  const page = await fetchPage(context, `${BASE}/feature/dog-friendly/`);
  try {
    const slugs = await page.evaluate(() => {
      return [...document.querySelectorAll('a.search-block')]
        .map(a => {
          const m = a.href.match(/\/houses\/([^/]+)\//);
          return m ? m[1] : null;
        })
        .filter(Boolean);
    });
    return new Set(slugs);
  } finally {
    await page.close();
  }
}

async function getSleeps20Slugs(context) {
  const page = await fetchPage(context, `${BASE}/size/holiday-cottages-sleeping-20/`);
  try {
    const slugs = await page.evaluate(() => {
      return [...document.querySelectorAll('a.search-block')]
        .map(a => {
          const m = a.href.match(/\/houses\/([^/]+)\//);
          return m ? m[1] : null;
        })
        .filter(Boolean);
    });
    return new Set(slugs);
  } finally {
    await page.close();
  }
}

async function scrapeProperty(context, slug) {
  // Fetch detail page
  const page = await fetchPage(context, `${BASE}/houses/${slug}/`);
  let details;
  try {
    details = await page.evaluate(() => {
      const meta = document.querySelectorAll('.house_page_meta_single');
      let sleeps = null;
      let location = '';
      if (meta.length >= 1) {
        const sleepsText = meta[0]?.textContent?.trim() || '';
        const m = sleepsText.match(/(\d+)/);
        if (m) sleeps = parseInt(m[1], 10);
      }
      if (meta.length >= 2) {
        location = meta[1]?.textContent?.trim() || '';
      }

      const name = document.querySelector('h1.entry-title')?.textContent?.trim()
        || document.querySelector('h1')?.textContent?.trim() || '';

      // Extract games/features from widget text
      const widgetTexts = [...document.querySelectorAll('.widget_text p, .widget_text li, .house_page_content p')]
        .map(el => el.textContent)
        .join(' ')
        .toLowerCase();

      const games = [];
      if (widgetTexts.includes('table tennis') || widgetTexts.includes('ping pong') || widgetTexts.includes('ping-pong')) games.push('Table tennis');
      if (widgetTexts.includes('snooker')) games.push('Snooker');
      if (widgetTexts.includes('pool table') || widgetTexts.match(/\bpool\b.*table/) || widgetTexts.match(/table.*\bpool\b/)) games.push('Pool');
      if (widgetTexts.includes('table football') || widgetTexts.includes('foosball')) games.push('Table football');
      if (widgetTexts.includes('darts') || widgetTexts.includes('dartboard')) games.push('Darts');
      if (widgetTexts.includes('air hockey')) games.push('Air hockey');
      if (widgetTexts.includes('games console') || widgetTexts.includes('playstation') || widgetTexts.includes('xbox') || widgetTexts.includes('nintendo')) games.push('Games console');
      if (widgetTexts.includes('cinema') || widgetTexts.includes('movie room') || widgetTexts.includes('film room')) games.push('Cinema');
      if (widgetTexts.includes('piano') || widgetTexts.includes('grand piano') || widgetTexts.includes('upright piano')) games.push('Piano');
      if (widgetTexts.includes('hot tub')) games.push('Hot tub');
      if (widgetTexts.includes('indoor pool') || widgetTexts.includes('swimming pool')) games.push('Swimming pool');

      // Try to extract a more specific location from the og:description or page text
      // K&T pages often mention the village/town in the description
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      const pageTitle = document.title || '';
      // Pattern: "in Devon", "in the Cotswolds", "near Painswick", "village of X"
      const bodyText = document.body?.textContent || '';
      // Extract place names mentioned in widget text (first few paragraphs)
      const introText = [...document.querySelectorAll('.widget_text p, .house_page_content p')]
        .slice(0, 6)
        .map(el => el.textContent)
        .join(' ');

      // Look for place name patterns in intro text
      const prepositions = 'in|near|outside|overlooking|of|to|from|around|between|towards';
      const placeRegex = new RegExp('(?:streets|village|town|heart|edge|hills|coast|shores|borders|outskirts|countryside|lanes|roads)?\\s*(?:' + prepositions + ')\\s+([A-Z][a-z]{2,}(?:\\s+[A-Z][a-z]+)?)', 'g');
      const skipWords = new Set(['England', 'Britain', 'The', 'This', 'Your', 'Our', 'Here', 'Maybe', 'But', 'And', 'With', 'From', 'Cook', 'Sleep', 'Watch', 'Explore', 'Discover', 'Book', 'Set', 'Instagram', 'Insta', 'Facebook', 'Twitter', 'Pinterest', 'Tiktok', 'Youtube', 'Google', 'Kate', 'Tom', 'More', 'View', 'Read', 'Find', 'Get', 'See', 'Call', 'Visit', 'Check', 'Help', 'Privacy', 'Terms']);
      let specificLocation = '';
      let match;
      while ((match = placeRegex.exec(introText)) !== null) {
        const place = match[1].trim();
        if (place && !skipWords.has(place) && place.length > 2) {
          specificLocation = place;
          break;
        }
      }

      // Hero image
      const heroImg = document.querySelector('.cslider img')?.getAttribute('data-orig-file')
        || document.querySelector('.cslider img')?.src || null;

      return { name, sleeps, location, specificLocation, games, image: heroImg };
    });
  } finally {
    await page.close();
  }

  if (!details.name) return null;
  if (details.sleeps && details.sleeps < MIN_SLEEPS) return null;

  // Fetch availability (booknow page)
  await rateLimit();
  let availability = { available: false, dates: [], price: null };
  try {
    availability = await scrapeAvailability(context, slug);
  } catch (err) {
    console.warn(`[K&T] Could not fetch availability for ${slug}: ${err.message}`);
  }

  // Geocode using specific location if available, otherwise fall back to region
  let lat = null, lng = null;
  const geocodeQuery = details.specificLocation
    ? `${details.specificLocation}, ${details.location}`
    : details.location;
  if (geocodeQuery) {
    const coords = await geocode(geocodeQuery);
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
    }
  }

  // Use specific location in display if we found one
  const displayLocation = details.specificLocation
    ? `${details.specificLocation}, ${details.location}`
    : details.location;

  return {
    name: details.name,
    sleeps: details.sleeps,
    location: displayLocation,
    lat,
    lng,
    games: details.games,
    image: details.image,
    url: `${BASE}/houses/${slug}/`,
    price: availability.price,
    available_dates: availability.dates,
  };
}

async function scrapeAvailability(context, slug) {
  const page = await fetchPage(context, `${BASE}/houses/${slug}/booknow/`);
  try {
    const result = await page.evaluate((targetDays) => {
      const tables = document.querySelectorAll('table.avail_table');
      let sepTable = null;

      // Find September 2026 table
      for (const table of tables) {
        const heading = table.previousElementSibling;
        if (heading && /september\s+2026/i.test(heading.textContent)) {
          sepTable = table;
          break;
        }
      }

      // Also check h2 headings before tables
      if (!sepTable) {
        const headings = document.querySelectorAll('h2.avail_subtitle');
        for (const h of headings) {
          if (/september\s+2026/i.test(h.textContent)) {
            let sibling = h.nextElementSibling;
            while (sibling && sibling.tagName !== 'TABLE') {
              sibling = sibling.nextElementSibling;
            }
            if (sibling) sepTable = sibling;
            break;
          }
        }
      }

      if (!sepTable) return { available: false, dates: [], price: null };

      const availDays = [];
      const cells = sepTable.querySelectorAll('td.bk_avail');
      for (const cell of cells) {
        const dayText = cell.textContent.trim();
        const day = parseInt(dayText, 10);
        if (!isNaN(day) && targetDays.includes(day)) {
          availDays.push(day);
        }
      }

      // Check if all days in either range are available
      const range1 = [24, 25, 26, 27]; // 24-27 Sep
      const range2 = [25, 26, 27, 28]; // 25-28 Sep
      const hasRange1 = range1.every(d => availDays.includes(d));
      const hasRange2 = range2.every(d => availDays.includes(d));

      const dates = [];
      if (hasRange1) dates.push('24-27 Sep');
      if (hasRange2) dates.push('25-28 Sep');

      // Try to extract price from the row containing day 24 or 25
      let price = null;
      const rows = sepTable.querySelectorAll('tr');
      for (const row of rows) {
        const dayCells = row.querySelectorAll('td');
        for (const cell of dayCells) {
          const day = parseInt(cell.textContent.trim(), 10);
          if (day === 24 || day === 25) {
            const priceCells = row.querySelectorAll('td.table_price');
            for (const pc of priceCells) {
              const text = pc.textContent.trim();
              if (text && !text.toLowerCase().includes('booked')) {
                price = text;
                break;
              }
            }
            break;
          }
        }
        if (price) break;
      }

      return { available: dates.length > 0, dates, price };
    }, TARGET_DATES_SEP);

    return result;
  } finally {
    await page.close();
  }
}
