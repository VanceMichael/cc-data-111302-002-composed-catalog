// 采集入口：启动本地来源页，在真实浏览器中遍历可访问组合树，
// 把结构化目录写到磁盘并打印摘要。可用 --page 指向其他已授权页面。
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {collectCatalog, writeCatalog, CATALOG_STATUS} from './collector.mjs';

function parseArgs(argv) {
  const args = {out: '.local/catalog', settle: undefined, page: undefined, selector: undefined};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`参数 ${item} 缺少取值`);
      return argv[index];
    };
    if (item === '--out') args.out = next();
    else if (item === '--settle') args.settle = Number(next());
    else if (item === '--page') args.page = next();
    else if (item === '--selector') args.selector = next();
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  return args;
}

function selectorsFrom(text) {
  if (!text) return undefined;
  return text.split(',').map(entry => {
    const [name, selector] = entry.split('=');
    if (!name || !selector) throw new Error(`字段选择器格式应为 名称=选择器：${entry}`);
    return {name: name.trim(), selector: selector.trim()};
  });
}

function printSummary(catalog) {
  const lines = [
    `状态: ${catalog.status}`,
    `页面: ${catalog.pageUrl}`,
    `身份: ${catalog.identity ? `${catalog.identity.device}/${catalog.identity.generation}` : '未识别'}`,
    `观察: ${catalog.observationCount} 次，用时 ${catalog.elapsed}ms`
  ];
  for (const field of catalog.fields) {
    const frame = field.frame.kind === 'iframe' ? field.frame.token : '主文档';
    const device = field.device ? `${field.device.device}/${field.device.generation}` : '未标注';
    const shown = field.visible ? field.value : `${field.text}（未显示）`;
    lines.push(`  ${field.field} = ${shown}  [${field.layer} · ${frame} · ${device}]`);
  }
  for (const frame of catalog.frames) {
    lines.push(`  frame ${frame.token}: ${frame.status}${frame.detail ? `（${frame.detail}）` : ''}`);
  }
  for (const item of catalog.unresolved) {
    lines.push(`  边界: ${item.host} ${item.note}`);
  }
  for (const warning of catalog.warnings) {
    if (warning.kind === 'frame-not-ready') continue;
    lines.push(`  提示: ${warning.kind}${typeof warning.detail === 'string' ? ` - ${warning.detail}` : ''}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node src/crawl.mjs [--out 目录] [--settle 毫秒] [--page URL] [--selector 名称=选择器,名称=选择器]');
    return 0;
  }

  await mkdir(resolve('.local'), {recursive: true});
  const source = await createSource();
  let browser;
  try {
    browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
    const page = await browser.newPage();
    const pageUrl = args.page
      ? (/^https?:/.test(args.page) ? args.page : source.url + args.page)
      : source.url + '/index.html';
    await page.goto(pageUrl, {waitUntil: 'domcontentloaded', timeout: 10000});

    const catalog = await collectCatalog(page, {
      selectors: selectorsFrom(args.selector),
      settleTimeout: Number.isFinite(args.settle) ? args.settle : undefined
    });
    const path = await writeCatalog(catalog, resolve(args.out));
    console.log(printSummary(catalog));
    console.log(`目录已写入: ${path}${catalog.record ? '' : '（未写出设备记录）'}`);
    const ok = catalog.status === CATALOG_STATUS.STABLE || catalog.status === CATALOG_STATUS.PARTIAL;
    return ok ? 0 : 3;
  } finally {
    if (browser) await browser.close();
    await source.close();
  }
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(`采集失败: ${error.message}`);
  process.exitCode = 4;
});
