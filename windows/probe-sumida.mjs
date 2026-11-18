import {chromium} from 'playwright';

const target = 'https://yoyaku03.city.sumida.lg.jp/user/';
let browser;

try {
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({locale: 'ja-JP', timeZoneId: 'Asia/Tokyo'});
  const response = await page.goto(target, {waitUntil: 'commit', timeout: 60000});

  // Seeing the HTTP response alone does not prove the JS-based UI is usable.
  await page.locator('#divSearch').waitFor({state: 'visible', timeout: 45000});

  const challengeVisible = await page.locator('iframe[src*="challenges.cloudflare.com"]')
    .first().isVisible().catch(() => false);
  if (challengeVisible) {
    throw new Error('A browser verification challenge is shown. No bypass attempted.');
  }

  const path = new URL(page.url()).pathname;
  console.log(JSON.stringify({
    result: 'SUMIDA_PROBE_OK',
    httpStatus: response?.status() ?? null,
    path,
    searchPanelVisible: true
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: 'SUMIDA_PROBE_FAILED',
    error: error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error),
    note: 'A failed probe is NOT evidence that there are no available courts.'
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
