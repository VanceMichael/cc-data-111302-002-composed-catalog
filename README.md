# 组件化设备目录的组合树与展示代际采集

这是用于内部数据接入的 Node.js 项目。当前提供可独立启动的本地来源、单次原文读取接口以及来源契约测试；浏览器页面和仪器网关使用合成业务资料，不连接真实账户或设备。

## 环境与命令

Node.js 22.20.0 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start
```

`npm start` 在标准输出报告来源地址。默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定监听地址和端口，例如 `HOST=127.0.0.1 PORT=8080 npm start`。按 Ctrl+C 关闭来源；动态端口避免与同机其他接入站冲突。`npm run demo` 在同一进程启动来源，读取一次目录后退出，不代表持续接收业务已经完成。

```sh
docker build -t composed-catalog:local .
docker run --rm --network none composed-catalog:local
docker run --rm --network none composed-catalog:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。完整来源测试和一次目录演示通常数秒即可结束，适合在90秒以内查看真实输出。浏览器在无界面模式执行，页面交互不依赖人工鼠标。

## 目录

- `src/source.mjs`：本地来源生命周期与HTTP入口。
- `src/client.mjs`：目录读取及原始字节获取。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：来源协议范围、控制与领域语义。
- `test/source.test.mjs`：实际来源集成测试。

运行时状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。

在宿主机跑浏览器测试前执行 `npx playwright install --with-deps chromium`。容器已带匹配版本的 Chromium，不需要另行下载。
