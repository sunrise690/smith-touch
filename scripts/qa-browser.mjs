/** 可选浏览器集成检查：安装 playwright，或通过 PLAYWRIGHT_MODULE 指向本机模块。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const base = process.env.TEST_URL || 'http://127.0.0.1:4286/';
const results = [];
await mkdir('test-results', { recursive: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width <= 1024, isMobile: viewport.width < 768 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('#smith-chart svg .point-group');
    assert.match(await page.locator('#metric-vswr').innerText(), /2\.618/);
    const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, textInputs: document.querySelectorAll('input:not([type="range"]):not([type="file"]),textarea,[contenteditable="true"]').length }));
    assert.ok(layout.documentWidth <= layout.viewport + 1, `页面横向溢出：${JSON.stringify(layout)}`);
    assert.equal(layout.textInputs, 0, '数值编辑不能依赖文本输入框');
    await page.getByRole('button', { name: '精确设置电阻 R', exact: true }).click();
    assert.equal(await page.locator('#number-dialog').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#number-dialog input').count(), 0);
    await page.locator('[data-key="5"]').click();
    await page.locator('[data-key="0"]').click();
    await page.locator('#apply-number').click();
    await page.waitForFunction(() => document.querySelector('[data-edit="loadR"] span').textContent === '50');
    assert.match(await page.locator('#metric-z').innerText(), /50/);
    await page.locator('[data-preset="lmatch"]').click();
    await page.waitForFunction(() => document.querySelector('#network-count').textContent === '2 个元件');
    assert.match(await page.locator('.network-result small').innerText(), /VSWR 1 : 1/);
    await page.locator('#sweep-toggle').click();
    await page.waitForSelector('#sweep-plot path', { state: 'attached' });
    assert.equal(await page.locator('.sweep-path').count(), 1);
    await page.locator('#bypass-button').click();
    await page.waitForSelector('.network-node.bypassed');
    assert.doesNotMatch(await page.locator('.network-result small').innerText(), /VSWR 1 : 1/);
    await page.locator('#undo-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.network-node.bypassed').length === 0);
    await page.locator('[data-preset="reactive"]').click();
    await page.locator('#match-button').click();
    await page.waitForFunction(() => document.querySelector('.network-result small').textContent === 'VSWR 1 : 1');
    await page.locator('#save-button').click();
    await page.reload();
    await page.waitForSelector('#smith-chart svg .point-group');
    assert.match(await page.locator('.network-result small').innerText(), /VSWR 1 : 1/);
    // 原生触屏事件检查圆图坐标映射与连续拖动。
    await page.locator('#reset-button').click();
    await page.locator('#smith-chart').scrollIntoViewIfNeeded();
    const bounds = await page.locator('#smith-chart svg').boundingBox();
    const x1 = bounds.x + bounds.width * .45;
    const y1 = bounds.y + bounds.height * .45;
    const x2 = bounds.x + bounds.width * .6;
    const y2 = bounds.y + bounds.height * .55;
    if (viewport.width <= 1024) {
      const session = await context.newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
      for (let i = 1; i <= 8; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2-x1)*i/8, y: y1+(y2-y1)*i/8 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else { await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up(); }
    await page.waitForFunction(() => !document.querySelector('#metric-z').textContent.startsWith('25 + j25'));
    assert.equal(errors.length, 0, `浏览器异常：${errors.join('; ')}`);
    await page.locator('[data-preset="lmatch"]').click();
    await page.evaluate(() => scrollTo(0,0));
    await page.locator('#toast').evaluate((node) => node.classList.remove('visible'));
    await page.screenshot({ path: `test-results/${viewport.width}-workspace.png`, fullPage: true });
    if (viewport.width === 390) {
      await page.getByRole('button', { name: '精确设置电容 C', exact: true }).click();
      await page.screenshot({ path: 'test-results/390-keypad.png' });
    }
    results.push({ viewport, ...layout, errors, touchDrag: 'passed', keypad: 'passed', network: 'passed', persistence: 'passed' });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await page.goto(base);
  const touchstone = '# MHz S RI R 50\n50 0.2 0.1\n100 0.1 0\n150 0.2 -0.1\n';
  await page.locator('#file-input').setInputFiles({ name: 'test.s1p', mimeType: 'text/plain', buffer: Buffer.from(touchstone) });
  await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'test.s1p');
  assert.match(await page.locator('#sweep-subtitle').innerText(), /3 个负载频点/);
  await page.locator('[data-add="line"]').click();
  assert.match(await page.locator('#selection-title').innerText(), /传输线/);
  await page.locator('[data-edit="elementRef"]').click();
  await page.locator('.close-keypad').click();
  const exportWait = page.waitForEvent('download'); await page.locator('#export-svg').click(); const file = await exportWait; assert.match(file.suggestedFilename(), /\.svg$/);
  // 有源与开路测量数据的手动编辑不得生成无法保存的工程。
  for (const coefficient of [2, 1]) {
    await page.locator('#file-input').setInputFiles({ name: 'edge.s1p', mimeType: 'text/plain', buffer: Buffer.from(`# MHz S RI R 50\n100 ${coefficient} 0\n150 ${coefficient} 0\n`) });
    await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'edge.s1p');
    await page.getByRole('button', { name: '精确设置电抗 X', exact: true }).click();
    await page.locator('[data-key="1"]').click(); await page.locator('[data-key="0"]').click(); await page.locator('#apply-number').click();
    await page.waitForFunction(() => document.querySelector('#number-error').textContent.includes('请先'));
    await page.locator('.close-keypad').click();
    const save = page.waitForEvent('download'); await page.locator('#save-button').click(); await save;
    if (coefficient === 2) { assert.equal(await page.locator('#chart-data-warning').isVisible(), true); assert.match(await page.locator('#sweep-plot').innerText(), /-10/); }
  }
  const dc = '# MHz S RI R 50\n0 0.2 0.1\n100 0.1 0\n';
  await page.locator('#file-input').setInputFiles({ name: 'dc.s1p', mimeType: 'text/plain', buffer: Buffer.from(dc) });
  await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'dc.s1p');
  assert.match(await page.locator('#toast').innerText(), /DC/);
  await context.close();
  results.push({ files: 'Touchstone S11 load + line reference + SVG download + active/open edit guards + DC import passed' });
  await writeFile('test-results/browser-qa.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
