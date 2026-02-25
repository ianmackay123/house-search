import { chromium } from 'playwright';

const RATE_LIMIT_MS = 1500;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function rateLimit() {
  await sleep(RATE_LIMIT_MS);
}

export async function launchBrowser(options = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...options,
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-GB',
  });

  // Override webdriver detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Remove automation indicators
    delete window.__playwright;
    delete window.__pw_manual;
  });

  return { browser, context };
}

export async function fetchPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  } catch (err) {
    await page.close();
    throw err;
  }
}
