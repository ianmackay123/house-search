import { sleep } from './browser.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const cache = new Map();

export async function geocode(locationStr) {
  if (!locationStr) return null;

  // Clean up location string
  const query = locationStr.replace(/[()]/g, '').trim();
  if (!query) return null;

  if (cache.has(query)) return cache.get(query);

  // Rate limit: Nominatim requires max 1 req/sec
  await sleep(1100);

  try {
    const params = new URLSearchParams({
      q: query + ', United Kingdom',
      format: 'json',
      limit: '1',
      countrycodes: 'gb',
    });

    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: {
        'User-Agent': 'HouseSearchScraper/1.0 (personal use)',
      },
    });

    if (!resp.ok) return null;

    const results = await resp.json();
    if (results.length > 0) {
      const result = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      cache.set(query, result);
      return result;
    }
  } catch (err) {
    console.warn(`[Geocode] Failed for "${query}": ${err.message}`);
  }

  cache.set(query, null);
  return null;
}
