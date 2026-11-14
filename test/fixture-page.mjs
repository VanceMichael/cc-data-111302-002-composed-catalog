// 合成复现页：嵌套开放 shadow root、slot 后备文字、跨源授权 iframe、封闭组件。
// 仅用于测试，不依赖供应商网站。switch 先换身份；deferPrice 时价格要等 #sync 才跟上。
export const FIXTURE_DEVICES = [
  {device: 'D-1', generation: '1', power: '8 kW', price: '1200.00'},
  {device: 'D-2', generation: '2', power: '12 kW', price: '1800.00'},
  {device: 'D-3', generation: '3', power: '16 kW', price: '2400.00'}
];

export function fixturePageHtml({quoteUrl, deferPrice = false}) {
  return `<html lang="zh-CN"><meta charset="utf-8"><title>组合树夹具</title><body>
<h1>组合树夹具</h1>
<button id="switch">切换设备</button><button id="sync">同步报价</button>
<button id="slot">重分配标签</button><button id="reload">重载报价</button>
<button id="hide">隐藏字段</button>
<device-card id="card"><strong slot="label">额定功率</strong></device-card>
<closed-widget id="closed"></closed-widget>
<script>
const devices = ${JSON.stringify(FIXTURE_DEVICES)};
const deferPrice = ${JSON.stringify(deferPrice)};
const quoteFor = entry => ${JSON.stringify(quoteUrl)} + '?device=' + entry.device + '&generation=' + entry.generation;
class DeviceCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.shadowRoot.innerHTML = [
      '<article data-device="D-1" data-generation="1">',
      '<inner-label></inner-label>',
      '<slot name="label">默认功率</slot>',
      '<span id="power">8 kW</span>',
      '<iframe title="设备报价"></iframe>',
      '</article>'
    ].join('');
  }
  connectedCallback() {
    this.shadowRoot.querySelector('iframe').src = quoteFor(devices[0]);
  }
}
class InnerLabel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.shadowRoot.innerHTML = '<span class="caption">额定功率</span><slot name="unit">单位</slot>';
  }
}
class ClosedWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({mode: 'closed'});
    root.innerHTML = '<span id="power">99 kW</span>';
  }
}
customElements.define('device-card', DeviceCard);
customElements.define('inner-label', InnerLabel);
customElements.define('closed-widget', ClosedWidget);
const card = document.querySelector('#card');
const article = card.shadowRoot.querySelector('article');
const frame = card.shadowRoot.querySelector('iframe');
let index = 0;
const applyPrice = entry => {
  card.shadowRoot.querySelector('#power').textContent = entry.power;
  frame.src = quoteFor(entry);
};
document.querySelector('#switch').onclick = () => {
  index = (index + 1) % devices.length;
  const entry = devices[index];
  article.dataset.device = entry.device;
  article.dataset.generation = entry.generation;
  if (!deferPrice) applyPrice(entry);
};
document.querySelector('#sync').onclick = () => applyPrice(devices[index]);
document.querySelector('#slot').onclick = () => {
  card.querySelector('strong').slot = 'unused';
};
document.querySelector('#reload').onclick = () => { frame.src = quoteFor(devices[index]); };
document.querySelector('#hide').onclick = () => {
  card.shadowRoot.querySelector('#power').style.display = 'none';
};
</script></body></html>`;
}
