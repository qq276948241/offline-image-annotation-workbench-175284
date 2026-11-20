# 图像标注工作台（离线）

浏览器端图像标注工作台：输入二进制 PGM（P5）灰度图和带透明度的 RGBA 原始缓冲，
用一条**可取消**的流水线做灰度转换 → 局部对比度 → 阈值分割 → 四邻接区域标记，
结果可导出 CSV / JSON。整个项目**没有任何外部依赖**，也不需要构建步骤。

## 快速开始（浏览器）

直接在文件管理器里双击 `index.html`，或把 `index.html` 拖进 Chrome / Firefox / Safari。
页面用经典 `<script>` 与相对路径加载，**`file://` 下即可运行**，不需要本地服务器，
也不会访问任何外网资源。

1. 把 `.pgm` / `.rgba` / `.bin` 文件拖进左上角区域（或点击选择文件）。
2. 或者点击「边界样本」里的任意一项 —— 这些样本由 `src/app/fixtures.js` 在浏览器内
   用代码生成，不读取任何预生成截图或静态 JSON。
3. 「重新计算」/「取消」控制计算；阈值滑块改变阈值后会自动重算。
4. 完成后可「导出 CSV」「导出 JSON」；导出内容与右侧区域表格来自同一份数据。

如需本地服务器（某些浏览器对 `file://` 更严格时）：

```sh
cd <项目根目录>
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000/index.html
```

> 说明：`file://` 下 Chrome 允许创建经典 Worker（本项目已验证）；若某个浏览器
> 禁止，页面会自动退回到「页内 fallback」，它运行**同一个** `src/worker/runner.js`，
> 消息协议与任务版本校验完全一致。

## 运行 Node 端检查

只需要 Node（本项目在 Node 24 上验证），**不需要 `npm install`**：

```sh
node --test
```

这会运行全部离线、可重复的测试：

| 文件 | 覆盖点 |
| --- | --- |
| `test/parser.test.js` | 注释 / 空白 / 像素起点分离；8 位与 16 位大端样本原样保留；首字节为空格或 `#` 的栅格；截断、尾随数据、尺寸溢出、文件/像素/栅格预算在整个分配前的统一报错 |
| `test/compute.test.js` | 灰度、局部对比度、阈值、四邻接标记；平坦区、孤立亮峰、透明像素、16 位高值、半透明峰；确定性与源像素不被修改；取消 |
| `test/export.test.js` | CSV / JSON 与界面表格、标签栅格、调色板逐项一致 |
| `test/controller.test.js` | 任务版本竞态、迟到消息、取消后迟到消息、旧结果保留、Worker 异常 |
| `test/integration.test.js` | 真实 pipeline + 真实运行器 + 可控 Worker 消息顺序；显示转换不改原始像素 |
| `test/browser.test.js` | **真实浏览器**（headless Chrome，经 DevTools 协议）跑完整页面：拖入文件、计算、重算、取消、错误提示、旧结果保留、导出标签与表格一致、浏览器 / Node 结果逐字节一致。未安装 Chrome 时自动跳过 |

浏览器测试不依赖 Playwright/Puppeteer：它使用 Node ≥ 22 内置的 `WebSocket` 直接连
Chrome DevTools 协议，并且只访问 `file://` 本地页面。

## 输入格式

### 二进制 PGM（P5）

```
P5
# 任意注释
<宽> <高>
<最大灰度值>
<像素数据>
```

- 注释（`#` 到行尾）只允许出现在文件头**词元之间**；像素数据绝不当作注释扫描。
- 文件头以**恰好一个**空白字节结束（`\r\n` 视为一个）。此后所有字节都是像素数据 ——
  即使第一个像素字节是空格（`0x20`）或 `#`（`0x23`）。
- `最大灰度值 < 256` 按 8 位样本、`>= 256` 按 16 位**大端**样本读取；
  样本值原样保存为 `Uint8Array` / `Uint16Array`，16 位不会被缩放到 8 位。
- 支持 `P5`；`P1–P4`、`P6` 会报 `UNSUPPORTED_FORMAT`。
- 截断、尾随多字节、宽高非正、尺寸溢出、超过预算都会在**分配大数组之前**
  抛出统一的 `ImageFormatError`（见下）。

### RGBA 原始缓冲

没有文件头，布局是紧排的 `R,G,B,A` 字节，行优先，alpha 原样保留。
在页面左侧填写宽高后选择 `.rgba` / `.bin` 文件即可；字节数必须**恰好**等于
`宽 × 高 × 4`，否则报截断或尾随数据。

## 统一错误码

所有失败都是 `ImageFormatError`，带稳定的 `code`、英文 `message` 与中文 `userMessage`：

| code | 触发条件 |
| --- | --- |
| `BAD_MAGIC` / `UNSUPPORTED_FORMAT` | 非 PGM / 非 P5 |
| `BAD_HEADER` / `TRUNCATED_HEADER` | 文件头格式错误 / 不完整 |
| `BAD_DIMENSION` / `DIMENSION_OVERFLOW` | 宽高非正 / 数值溢出 |
| `BAD_MAXVAL` | 最大灰度值不在 1..65535 |
| `TRUNCATED_RASTER` / `TRAILING_DATA` | 像素数据不足 / 多余 |
| `FILE_BUDGET_EXCEEDED` | 文件字节超过 `maxFileBytes` |
| `PIXEL_BUDGET_EXCEEDED` | 像素数超过 `maxPixels` |
| `RASTER_BUDGET_EXCEEDED` | 栅格字节超过 `maxRasterBytes` |
| `PIPELINE_CANCELLED` / `PIPELINE_FAILED` | 流水线取消 / 失败 |
| `WORKER_FAILED` | Worker 无法创建或异常退出 |

默认预算见 `src/core/limits.js`（文件 32 MiB、像素 8 Mi、栅格 32 MiB）。

## 计算流水线

`src/core/compute.js` 中的 `runPipeline(image, { threshold }, { shouldCancel, onStage })`：

1. **灰度**：PGM 样本原样保留（8 位 0–255，16 位 0–65535）；RGBA 用整数 Rec.601 权重。
2. **局部对比度**：3×3 窗口内 `max - min`，原始强度单位，边界夹取。
3. **阈值分割**：`cut = threshold × maxValue`，`对比度 > cut` 且 `alpha > 0` 才是前景。
4. **四邻接标记**：两遍 union-find，按光栅出现顺序重编号，输出标签栅格、面积、边界框。

流水线在行块之间让出事件循环，因此 Worker 能在阶段之间看到取消消息。相同输入下
标签、面积、边界框完全确定；界面缩放只是整数最近邻放大，不改写任何原始像素。

### 任务版本与竞态

`src/app/controller.js` 为每个任务分配递增的 `jobVersion`，并记录 Worker 代数：

- 连续提交时旧 Worker 会先 `terminate()`，其消息因版本不匹配被丢弃。
- 取消会**先**让版本失效，再通知 Worker；取消后的迟到消息无法覆盖新结果。
- 只有与当前 `jobVersion` 一致的 `done` 才会发布；标签栅格只与同版本的汇总配对。
- 解析失败、计算失败、取消都会**保留上一次已发布的结果**。

状态栏区分 `解析中 / 计算中 / 发布中 / 完成 / 已取消 / 失败`，并显示任务版本与
丢弃消息数。

## 复现边界样本

所有边界样本都是代码生成、可重复的：

```sh
node --test test/parser.test.js   # 包含「页面无效样本必报指定错误码」的断言
```

在页面上，「边界样本」区块同时列出合法样本（平坦区、孤立亮峰、注释/空白与像素起点、
十六位高值、maxval 300、RGBA 透明、RGBA 半透明、两个独立区域）和**故意非法**的样本
（截断、尾随数据、超预算、尺寸溢出），点击即可看到对应的中文错误与错误码。

## 目录结构

```
index.html                 页面（离线、无构建）
src/core/errors.js         统一错误类型与中文消息
src/core/limits.js         预算与几何校验（分配前）
src/core/parser.js         P5 / RGBA 解析
src/core/compute.js        流水线、标记、调色板
src/core/exporter.js       CSV / JSON 导出
src/worker/runner.js       运行器（Worker 与页内 fallback 共用）
src/worker/worker.js       经典 Worker 入口
src/app/{main,controller,render,fixtures}.js
test/*.test.js             Node 端离线测试（含 headless Chrome 端到端）
```
