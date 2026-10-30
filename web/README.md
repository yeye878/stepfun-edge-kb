# StepKB 前端（web/）— 端侧迷你知识库

赛题 27「阶跃星辰：端侧 AI 推理优化与 seekdb 混合检索」的浏览器端应用。Vite + TypeScript，无 UI 框架。

## 技术栈与合规要点

- **端侧推理**：@huggingface/transformers@4.3.2 在 Web Worker 中加载同源自托管的 bge-small-zh-v1.5 ONNX 模型；
  - 默认 device:'webgpu' + dtype:'fp16'（onnx/model_fp16.onnx）；
  - 失败自动降级：wasm + q8（onnx/model_quantized.onnx）→ wasm + int8（onnx/model_int8.onnx）；
  - 降级原因、实际后端、模型体积/压缩比在顶部状态栏与黄色 banner 如实展示；
  - 池化 **CLS**，返回前在 Worker 内做 **L2 归一化**；查询不加 instruction；
  - env.allowRemoteModels=false、env.allowLocalModels=true（v4 在浏览器默认 false，必须显式开启）、env.localModelPath='/models/'；
  - ONNX Runtime WASM 运行文件自托管到 /ort/（dev 由 Vite 中间件直出 node_modules 文件，build 时拷贝到 dist/ort/）。
- **后端只做 SQL 转发**：前端把查询/文档向量（number[]）发给 /api/**，由 seekdb 用单条 SQL 完成混合检索；后端不加载任何推理库。
- **向量维度动态获取**：bge-small-zh-v1.5 实际输出 **512 维**（config.json hidden_size=512；不是英文 bge-small 的 384），
  前端用模型实测 dims 作为建库维度，不写死。

## 目录

    web/
      index.html            # 入口骨架（含 data-testid）
      vite.config.ts        # root=web、dev 18271、/api→18270、COOP/COEP、ORT 自托管、build.outDir=../dist
      tsconfig.json         # 仅用于 IDE/tsc 检查（vite build 不做类型检查）
      src/
        main.ts             # 启动、面板装配、window.__stepkb 测试钩子
        worker.ts           # 推理 Worker：加载模型、CLS 池化、L2 归一化、批量 embed
        embedClient.ts      # 主线程 Worker 封装：WebGPU 预检、降级链、请求路由
        services.ts         # 导入/检索/刷新/建库等应用级操作（UI 与钩子共用）
        bench.ts            # 3 配置 × N 次评测（真实向量化 + seekdb 单条 SQL + Recall/nDCG）
        api.ts              # 后端 HTTP 客户端（APP-CONTRACT §3 字段）
        appStore.ts         # 轻量全局状态
        format.ts / dom.ts / types.ts
        styles.css
        ui/                 # 状态栏、banner、导入/检索/数据层/评测面板、toast
      dev/
        mock-server.mjs     # ⚠ 仅开发联调用的内存 mock（非 seekdb），最终验收不用
        exec-shim.mjs       # 沙箱兼容 shim（Vite 在 Windows 上的 exec("net use") 被沙箱拒绝问题）
        vite-run.mjs        # 沙箱兼容的 vite 启动包装（package.json build/dev:web 使用）
        smoke.mjs           # CDP 浏览器冒烟（需沙箱外启动的 Chrome；支持 --no-webgpu / --hook-test / --q08 / --bench）
        bench-report.mjs    # 评测 JSON → 最终 JSON + markdown 表
        run-integration.ps1 # 单次前台调用内「起真实后端→冒烟→关后端」
      public/
        models/bge-small-zh-v1.5/**   # 自托管模型 + manifest.json（eval-data 产出，>10MB 不入 git）
        data/{corpus,queries,qrels}.json  # 评测数据（eval-data 产出）

## 运行

    cd tasks/t27_stepfun_edge/src
    npm run dev:web        # Vite dev server: http://127.0.0.1:18271（/api 代理到 18270）
    npm run build          # 产物到 ../dist（含模型与 /ort，约 270MB）
    npm start              # 后端 + 静态前端：http://127.0.0.1:18270

> 本机 DSH 沙箱说明：Vite 8 在 Windows 初始化时会 exec("net use") 探测网络盘，沙箱下报 spawn EPERM。
> web/dev/exec-shim.mjs 只在该调用同步抛错时兜底（普通机器行为不变），package.json 的 build/dev:web 通过 web/dev/vite-run.mjs 预加载它。
> 后端 seekdb 原生插件在 open 后会关闭 stdout，所以必须在启动前切换文件日志（Lead 已在 server/index.mjs 处理）。

## window.__stepkb 自动化测试钩子

页面加载后同步注入，e2e 可直接使用（无需等待 UI）：

    await window.__stepkb.ready();                 // 应用就绪（含首次模型加载尝试，成功或失败都会 resolve）
    window.__stepkb.state();                       // {ready, backend, dtype, fallbackReason?, dbOk, docCount, currentKb?, modelStatus, stub}
    window.__stepkb.getState();                    // 完整快照（含 model.info、attempts、lastSearch、benchmark）
    window.__stepkb.getLogs();                     // 最近 200 条阶段日志 {ts, level, phase, msg, data?}
    window.__stepkb.createKb(name);                // → kb
    window.__stepkb.importTexts(texts, {kb?});     // 文本/[{id,text}]；kb 缺省且无选中库时自动建「验收知识库」→ {inserted,total,writeMs,refreshMs,kbId}
    window.__stepkb.search(query, mode?, k?);      // → {rows, sql, dbMs, queryEmbedMs}
    window.__stepkb.refresh();                     // 刷新当前库 → {docCount, refreshMs, probe}
    window.__stepkb.runBenchmark(configName?);     // 例：'fp16-webgpu' / 'int8-wasm' / 'all'；→ BenchmarkResult
    window.__stepkb.getBenchmarkResult();          // 最近一次评测完整 JSON（含逐查询明细）

兼容任务书旧版签名：importTexts(kbId, texts)、search(kbId, {mode,query,k})、refresh(kbId)。

## 关键 DOM 钩子（data-testid）

status-bar、backend-badge、model-info、db-status、kb-status、import-textarea、import-button、kb-select、
import-progress、search-input、search-button、search-mode、search-timings、result-list、sql-details、
doc-count、ddl-details、index-table、refresh-button、benchmark-run、bench-table、bench-progress、bench-logs。
徽标文本格式固定：WebGPU 为 "WebGPU · FP16"；WASM 为 "WASM · INT8"（q8/int8）或 "WASM · FP32"。

## 自带验证脚本

    # 真实后端 + Chrome(CDP attach) 冒烟；截图/JSON 落到 task outputs/logs/
    node web/dev/smoke.mjs --url http://127.0.0.1:18270/ --cdp-url http://127.0.0.1:19223
    node web/dev/smoke.mjs --url http://127.0.0.1:18270/ --cdp-url http://127.0.0.1:19223 --no-webgpu   # WASM 降级
    node web/dev/smoke.mjs --url http://127.0.0.1:18270/ --cdp-url http://127.0.0.1:19223 --bench all   # 全量评测
    node web/dev/smoke.mjs --url http://127.0.0.1:18270/ --cdp-url http://127.0.0.1:19223 --hook-test   # 钩子建库自测

    # 单次调用内起真实后端 + 冒烟（沙箱会在命令结束时回收子进程，所以必须同一次调用）
    pwsh -File web/dev/run-integration.ps1 -Bench int8-wasm

> 说明：本机 agent 沙箱无法直接 spawn Chrome（Mojo IPC 需要命名管道），Chrome 需在沙箱外用
> e2e/launch-chrome.ps1 启动后由 CDP attach；详见 dev/smoke.mjs 头注释。

## 已知限制

- 混合检索 SQL 为 MATCH(content) AGAINST(...) WHERE ... ORDER BY l2_distance(...) APPROXIMATE，是过滤式 ANN；
  小数据量下个别查询的排名可能因近似行为波动（见 outputs/logs/2026-10-31_q08-probe.md）。
- seekdb v1.4.0 嵌入式 cosine_distance + APPROXIMATE 结果不完整，故统一 L2 距离 + 客户端 L2 归一化（对归一化向量 L2 排序等价于余弦排序）。
- EXPLAIN 经 C ABI 返回 0 行，无法展示执行计划；以单条 SQL 原文 + SHOW CREATE TABLE/SHOW INDEX + 行为/延迟佐证。
- npm run build 会把 public/models（含 uint8 额外模型，约 205MB）与 ORT wasm 拷贝进 dist，产物约 270MB；模型文件不入 git。
- 首次加载时间受本地静态服务器/磁盘影响，表中 cold 数字仅代表本机（同一份模型文件、无网络瓶颈）。
