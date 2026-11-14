// 集成测试：用真实浏览器验证组合树采集路径。
// 页面由本地来源或测试内合成页提供，不访问供应商网站。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createSource} from '../src/source.mjs';
import {collectCatalog, writeCatalog, CATALOG_STATUS, FRAME_STATUS} from '../src/collector.mjs';
import {fixturePageHtml, FIXTURE_DEVICES} from './fixture-page.mjs';

async function withBrowser(run) {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

async function withSource(run) {
  const source = await createSource();
  try {
    return await run(source);
  } finally {
    await source.close();
  }
}

function fieldBy(catalog, name, frameKind) {
  return catalog.fields.find(field => field.field === name && field.frame.kind === frameKind);
}

const priceByDevice = Object.fromEntries(FIXTURE_DEVICES.map(item => [item.device, item.price]));

async function openFixture(page, {deferPrice = false} = {}) {
  const html = fixturePageHtml({quoteUrl: 'http://localhost:9876/quote-fixture.html', deferPrice});
  await page.route('**/fixture.html', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: html
  }));
  await page.route('**/quote-fixture.html*', async route => {
    const query = new URL(route.request().url()).searchParams;
    const device = query.get('device') ?? 'D-1';
    const generation = query.get('generation') ?? '1';
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<body data-device="${device}" data-generation="${generation}"><span id="price">${priceByDevice[device] ?? '0.00'}</span></body>`
    });
  });
  await page.goto('http://127.0.0.1:9876/fixture.html');
}

test('组合树目录记录字段来源、设备身份与 frame 状态', {timeout: 20000}, () =>
  withBrowser(browser => withSource(async source => {
    const page = await browser.newPage();
    try {
      await page.goto(source.url + '/index.html');
      const catalog = await collectCatalog(page);

      assert.equal(catalog.status, CATALOG_STATUS.STABLE);
      assert.equal(catalog.complete, true);
      assert.equal(catalog.identity.device, 'D-1');
      assert.equal(catalog.identity.generation, '1');

      const power = fieldBy(catalog, 'power', 'main');
      assert.equal(power.value, '8 kW');
      assert.equal(power.layer, 'shadow-root(device-card#card)');
      assert.deepEqual(power.path, ['html', 'body', 'device-card#card', '#shadow-root', 'article']);
      assert.deepEqual(power.rootPath, [
        {kind: 'document', url: source.url + '/index.html'},
        {kind: 'shadow-root', mode: 'open', host: 'device-card#card'}
      ]);
      assert.equal(power.device.device, 'D-1');
      assert.equal(power.device.at, 'article');

      const label = fieldBy(catalog, 'label', 'main');
      assert.equal(label.value, '额定功率');
      assert.equal(label.slotFrom, 'assigned');
      assert.ok(label.slotHostRootPath.some(part => part.mode === 'open'));

      const price = fieldBy(catalog, 'price', 'iframe');
      assert.equal(price.value, '1200.00');
      assert.equal(price.frame.status, FRAME_STATUS.READY);
      assert.equal(price.device.device, 'D-1');
      assert.ok(price.layer.startsWith('iframe('));
      assert.equal(price.frame.url.startsWith('http://localhost:'), true);

      assert.equal(catalog.frames.length, 1);
      assert.equal(catalog.frames[0].status, FRAME_STATUS.READY);
      assert.equal(catalog.frames[0].identity.device, 'D-1');
      assert.equal(catalog.frames[0].boundary, null);

      assert.ok(catalog.layers.some(layer => layer.source === 'main'));
      assert.ok(catalog.layers.some(layer => layer.source === 'iframe'));

      const roots = catalog.layers.flatMap(layer => layer.roots);
      assert.ok(roots.some(root => root.mode === 'open' && root.host === 'device-card#card'));
      assert.ok(roots.every(root => root.mode === 'open' || root.mode === 'document'));
    } finally {
      await page.close();
    }
  })));

test('slot 后备文字只在分配节点不显示时才算数据', {timeout: 20000}, () =>
  withBrowser(browser => withSource(async source => {
    const page = await browser.newPage();
    try {
      await page.goto(source.url + '/index.html');
      const before = await collectCatalog(page);
      assert.equal(fieldBy(before, 'label', 'main').slotFrom, 'assigned');
      assert.equal(fieldBy(before, 'label', 'main').value, '额定功率');

      await page.locator('#slot').click();
      const after = await collectCatalog(page);
      const label = fieldBy(after, 'label', 'main');
      assert.equal(label.slotFrom, 'fallback');
      assert.equal(label.value, '默认功率');
      assert.equal(after.status, CATALOG_STATUS.STABLE);

      // 分配内容虽然还在 DOM 中，但没有被渲染，因此不能算作展示数据。
      assert.equal(
        after.fields.some(field => field.field === 'label' && field.value === '额定功率'),
        false
      );
    } finally {
      await page.close();
    }
  })));

test('先换身份、后换价格：过渡态不写成设备记录，同步后才稳定', {timeout: 25000}, () =>
  withBrowser(async browser => {
    const page = await browser.newPage();
    try {
      await openFixture(page, {deferPrice: true});
      await page.locator('#switch').click();

      const during = await collectCatalog(page, {settleTimeout: 1500, pollInterval: 60});
      assert.equal(during.status, CATALOG_STATUS.UNSETTLED);
      assert.equal(during.record, null);
      assert.equal(during.complete, false);
      assert.equal(during.identity.device, 'D-2');
      const price = during.fields.find(field => field.field === 'price');
      assert.equal(price, undefined);
      assert.ok(during.warnings.some(warning => warning.kind === 'transition-detected'));
      assert.ok(during.elapsed < 2500, '不稳定页面必须在超时上限内结束');
      assert.ok(during.trace.some(entry => entry.transition && entry.transition.some(item => item.source === 'iframe')));

      // 组件同步价格后，同一次切换才允许写成一条完整设备记录。
      await page.locator('#sync').click();
      const after = await collectCatalog(page, {settleTimeout: 2500});
      assert.equal(after.status, CATALOG_STATUS.STABLE);
      assert.equal(after.identity.device, 'D-2');
      assert.equal(fieldBy(after, 'power', 'main').value, '12 kW');
      assert.equal(fieldBy(after, 'power', 'main').device.device, 'D-2');
      assert.equal(fieldBy(after, 'price', 'iframe').value, '1800.00');
      assert.equal(fieldBy(after, 'price', 'iframe').device.device, 'D-2');
      assert.equal(after.record.identity.device, 'D-2');
    } finally {
      await page.close();
    }
  }));

test('同一卡片连续复用：每次目录只包含当前设备的身份与价格', {timeout: 25000}, () =>
  withBrowser(async browser => {
    const page = await browser.newPage();
    try {
      await openFixture(page);
      const seen = [];
      for (const [index, expected] of FIXTURE_DEVICES.entries()) {
        if (index > 0) await page.locator('#switch').click();
        const catalog = await collectCatalog(page, {settleTimeout: 2500});
        assert.equal(catalog.status, CATALOG_STATUS.STABLE);
        assert.equal(catalog.identity.device, expected.device);
        assert.equal(fieldBy(catalog, 'power', 'main').value, expected.power);
        assert.equal(fieldBy(catalog, 'price', 'iframe').value, expected.price);
        assert.equal(fieldBy(catalog, 'price', 'iframe').device.device, expected.device);
        seen.push(catalog.identity.device);
      }
      assert.deepEqual(seen, ['D-1', 'D-2', 'D-3']);
    } finally {
      await page.close();
    }
  }));

test('未授权与未加载 iframe 分别呈现，且不用其他 frame 的同名字段补空', {timeout: 30000}, () =>
  withBrowser(browser => withSource(async source => {
    const page = await browser.newPage();
    try {
      await page.goto(source.url + '/index.html');
      await page.locator('#reload').click();
      await page.waitForTimeout(200);

      // 在同一个卡片里挂第二个 frame，其同名 price 不应填补被拒 frame 的空位。
      await page.evaluate(() => {
        const article = document.querySelector('device-card').shadowRoot.querySelector('article');
        const decoy = document.createElement('iframe');
        decoy.title = '干扰报价';
        decoy.srcdoc = '<span id="price">0.00</span>';
        article.append(decoy);
      });
      await page.waitForTimeout(150);

      const authorized = await collectCatalog(page);
      assert.equal(authorized.frames.length, 2, '应看到两个 frame');
      // 两个 frame 都有同名 price 时只报告歧义，不静默合并成一个值。
      const ambiguous = authorized.warnings.find(warning => warning.kind === 'field-ambiguous');
      assert.ok(ambiguous);
      assert.equal(ambiguous.field, 'price');
      assert.equal(fieldBy(authorized, 'price', 'iframe').value, '1200.00');

      await page.evaluate(() => fetch('/control', {
        method: 'POST',
        body: JSON.stringify({frameDenied: true})
      }));
      await page.locator('#reload').click();

      const denied = await collectCatalog(page, {settleTimeout: 2500, frameTimeout: 2500});
      const deniedFrame = denied.frames.find(frame => frame.status === FRAME_STATUS.DENIED);
      assert.ok(deniedFrame);
      assert.equal(deniedFrame.httpStatus, 403);
      assert.ok(deniedFrame.boundary.includes('未授权'));
      assert.equal(denied.status, CATALOG_STATUS.PARTIAL);
      assert.equal(denied.complete, false);
      // 被拒 frame 一个字段都不能贡献；另一个 frame 的 price 只能归属它自己。
      assert.equal(
        denied.fields.some(field => field.frame.token === deniedFrame.token),
        false
      );
      const decoyPrice = denied.fields.find(field => field.field === 'price');
      assert.ok(decoyPrice, '另一个已就绪 frame 的同名字段仍按它自己的来源保留');
      assert.notEqual(decoyPrice.frame.token, deniedFrame.token);
      assert.equal(decoyPrice.value, '0.00');
      const otherFrame = denied.frames.find(frame => frame.token !== deniedFrame.token);
      assert.ok(otherFrame, '应保留第二个 frame 的独立状态');
      assert.notEqual(otherFrame.status, FRAME_STATUS.DENIED);

      // 未加载的 frame 与未授权分别报告，且等待有上限。
      const stalled = await browser.newPage();
      await stalled.route('**/quote.html*', () => {});
      await stalled.goto(source.url + '/index.html', {waitUntil: 'domcontentloaded'});
      const unloaded = await collectCatalog(stalled, {settleTimeout: 2200, frameTimeout: 1200});
      assert.equal(unloaded.status, CATALOG_STATUS.INCOMPLETE);
      assert.equal(unloaded.record, null);
      const unloadedFrame = unloaded.frames.find(frame => frame.status === FRAME_STATUS.UNLOADED);
      assert.ok(unloadedFrame, '应分别报告尚未加载的 frame');
      assert.ok(unloadedFrame.boundary.includes('尚未加载'));
      assert.equal(unloaded.fields.some(field => field.field === 'price'), false);
      assert.ok(unloaded.elapsed < 2600);
      await stalled.close();
    } finally {
      await page.close();
    }
  })));

test('iframe 重载后字段来源与取值都更新为新一轮 frame', {timeout: 20000}, () =>
  withBrowser(browser => withSource(async source => {
    const page = await browser.newPage();
    try {
      await page.goto(source.url + '/index.html');
      const first = await collectCatalog(page);
      const firstPrice = fieldBy(first, 'price', 'iframe');
      assert.equal(firstPrice.value, '1200.00');

      await page.locator('#reload').click();
      const second = await collectCatalog(page);
      const secondPrice = fieldBy(second, 'price', 'iframe');
      assert.equal(secondPrice.value, '1200.00');
      assert.notEqual(secondPrice.frame.url, firstPrice.frame.url);
      assert.equal(secondPrice.frame.status, FRAME_STATUS.READY);

      // 来源换价后重载，验证读到的是新文档而不是旧缓存值。
      await page.evaluate(() => fetch('/control', {
        method: 'POST',
        body: JSON.stringify({price: '1999.00'})
      }));
      await page.locator('#reload').click();
      const third = await collectCatalog(page);
      assert.equal(fieldBy(third, 'price', 'iframe').value, '1999.00');
      assert.notEqual(fieldBy(third, 'price', 'iframe').frame.url, secondPrice.frame.url);
    } finally {
      await page.close();
    }
  })));

test('嵌套开放 shadow root 与封闭组件边界', {timeout: 20000}, () =>
  withBrowser(async browser => {
    const page = await browser.newPage();
    try {
      await openFixture(page);
      const catalog = await collectCatalog(page);
      assert.equal(catalog.status, CATALOG_STATUS.STABLE);

      const roots = catalog.layers.flatMap(layer => layer.roots);
      assert.ok(roots.some(root => root.host === 'device-card#card'));
      assert.ok(roots.some(root => root.host === 'inner-label'));
      const nested = roots.find(root => root.host === 'inner-label');
      assert.ok(nested.rootPath.some(part => part.host === 'device-card#card'));

      const label = catalog.fields.find(field => field.field === 'label');
      assert.equal(label.value, '额定功率');
      assert.equal(label.slotFrom, 'assigned');

      const unit = catalog.fields.find(field => field.field === 'unit');
      assert.equal(unit.value, '单位');
      assert.equal(unit.slotFrom, 'fallback');

      assert.equal(catalog.unresolved.length, 1);
      assert.equal(catalog.unresolved[0].host, 'closed-widget#closed');
      assert.equal(catalog.unresolved[0].reason, 'closed-or-absent-shadow-root');
      assert.ok(catalog.unresolved[0].note.includes('封闭组件'));
      assert.equal(catalog.fields.some(field => field.value === '99 kW'), false);

      // 隐藏的字段不进入目录值，但保留可见性说明。
      await page.locator('#hide').click();
      const hidden = await collectCatalog(page);
      const power = hidden.fields.find(field => field.field === 'power');
      assert.equal(power.visible, false);
      assert.equal(power.value, null);
    } finally {
      await page.close();
    }
  }));

test('目录可落盘并按字段回查来源', {timeout: 20000}, () =>
  withBrowser(browser => withSource(async source => {
    const page = await browser.newPage();
    try {
      await page.goto(source.url + '/index.html');
      const catalog = await collectCatalog(page);
      const path = await writeCatalog(catalog, '.local/test-catalog');
      const saved = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(saved.schema, 'composed-catalog/1');
      assert.equal(saved.status, CATALOG_STATUS.STABLE);
      assert.equal(saved.identity.device, 'D-1');
      assert.equal(saved.fields.length, catalog.fields.length);
      for (const field of saved.fields) {
        assert.ok(field.layer);
        assert.ok(field.frame.kind);
        assert.equal(field.device.device, 'D-1');
      }
      assert.ok(saved.trace.length >= 3);
      assert.ok(saved.frames.every(frame => 'status' in frame));
    } finally {
      await page.close();
    }
  })));
