# 来源协议

GET /index.html 是目录页。设备组件开放 shadow root，label slot 存在后备文字，quote iframe 使用 localhost 与主页面的127.0.0.1构成不同来源。切换设备会先变身份、120ms 后才更新报价；按钮可重分配 slot、重载 frame。POST /control 可设置 frameDenied。报价页返回 data-generation 与 data-device。

`GET /quote.html` 返回的报价页以 HTTP 状态区分来源：正常报价为 200 且 `Content-Type: text/html`；`frameDenied` 时为 403，并以 JSON 错误页呈现。采集器把 403 记为未授权、把 `about:blank` 记为尚未加载，两者都不借用其他 frame 的同名字段。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。

## 采集侧边界

组合树采集只读取浏览器允许访问的内容：主文档、开放 shadow root、以及可访问的 iframe。封闭 shadow root 不展开，只在目录的 `unresolved` 中记录宿主与原因。来源不提供绕过授权或封闭组件的入口，采集器也不会通过 `/control` 或 `/state` 直接写入业务结果。
