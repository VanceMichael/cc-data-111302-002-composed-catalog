# 来源协议

GET /index.html 是目录页。设备组件开放 shadow root，label slot 存在后备文字，quote iframe 使用 localhost 与主页面的127.0.0.1构成不同来源。切换设备会先变身份、120ms 后才更新报价；按钮可重分配 slot、重载 frame。POST /control 可设置 frameDenied。报价页返回 data-generation 与 data-device。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
