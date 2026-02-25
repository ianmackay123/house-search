import { sleep } from './browser.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const cache = new Map();

async function nominatimSearch(query) {
  await sleep(1100);
  try {
    const params = new URLSearchParams({
      q: query + ', United Kingdom',
      format: 'json',
      limit: '1',
      countrycodes: 'gb',
    });
    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'HouseSearchScraper/1.0 (personal use)' },
    });
    if (!resp.ok) return null;
    const results = await resp.json();
    if (results.length > 0) {
      return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
    }
  } catch (err) {
    console.warn(`[Geocode] Failed for "${query}": ${err.message}`);
  }
  return null;
}

export async function geocode(locationStr) {
  if (!locationStr) return null;

  let query = locationStr
    .replace(/[()]/g, '')
    .replace(/\//g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return null;

  if (cache.has(query)) return cache.get(query);

  // Try the full query first
  let result = await nominatimSearch(query);
  if (result) {
    cache.set(query, result);
    return result;
  }

  // Fallback: try each comma-separated part individually, starting from the first
  // (most specific, e.g. "Painswick" in "Painswick, Cotswolds")
  const parts = query.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (cache.has(part)) {
      result = cache.get(part);
      if (result) {
        cache.set(query, result);
        return result;
      }
      continue;
    }
    result = await nominatimSearch(part);
    cache.set(part, result);
    if (result) {
      cache.set(query, result);
      return result;
    }
  }

  cache.set(query, null);
  return null;
}
