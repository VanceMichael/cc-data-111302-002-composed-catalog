# 组件化设备目录的组合树与展示代际采集

这是用于内部数据接入的 Node.js 项目。当前提供可独立启动的本地来源、单次原文读取接口、按组合树取数的浏览器目录采集，以及来源契约测试；浏览器页面和仪器网关使用合成业务资料，不连接真实账户或设备。

## 环境与命令

Node.js 22.20.0 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run crawl
npm start
```

`npm run crawl` 在无界面 Chromium 中打开来源页面，遍历可访问的组合树，把结构化目录写到 `.local/catalog/catalog.json` 并打印摘要。退出码：`0` 表示稳定或带边界说明的不完整目录，`3` 表示页面在等待上限内没有收敛，`4` 表示采集本身失败。

```sh
node src/crawl.mjs --out .local/run-1 --settle 4000
node src/crawl.mjs --page /index.html --selector 功率=#power,报价=#price
```

`npm start` 在标准输出报告来源地址。默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定监听地址和端口，例如 `HOST=127.0.0.1 PORT=8080 npm start`。按 Ctrl+C 关闭来源；动态端口避免与同机其他接入站冲突。`npm run demo` 在同一进程启动来源，读取一次目录后退出，不代表持续接收业务已经完成。

```sh
docker build -t composed-catalog:local .
docker run --rm --network none composed-catalog:local
docker run --rm --network none composed-catalog:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。完整来源测试和一次目录演示通常数秒即可结束，适合在90秒以内查看真实输出。浏览器在无界面模式执行，页面交互不依赖人工鼠标。

## 采集模型

一条目录记录同时回答三件事：字段值、它来自哪一层组件、读取时页面处于哪个设备身份。

- 可访问组合树：主文档、宿主元素的开放 shadow root（含嵌套）、以及浏览器允许访问的 iframe。iframe 元素若挂在 shadow root 中，也会经由同一组合树路径被发现。封闭 shadow root 不展开，只在 `unresolved` 中保留边界说明。
- 来源层级：每个字段带 `layer`（例如 `shadow-root(device-card#card)`、`slot`、`iframe(<token>) > main-document`）、`rootPath`、`path`、`element` 与 `frame`。
- slot：只有实际渲染出来的内容才算数据。分配节点的内容被样式隐藏时不算值；没有分配节点、且后备文字确实占据渲染空间时，后备文字才以 `slotFrom: fallback` 记入。`slotFrom` 说明该值来自分配内容还是后备内容。
- 设备身份：页面身份取自最近的 `data-device` / `data-generation` 容器；frame 身份取自其文档的 `data-device` / `data-generation`。每个字段都带 `device`，frame 记录带 `identity`，目录记录带整体 `identity`。
- 展示代际：同一张卡片切换设备时，页面身份与 frame 身份（或字段所在组件身份）不一致即视为过渡态。过渡态期间不写设备记录，只保留逐次观察轨迹。
- iframe 状态各自独立：`ready` / `denied` / `unloaded` / `invalid` / `error`。未授权或尚未加载的 frame 不会被另一个 frame 的同名字段补空；同名字段出现在多个 frame 时报告 `field-ambiguous`，按 frame 分别保留，不静默合并。
- 等待有上限：`--settle` 控制一致展示状态的等待上限；未加载的 frame 另有 `frameTimeout` 上限。到达上限后给出 `incomplete` 与具体原因，不无限等待。

目录状态：

| 状态 | 含义 | 是否写出设备记录 |
| --- | --- | --- |
| `stable` | 连续观察到一致展示状态，身份对齐，所有 frame 就绪 | 是 |
| `partial` | 部分 frame 未授权/无效等稳定边界，可访问部分已收敛 | 是，`complete: false` |
| `unsettled` | 观察到过渡态（身份或报价不同步） | 否 |
| `incomplete` | 等待超时或页面不可读 | 否 |

落盘文件使用 `schema: composed-catalog/1`，包含 `fields`、`frames`、`layers`、`unresolved`、`warnings` 与逐步 `trace`。每个字段都可通过 `frame.token` + `rootPath` + `path` 回查它当时所在的组件层与 frame。

## 目录

- `src/source.mjs`：本地来源生命周期与HTTP入口。
- `src/client.mjs`：目录读取及原始字节获取。
- `src/crawl.mjs`：浏览器采集入口，落盘并打印摘要。
- `src/collector.mjs`：组合树观察循环、身份对齐、过渡态与边界判定、落盘。
- `src/snapshot.mjs`：页面侧快照函数（在浏览器中执行），生成开放 shadow root、slot 与 frame 的结构化描述。
- `test/fixture-page.mjs`：测试用合成页面（嵌套 shadow root、slot 后备、跨源 iframe、封闭组件、可延迟的价格）。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：来源协议范围、控制与领域语义。
- `test/collector.test.mjs`：真实浏览器下的组合树、slot、过渡态、frame 重载与卡片复用测试。

运行时状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。

在宿主机跑浏览器测试前执行 `npx playwright install --with-deps chromium`。容器已带匹配版本的 Chromium，不需要另行下载。
