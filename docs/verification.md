# 交付验证记录

验证日期：2026-10-30。运行环境：Node.js 24、Windows 上的 Microsoft Edge 无头浏览器。移动设备检查采用触摸事件和视口模拟，尚未在用户的实体手机或平板上实测。

## 计算与工程格式

`node --test tests/*.test.js`：40 项通过，无失败。

覆盖复数运算、阻抗与反射系数的往返、开短路、RLC 单位、理想无耗线、支节奇点、电长度参考频率、扫频、Touchstone RI/MA/DB、SMC 子集解析、项目边界与版本校验、中文工程链接和解析 L 型匹配。混合网络使用独立 ABCD 矩阵基线交叉核验。

原软件三份工程的 12 个元件逐节点对照结果见 [行为复现记录](reverse-engineering.md)。最大阻抗实部或虚部分量差小于 0.00015 Ω。

## 浏览器与触控

对本地预览和已部署的 HTTPS 版本分别运行 `scripts/qa-browser.mjs`。

| 视口 | 页面横向溢出 | 内置数字盘 | 圆图拖动 | 匹配/撤销/恢复 |
| --- | --- | --- | --- | --- |
| 1440 × 1000 | 无 | 通过 | 鼠标通过 | 通过 |
| 1024 × 768 | 无 | 通过 | 触摸通过 | 通过 |
| 768 × 1024 | 无 | 通过 | 触摸通过 | 通过 |
| 390 × 844 | 无 | 通过 | 触摸通过 | 通过 |
| 360 × 740 | 无 | 通过 | 触摸通过 | 通过 |

数字编辑界面没有可编辑文本输入框，数字按钮不会请求移动系统输入法。文件选择通过浏览器本地文件选择器完成。浏览器检查期间未记录脚本异常。

已检查 Touchstone 导入、SMC 导入、SVG 下载、传输线参考频率、数据负载切换、有源 S11、开路测量数据编辑保护和 DC 点处理。Touchstone 中的 0 Hz 点被明确提示并忽略；只有 DC 点的文件不能用来进行交流元件计算。

已部署地址返回 HTTP 200，GitHub Pages 构建和部署成功。已等待 Service Worker 就绪后禁用网络、重新加载页面，并完成四分之一波长匹配计算；离线检查通过。

## 复跑浏览器检查

该检查是可选开发工具，运行应用无需 Playwright。安装 Playwright 和其浏览器后，先运行 `node scripts/serve.js`，再在另一个终端设置 `TEST_URL` 为服务打印的地址并运行 `node scripts/qa-browser.mjs`。

PowerShell 示例：

```powershell
$env:TEST_URL='http://127.0.0.1:4173/'
$env:BROWSER_CHANNEL='msedge'
node scripts/qa-browser.mjs
```

已有 Playwright 模块时可通过 `PLAYWRIGHT_MODULE` 指向其 `index.mjs`；未指定浏览器通道时使用 Playwright 自带 Chromium。截图和检查输出写入忽略提交的 `test-results/`。

本记录不表示已经实现原版完整二端口分析；增益、噪声、稳定圆等尚未覆盖的功能以 README 说明为准。
