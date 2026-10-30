# t27 浏览器验证（e2e/）— 能力探测、双环境 e2e 与证据

> 负责人：browser-e2e（task-3） · 最近更新：2026-10-31 · 证据：`submission/evidence/00-*`、`01-e2e-*`、`04-*`，日志：`e2e/out/`

## 0. 一句话结论

- **本机 agent 沙箱内无法启动任何 Chromium 浏览器**（Chrome/Edge 都在 40~130ms 内自杀；Playwright `channel:chrome` 报 `spawn EPERM`）。这不是 Playwright/CDP 代码问题，而是沙箱禁止创建命名管道，Chromium 的 Mojo IPC 无法初始化。**因此 e2e 采用「沙箱外 Chrome + CDP over TCP attach」方案**（Lead 在 danger-full-access 终端启动 Chrome，e2e 只做客户端）。
- **WebGPU 真实可用**：Chrome 156 + NVIDIA GeForce RTX 4060 Laptop GPU，`requestAdapter()`/`requestDevice()` 均成功（vendor=nvidia, architecture=lovelace, 含 shader-f16 / subgroups / timestamp-query 等 21 个 feature，requestDevice ~18–35ms）。WebGL2 后端 ANGLE D3D11。
- **Chrome 156 的 `--disable-features=WebGPU` 已失效**（实测加该参数后 `navigator.gpu` 仍返回硬件 adapter）。真正的「WebGPU 不可用」降级环境改用 **CDP 注入**（`Page.addScriptToEvaluateOnNewDocument` 在页面脚本前删除 `navigator.gpu`）构造，evidence/summary 中如实标注为「模拟」；真实设备缺少 WebGPU 时前端走同一降级代码路径。

## 1. 环境事实（2026-10-31 实测）

| 项 | 值 |
| --- | --- |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe`，Chrome/156.0.8078.74，UA …Chrome/156.0.0.0… |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU（NVIDIA, lovelace；ANGLE D3D11） |
| WebGPU | 可用：adapter + device；`shader-f16` 支持；`requestAdapter` ~50ms、`requestDevice` ~20–35ms |
| WebGL | WebGL2 / ANGLE (NVIDIA, Direct3D11 vs_5_0) |
| WASM | 支持 SIMD；多线程需 COOP/COEP（后端已设置 → 应用页面 `crossOriginIsolated=true`） |
| 沙箱外 Chrome（由 Lead 启动） | CDP `http://127.0.0.1:19223`（profile：`e2e/out/chrome-profile-cdp-wasm`） |
| Node（e2e 宿主） | v24.14.1，win32-x64 |
| 沙箱限制 | 命名管道创建被拒绝（`FATAL:mojo/public/cpp/platform/platform_channel.cc:112 Check failed ... 拒绝访问 (0x5)`；crashpad `OpenProcess: 拒绝访问 (0x5)`） |

## 2. 沙箱内启动浏览器的失败证据（结论：必须 attach）

| 尝试 | 结果 |
| --- | --- |
| `child_process.spawn(..., {stdio:'pipe'})` | **EPERM** |
| `child_process.spawn(..., {stdio:'ignore'})` | 可执行，但 Chrome 40~130ms 自杀（见下） |
| Playwright 1.64.1 `chromium.launch({channel:'chrome'})` | `browserType.launch: spawn EPERM`（内部用 `--remote-debugging-pipe`），14ms 失败 |
| 手动 spawn chrome + `--remote-debugging-port=…` | crashpad `OpenProcess: 拒绝访问 (0x5)` → self-terminating；加 `--no-sandbox` 后暴露根因 `FATAL:mojo … platform_channel.cc:112 … 拒绝访问 (0x5)` |
| `--headless=new` / `--headless=old` / `--single-process --no-zygote` / `--disable-crash-reporter --disable-breakpad` / `detached:true` / 从 run_code 的 Node 进程内 spawn | 全部同样失败 |
| Edge（`msedge.exe`，同为 Chromium） | 同样失败（同一 Mojo 管道错误） |
| `schtasks`（任务计划程序外拉起） | 不可用：`schtasks /query` 即报「系统找不到指定的路径」 |
| `Get-CimInstance Win32_Process` | 拒绝访问 |

证据日志：`e2e/out/diag-*.{stdout,stderr}.log`、`e2e/out/diag2-*`、`e2e/out/diag3-*`、`e2e/out/probe-spawn-fail-*.json`（`probe-browser.mjs` 的 spawn 模式会把每组的 chrome stderr 与分类结论写入 JSON）。

## 3. 能力探测结果（attach 模式，真实 Chrome）

`node e2e/probe-browser.mjs --cdp-url http://127.0.0.1:19223`

| 探测项 | 真实环境（webgpu-attach） | 模拟 WebGPU 不可用（wasm-simulated，CDP 注入） |
| --- | --- | --- |
| `navigator.gpu` | present=true | **present=false**（注入生效） |
| `requestAdapter()` | adapter=true（nvidia/lovelace，~54ms） | —（无 navigator.gpu） |
| `requestDevice()` | 成功 ~35ms | — |
| WebGL2 | ANGLE / RTX 4060 D3D11 | 同（注入不影响 WebGL） |
| WASM SIMD | true | true |
| 截图 | `submission/evidence/00-probe-webgpu.png` | `submission/evidence/00-probe-wasm-simulated.png` |

汇总 JSON：`submission/evidence/00-browser-capability.json`（含每次探测的完整 adapter features/limits、UA、Chrome 版本、截图路径、失败信息）。探测页本身带 COOP/COEP 头，与后端同口径。

## 4. 目录与脚本

```
e2e/
  run.mjs                 # 单进程 e2e：起后端 → attach/自启 Chrome → 打开应用 → 等 __stepkb.ready() → 导入 → 混合检索 → 截图 → 清理
  probe-browser.mjs       # 浏览器能力探测（attach 真实+模拟 / spawn 评审机自启两种模式）
  probe-page.html         # 探测页（WebGPU/WebGL/WASM/隔离环境可视化报告）
  smoke-backend.mjs       # 后端+seekdb 冒烟（不涉及浏览器；独立 DB 目录）
  launch-chrome.ps1       # 给「沙箱外终端」用：启动带 CDP 端口的 Chrome（agent 内无法启动浏览器）
  lib/cdp.mjs             # 极简 CDP 客户端（Node 内置 WebSocket；send/waitEvent/新建 target）
  lib/chrome.mjs          # 拉起/attach/关闭 Chrome；沙箱启动失败分类（SANDBOX_BLOCKS_BROWSER）
  lib/page.mjs            # 页面驱动：导航/求值/等待/截图/console 错误收集/preload 注入/关标签页
  lib/backend.mjs         # 子进程起后端 + /api/health 等待 + 强杀收尾（stdio 不用管道）
  lib/inpage.mjs          # 页面内探测表达式（WebGPU/WebGL/WASM、__stepkb 钩子、状态栏/徽标/降级横幅）
  out/                    # 运行日志/临时 profile（gitignore）；报告 JSON
```

## 5. 运行方式

> 本机当前由 Lead 在沙箱外启动的 Chrome 实例为 **CDP http://127.0.0.1:19223**（profile `e2e/out/chrome-profile-cdp-wasm`）；
> 下面命令里的 19222 是脚本默认端口，实际跑时用 `--cdp-url http://127.0.0.1:19223`。

### 5.1 前置：在「沙箱外」启动 Chrome（agent 沙箱内无法启动，见 §2）

普通 PowerShell / 评审机终端：

```powershell
pwsh -File e2e/launch-chrome.ps1            # 默认端口 19222，headed，profile 在 e2e/out/
# 或手动：
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=19222 `
  --user-data-dir="D:\oceanbase\tasks\t27_stepfun_edge\src\e2e\out\chrome-profile-cdp-webgpu" `
  --no-first-run --no-default-browser-check --window-size=1440,900
```

> 同一 Chrome 实例即可同时用于两条路径：WebGPU 真实路径直接跑；WASM 降级路径由 e2e 自动注入隐藏 `navigator.gpu`。
> 若在**真实没有 WebGPU 的机器**上跑，`--env wasm` 会自动识别（不会注入），summary 里 `webgpuSimulated=false`。

### 5.2 能力探测

```bash
node e2e/probe-browser.mjs --cdp-url http://127.0.0.1:19222
# 输出：e2e/out/browser-probe-latest.json + submission/evidence/00-browser-capability.json
#      截图：submission/evidence/00-probe-webgpu.png / 00-probe-wasm-simulated.png
```

### 5.3 后端冒烟（不依赖浏览器）

```bash
node e2e/smoke-backend.mjs --fresh-db
# 覆盖 /api/health、/api/kbs、/docs 写入、/refresh、/search(hybrid 单条 SQL)、/stats、/db/info
# 使用独立 DB 目录 e2e/out/_runtime/seekdb（不与 dev 实例抢单实例锁）
```

### 5.4 双环境 e2e（应用构建完成后）

```bash
# WebGPU 真实环境
node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:19222
# WASM 降级环境（自动 CDP 注入隐藏 navigator.gpu，summary.webgpuSimulated=true）
node e2e/run.mjs --env wasm  --cdp-url http://127.0.0.1:19222
# 评审机（浏览器可自启）：不传 --cdp-url 即走 spawn 模式
node e2e/run.mjs --env webgpu
```

退出码：`0`=核心断言全过；`1`=用例失败；`3`=浏览器不可用（环境限制，非功能失败，会打印可复现指引）；`21`=后端不可用。

### 5.5 e2e 断言（run.mjs）

WebGPU 环境：页面 secure context / COOP+COEP 生效 / `__stepkb` 钩子存在 / `ready()` 完成 / 徽标 `data-backend=webgpu` 且文本含 `WebGPU · FP16` / adapter+device 可用 / 无降级横幅 / 导入语料成功 / 混合检索有结果 / DB 已连接。
WASM 环境：徽标 `data-backend=wasm` / 文本含 `WASM` / `[data-testid=fallback-banner]` 可见且含降级原因 / 页面内 `navigator.gpu` 不可用 / 其余流程同上。
证据命名：`submission/evidence/01-e2e-webgpu.png`、`01-e2e-wasm.png`、`04-webgpu.png`、`04-wasm-fallback.png`；每次运行另存 `e2e/out/run-<时间>-<env>/summary.json`。

## 6. 证据索引

| 证据 | 内容 |
| --- | --- |
| `submission/evidence/00-browser-capability.json` | 两套环境（真实/模拟）完整探测 JSON：UA、Chrome 版本、adapter info/features/limits、WebGL、WASM、截图路径、沙箱失败原因 |
| `submission/evidence/00-probe-webgpu.png` | 真实 Chrome 探测页截图（WebGPU 可用、RTX 4060、各能力项） |
| `submission/evidence/00-probe-wasm-simulated.png` | 注入隐藏 `navigator.gpu` 后的探测页截图（WebGPU 不可用） |
| `submission/evidence/01-e2e-webgpu.png` / `01-e2e-wasm.png` | 两条路径全流程截图（检索结果、单条 SQL、阶段耗时） |
| `submission/evidence/04-webgpu.png` / `04-wasm-fallback.png` | 状态栏徽标近景：WebGPU·FP16 / WASM·INT8 + 降级提示 |
| `e2e/out/*.log`、`e2e/out/run-*/summary.json` | 每次运行的原始日志与断言结果（可复现） |

## 7. 已知限制 / 风险

1. **agent 沙箱内不能启动浏览器**（环境限制）。所以 e2e 必须由沙箱外的 Chrome + `--cdp-url` 驱动；评审机若可正常启动浏览器，可省略 `--cdp-url` 走自启模式。
2. **WASM 降级环境是「CDP 注入模拟」而非真实无 WebGPU 设备**：Chrome 156 已无有效启动开关关闭 WebGPU（实测 `--disable-features=WebGPU` 被忽略）。e2e 在 summary/日志中明确标记 `webgpuSimulated=true`，不冒充真实环境；真实无 WebGPU 设备的前端行为走同一段降级代码（`detectWebgpu()` 返回不可用 → WASM+q8）。
3. 后端 embedded seekdb 是**单实例锁**（同一 DB 目录同一时刻只能一个进程）；e2e 默认用 `e2e/out/_runtime/seekdb` 独立目录，避免与 dev 实例冲突。`--fresh-db` 会清空该目录（仅测试数据）。
4. `server/index.mjs` 的 seekdb 原生插件在 Windows 下异常退出可能残留 pid 锁；后端启动时有 stale-lock 自动清理（`server/db.mjs recoverStaleLock`）。e2e 收尾用进程树强杀（`taskkill /T /F`）避免 close_sync 阻塞。
5. 探测页与应用页的 COOP/COEP 均按后端同款头设置（`same-origin` / `require-corp`），保证 `crossOriginIsolated` 口径一致。
## 8. 验收结果（2026-10-31 实测，真实后端 + 真实 Chrome）

两环境均为：**真实 server（embedded seekdb，dbMode=embedded，版本 5.7.25-OceanBase seekdb-v1.4.0.0）+ 真实页面（dist 由 server 静态托管）+ attach Lead 在沙箱外启动的 Chrome 156（CDP 127.0.0.1:19223）**。

| 环境 | 命令 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| WebGPU（真实） | `node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:19223 --port 18278` | **exit=0，passed=24 failed=0** | badge `WebGPU · FP16`；adapter nvidia/lovelace，device ✅；crossOriginIsolated=true；无降级横幅；导入 50 篇（向量化 337.8ms，写入 952.0ms，refresh 142ms）；混合检索 5 行（查询向量化 21.6ms / seekdb SQL 14.0ms / 端到端 43.1ms）；单条 SQL 含 MATCH + l2_distance APPROXIMATE |
| WASM 降级（CDP 注入隐藏 navigator.gpu） | `node e2e/run.mjs --env wasm --cdp-url http://127.0.0.1:19223 --port 18278` | **exit=0，passed=26 failed=0** | badge `WASM · INT8`（data-backend=wasm, dtype=q8）；`[data-testid=fallback-banner]` 显示「已自动降级至 WASM · INT8，实际加载 onnx/model_quantized.onnx；原因：navigator.gpu 不存在」；q8 模型 24,010,842 B、压缩比 3.95×、WASM 线程 4；导入/混合检索/增量刷新全流程通过 |

两环境均通过：后端真实 seekdb（非 MOCK）、KB dim=512、FULLTEXT+VECTOR 索引存在、增量导入第二批 + refresh 后第二批可检索（06-refresh）、网络请求 0 条外网/跨域（02-network）、页面无未捕获异常。

### 8.1 证据文件（submission/evidence/）

| 文件 | 说明 |
| --- | --- |
| `01-e2e-import.png` / `01-e2e-import-wasm.png` | 导入 50 篇后的界面：本次写入 50 篇、向量化/写入/刷新耗时、DDL（FULLTEXT+VECTOR 索引）、docCount |
| `01-e2e-search.png` / `01-e2e-search-wasm.png` | 混合检索结果：排名/原文/score/distance、阶段耗时（查询向量化/seekdb SQL/HTTP 往返/端到端）、单条 SQL 折叠 |
| `04-webgpu.png` | 状态栏特写：`WebGPU · FP16`、模型 bge-small-zh-v1.5 · 512 维 · 47.50 MB · 压缩比 2.00×、seekdb embedded |
| `04-wasm-fallback.png` | 状态栏 + 降级横幅特写：`WASM · INT8`、自动降级原因（navigator.gpu 不存在） |
| `02-network-no-inference.json/.md`（及 `-wasm` 版） | 全流程网络请求清单（含页面与 Worker）：仅 127.0.0.1:18278 + 无 host（data:/blob:），**外网/跨域 0 条** |
| `05-db-evidence.txt`（及 `-wasm` 版） | /api/db/info、KB 信息、SHOW CREATE TABLE、SHOW INDEX、单条混合检索 SQL 模板 + 实际执行 SQL + 阶段耗时 |
| `06-refresh.json`（及 `-wasm` 版） | 增量导入第二批（2 篇）→ refresh → 全文检索命中记录、docCount 50→52 |
| `03-benchmark.json` | 页面评测面板（3 配置 × 5 次）结果（跑 `--benchmark` 时产出） |
| `e2e/out/run-*/summary.json` | 每次运行的完整断言与数据结构 |
| `outputs/logs/2026-10-31_e2e-{webgpu,wasm}.{log,json}` | 运行日志与 summary 副本 |

## 9. 基准（评测面板）

```bash
node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:19223 --port 18278 --benchmark --bench-runs 1
# 产出 submission/evidence/03-benchmark.json（页面 ==window.__stepkb.runBenchmark({runs})== 的返回）
# 注意：评测会依次加载 3 档模型（FP32/WASM、FP16/WebGPU、INT8/WASM），耗时较长；--bench-runs 控制每配置次数
```### 8.2 评测面板（03-benchmark.json，webgpu 环境，runs=1，`--benchmark --bench-runs 1`）

页面评测面板 `window.__stepkb.runBenchmark({runs:1})` 的实测（50 篇语料 / 30 条查询 / 混合检索 k=10）：

| 配置 | ONNX 体积 | 压缩比 | 加载 | 语料向量化吞吐 | Recall@10 | nDCG@10 | 端到端中位 | seekdb SQL 中位 | 查询向量化中位 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FP32 + WASM | 94,851,877 B（94.85 MB） | 1.000× | 1149 ms | 10.43 篇/s | 0.9667 | 0.9667 | 28.74 ms | 4 ms | 18.18 ms |
| FP16 + WebGPU | 47,497,427 B（47.50 MB） | 1.997× | 1141 ms | **43.87 篇/s** | **1.0000** | **1.0000** | **19.63 ms** | 4 ms | **9.96 ms** |
| INT8 + WASM | 23,903,394 B（23.90 MB） | **3.968×** | **497 ms** | 11.86 篇/s | **1.0000** | 0.9877 | 40.57 ms | 5 ms | 26.54 ms |

> 环境：Chrome 156 / NVIDIA RTX 4060 Laptop / crossOriginIsolated=true；详细逐条查询结果见 `submission/evidence/03-benchmark.json`。
> 注：本次 runs=1 用于 e2e 可复现对照，正式基准见 eval-data 的 `outputs/logs/2026-10-31_final-benchmark.json`（3 配置 × 5 次）。
