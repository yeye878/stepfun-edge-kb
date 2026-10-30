# StepKB · 端侧迷你知识库（浏览器本地向量化 + seekdb 混合检索）

> 2026 OceanBase 数据库大赛初赛 · 赛题 27「阶跃星辰：端侧 AI 推理优化与 seekdb 混合检索」
> 文档向量化与查询向量化**全部在浏览器本地完成**；向量与正文存入本机 **seekdb**；全文 + 向量**混合检索在库内用单条 SQL 完成**。

## 1. 亮点

- **浏览器端推理**：Transformers.js v4.3.2 + 自托管 `Xenova/bge-small-zh-v1.5`（中文，512 维），Web Worker 内运行，无任何云端推理 API。
- **后端自动选型与降级**：优先 `WebGPU + fp16`（47.50 MB）；不支持时自动降级 `WASM + q8`（24.01 MB，失败再退 int8），界面明确显示当前后端与降级原因。
- **量化报告**：同一模型三档（fp32 94.85 MB / fp16 47.50 MB / int8 23.90 MB，压缩比 2.00× / 3.97×）+ q8 24.01 MB；Recall@10 / nDCG@10 / 余弦一致性实测对比。
- **seekdb 单条 SQL 混合检索**：
  ```sql
  SELECT id, content, MATCH(content) AGAINST('查询词') AS score,
         l2_distance(embedding, '[..512 维..]') AS distance
  FROM kb_xxx
  WHERE MATCH(content) AGAINST('查询词')
  ORDER BY l2_distance(embedding, '[..512 维..]') APPROXIMATE
  LIMIT 10;
  ```
  向量与全文两路召回都在 seekdb 内完成（`TEXT RETRIEVAL SCAN` + HNSW 向量索引），客户端不做两路拼合。
- **嵌入式 seekdb，零容器依赖**：`npm install` 后一键启动（npm `seekdb` + `@seekdb/js-bindings` 原生插件），也支持 `SEEKDB_MODE=server` 连外部 seekdb。
- **状态与刷新**：多知识库（每库一张带 FULLTEXT+VECTOR 索引的表）、批量增量导入、显式「刷新索引」（对最新文档做 FTS/ANN 可见性就绪探针）、集合切换与会话状态。
- **可复现评测**：内置评测面板（3 配置 × 5 次，体积/吞吐/检索/端到端/Recall@10/nDCG@10），语料/查询/qrels 固定种子可复现。

## 2. 快速开始

前置：Node.js ≥ 20（开发用 v24.14.1），Chrome/Edge 最新版。

```bash
npm install            # 若脚本执行受限可用 npm install --ignore-scripts
npm run fetch:models   # 下载 4 档 ONNX + tokenizer（~168 MB；支持 HF_ENDPOINT 镜像）
npm run build          # 构建前端（Vite → dist/）
npm start              # http://127.0.0.1:18270
```

首次启动 seekdb 会下载约 90 MB 原生插件缓存（`SEEKDB_BINDINGS_CACHE_DIR` 可指定目录）。
打开页面后：新建知识库 → 粘贴/导入文本 → 「导入并写入 seekdb」→ 输入查询 → 「检索」。
右上角徽标显示当前推理后端（`WebGPU · FP16` / `WASM · INT8`）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 18270 | 后端 HTTP 端口 |
| `SEEKDB_MODE` | embedded | `embedded`（本机嵌入式）或 `server`（外部 seekdb/OceanBase） |
| `SEEKDB_PATH` | `./_runtime/seekdb` | 嵌入式数据目录 |
| `SEEKDB_HOST/PORT/USER/PASSWORD` | 127.0.0.1/2881/root/空 | server 模式连接参数 |
| `SEEKDB_BINDINGS_CACHE_DIR` | `~/.seekdb/bindings` | 原生插件缓存目录 |
| `BACKEND_LOG_FILE` | `./_runtime/backend.log` | 后端日志（seekdb 原生插件会接管 stdout，故写文件） |
| `HF_ENDPOINT` | https://huggingface.co | 模型下载源（可用镜像） |

### 可选：外部 seekdb server 模式

赛题任务目录下的 `env/compose.yaml` 提供 seekdb 容器编排草案（本机无 Docker，未实测；未随本代码仓库分发），若自行部署 seekdb 容器后：
```bash
SEEKDB_MODE=server SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=18270 npm start
```
（默认嵌入式路径已充分验证，推荐评审使用默认方式。）

## 3. 架构

```
┌────────────────────────── 浏览器（Web Worker） ──────────────────────────┐
│ Transformers.js v4 + bge-small-zh-v1.5（本地 /models/，CLS pooling + L2）  │
│  WebGPU 可用 → fp16 ；不可用 → WASM q8 → int8                              │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTP（只传文本与向量，不传推理）
┌───────────────────────────────▼──────────────────────────────────────────┐
│ Node 薄后端（Express，无推理依赖）                                          │
│   seekdb-js（npm seekdb）→ 单条 SQL 混合检索 / 写入 / 刷新探针             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ seekdb-js embedded（原生插件，进程内）
┌───────────────────────────────▼──────────────────────────────────────────┐
│ seekdb v1.4.0  表 kb_<id>：FULLTEXT INDEX(ik) + VECTOR INDEX(l2/hnsw)     │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. 目录

| 路径 | 说明 |
| --- | --- |
| `server/` | Express 薄后端：seekdb 连接（`db.mjs`）、知识库/检索数据层（`kb.mjs`）、API（`index.mjs`） |
| `web/` | Vite + TS 前端：`src/worker.ts`（推理 Worker）、`src/embedClient.ts`、UI 面板、评测面板 |
| `scripts/fetch-models.mjs` | 模型下载 + 校验 + manifest 生成 |
| `scripts/gen-data.mjs` | 语料/查询/qrels 可复现生成 |
| `scripts/verify-db.mjs` | 数据层验收（建库/写入/混合检索/刷新/索引证据） |
| `eval/quality.mjs` | Node 侧量化质量评测（fp32 vs int8：Recall/nDCG/余弦一致性） |
| `e2e/` | 浏览器端到端（CDP attach / 自启 Chrome；WebGPU 与 WASM 降级两环境） |
| `web/public/models/` | 自托管模型（gitignore，脚本下载） |
| `web/public/data/` | 语料/查询/qrels（约 100 KB，随仓库） |

## 5. 评测

```bash
node scripts/verify-db.mjs   # 数据层端到端
node eval/quality.mjs        # 量化质量（fp32 vs int8）
npm run e2e                  # 浏览器端到端（需 Chrome；详见 e2e/README.md）
```

评测条件（详见 `docs/tech-note.md`）：Chrome 156 / Windows 11 / NVIDIA RTX 4060 Laptop（WebGPU），
语料 50 篇中文短文档、查询 30 条（单 gold），seekdb 嵌入式 v1.4.0，
配置 = FP32+WASM / FP16+WebGPU / INT8+WASM，各 5 次取中位数。

## 6. 合规说明（对应题面 2.5）

- 推理只在浏览器 Web Worker 内执行；后端 `server/` 不依赖任何推理库（可用 `grep -r "transformers\|onnxruntime" server/` 验证为空）。
- 向量/原文/元数据只存 seekdb；无内存检索、无其他数据库兜底。
- 混合检索为**单条 SQL**，由 seekdb 执行；客户端不做两路结果拼合。
- 无云端推理 API；模型文件为公开开源模型（Xenova/bge-small-zh-v1.5，源自 BAAI bge-small-zh-v1.5，MIT License）。

## 7. 已知限制（如实记录）

- seekdb v1.4.0 嵌入式构建的两个实测行为（非本项目引入）：
  1) `cosine_distance + ... APPROXIMATE` 结果不完整 → 本项目统一用「L2 归一化向量 + `l2_distance`」，排序与余弦等价；
  2) 嵌入式 C ABI 对 `EXPLAIN` 返回 0 行、`DBMS_HYBRID_SEARCH` 报 `ret=-4182` → 「库内检索」证据改用单条 SQL 原文 + `SHOW CREATE TABLE`/`SHOW INDEX` + 索引度量对照，不伪造 EXPLAIN。
- 原生插件 `open()` 会接管进程 stdout → 后端日志写文件；进程退出需强制终止（原生 atexit 会阻塞），数据由 seekdb redo 恢复。
- 首次启动需下载 ~90 MB 原生插件与 ~168 MB 模型（可预置缓存/镜像）。

## 8. 许可与致谢

- 模型：`Xenova/bge-small-zh-v1.5`（ONNX 转换版），原始模型 `BAAI/bge-small-zh-v1.5`（MIT）。
- 推理运行时：`@huggingface/transformers` v4.3.2（Apache-2.0）、`onnxruntime-web`。
- 数据库：`seekdb`（OceanBase，Apache-2.0）。
- 本项目代码仅用于参赛演示。
