import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {inspect,readRaw} from '../src/client.mjs';

async function withSource(callback){const source=await createSource();try{return await callback(source);}finally{await source.close();}}
function access(source){return async(path,options={})=>{const response=await fetch(source.url+path,{method:options.method||'GET',body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(4000)});const text=await response.text();let value=text;try{value=JSON.parse(text);}catch{}return {status:response.status,value};};}
test('来源存活与单次目录读取',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/health')).value.status,'ok');assert.ok(Object.keys(await inspect(source.url)).length>0);assert.ok((await readRaw(source.url,'/inventory')).length>0);}));
test('未知路径与坏控制请求明确拒绝',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/missing')).status,404);const invalid=await fetch(source.url+'/control',{method:'POST',body:'not-json'});assert.equal(invalid.status,400);}));
test('来源领域契约的状态变化',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/quote.html')).status,200); await api('/control',{method:'POST',body:{frameDenied:true}}); assert.equal((await api('/quote.html')).status,403);}));
test('真实浏览器页面交互',{timeout:15000},()=>withSource(async source=>{
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(source.url+'/index.html');assert.equal(await page.locator('device-card #power').textContent(),'8 kW'); await page.locator('#slot').click(); assert.equal(await page.locator('device-card strong').getAttribute('slot'),'unused'); await page.locator('#switch').click(); await page.waitForFunction(()=>document.querySelector('device-card').shadowRoot.querySelector('#power').textContent==='12 kW'); await page.frameLocator('iframe').locator('#price').waitFor().catch(()=>{}); assert.equal((await page.locator('device-card article').getAttribute('data-device')),'D-2');
    assert.deepEqual(errors,[]);await context.close();
  }finally{await browser.close();}
}));

