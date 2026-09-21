/** Run with Vite on :5178. Pass the Playwright package directory as argv[2] if it is not
 *  locally installed. Uses a fresh headless browser and local asset fixtures only. */
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'var/formation-review');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/assets/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice('/assets/'.length));
    const assetRoot = resolve(root, 'public/assets');
    const file = resolve(assetRoot, relative);
    assert.ok(file.startsWith(assetRoot + sep));
    try {
      const body = await readFile(file);
      await route.fulfill({ body, contentType: relative.endsWith('.json') ? 'application/json' : 'image/png' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://127.0.0.1:5178/test/formation.html');
  await page.locator('#defense .formation-grid').waitFor();
  console.log((await page.locator('main').innerText()).slice(0, 2000));
  assert.deepEqual(errors, []);
  await page.locator('#defense .formation-cell.filled').click();
  await page.locator('#army .formation-cell.wide').click();
  await page.locator('#visitor .formation-cell.filled').click();
  await page.screenshot({ path: resolve(output, 'formation-dark.png'), fullPage: true, animations: 'disabled' });
  if (process.argv.includes('--review')) {
    console.log('Review screenshot: ' + resolve(output, 'formation-dark.png'));
  } else {
    const emitted = () => page.evaluate(() => window.__formationTest.state.emitted);
    const defense = page.locator('#defense');
    const level = defense.getByRole('spinbutton', { name: 'Уровень выбранного юнита' });
    await level.fill('2');
    await level.press('Tab');
    assert.deepEqual((await emitted()).at(-1), { kind: 'level', cell: 2, value: 2 });
    await defense.getByRole('spinbutton', { name: 'Здоровье выбранного юнита' }).fill('500');
    await defense.getByRole('spinbutton', { name: 'Здоровье выбранного юнита' }).press('Tab');
    assert.deepEqual((await emitted()).at(-1), { kind: 'hp', cell: 2, value: 500 });

    // An empty cell opens the existing chooser in one click. A large unit merges that row
    // and subsequent edits target its primary cell rather than the previous back cell.
    await defense.getByRole('button', { name: 'Тыл, ряд 1: добавить юнита', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Выбор юнита/ });
    await dialog.waitFor();
    const ids = await page.evaluate(() => window.__formationTest.ids);
    await dialog.getByPlaceholder('Поиск по имени или расе…').fill(ids.large);
    await dialog.locator('.up-row').click();
    await defense.locator('.formation-cell.wide').waitFor();
    assert.match(await defense.locator('.formation-detail-head').innerText(), /Обе линии/);
    await defense.getByRole('spinbutton', { name: 'Здоровье выбранного юнита' }).fill('0');
    await defense.getByRole('spinbutton', { name: 'Здоровье выбранного юнита' }).press('Tab');
    assert.equal((await emitted()).at(-1).cell, 0);

    // Form-disabled preview still allows inspection, but has no editable fields or chooser.
    const beforeReadOnly = (await emitted()).length;
    await page.evaluate(() => { window.__formationTest.state.disabled = true; });
    await defense.locator('.formation-cell.filled').first().click();
    assert.equal(await defense.getByRole('spinbutton').count(), 0);
    assert.equal(await defense.getByRole('button', { name: 'Заменить', exact: true }).count(), 0);
    assert.equal(await defense.locator('.formation-cell:not(.filled):disabled').count(), 3);
    assert.equal((await emitted()).length, beforeReadOnly);
    await page.locator('#visitor .formation-cell.filled').click();
    assert.equal(await page.locator('#visitor').getByRole('spinbutton').count(), 0);
    assert.equal(await page.locator('#visitor .icon-badge').count(), 0); // no '?' portraits in empty cells

    // Switching inspected objects resets unit selection.
    await page.evaluate(() => { window.__formationTest.state.groupId = 'second'; });
    await defense.locator('.formation-hint').waitFor();
    assert.equal(await defense.locator('.formation-detail').count(), 0);

    // A leader blocks a large soldier from consuming its adjacent cell.
    await page.locator('#army').getByRole('button', { name: 'Тыл, ряд 1: добавить юнита', exact: true }).click();
    await dialog.getByPlaceholder('Поиск по имени или расе…').fill(ids.large);
    assert.equal(await dialog.locator('.up-row').getAttribute('aria-disabled'), 'true');
    const beforeBlocked = (await emitted()).length;
    await dialog.locator('.up-row').dispatchEvent('click'); // also test the handler gate
    assert.equal((await emitted()).length, beforeBlocked);
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();

    // Templates start with a hero, use the shared details panel and never expose HP.
    const template = page.locator('#template');
    await template.getByRole('button', { name: 'Фронт, ряд 1: добавить юнита', exact: true }).click();
    const leaderDialog = page.getByRole('dialog', { name: 'Лидер отряда — герой или вор', exact: true });
    await leaderDialog.getByPlaceholder('Поиск по имени или расе…').fill(ids.leader);
    await leaderDialog.locator('.up-row').click();
    await leaderDialog.waitFor({ state: 'hidden' });
    assert.equal(await template.getByRole('spinbutton').count(), 1);
    assert.equal(await template.getByRole('spinbutton', { name: 'Здоровье выбранного юнита' }).count(), 0);
    assert.equal(await template.locator('.formation-star').count(), 1);

    // Portrait cards must fit a narrow inspector without horizontal overflow, in both themes.
    const overflow = await page.locator('.formation').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 1).length);
    assert.equal(overflow, 0);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ path: resolve(output, 'formation-light.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('PASS: selection, stats, large units, read-only, reset, leader protection, templates, layout.');
  }
} finally {
  await browser.close();
}
