# 一页技术说明 · StepKB：端侧向量化 + seekdb 混合检索

> 赛题 27「阶跃星辰：端侧 AI 推理优化与 seekdb 混合检索」｜代码：`src/`｜数据：`src/web/public/data/`

## 1. 模型与量化

| 项 | 值 |
| --- | --- |
| 模型 | `Xenova/bge-small-zh-v1.5`（ONNX 版；原始模型 `BAAI/bge-small-zh-v1.5`，MIT License），HuggingFace `main` 分支 |
| 结构/维度 | 4 层 transformer，hidden_size **512**，输出 512 维；tokenizer 词表 21,128；最大输入 512 token |
| 池化/归一化 | **CLS pooling + 输出 L2 归一化**（BGE 官方口径）；查询不加 instruction；文档不截断提示前缀 |
| 量化方案 | 直接使用官方发布的 4 档 ONNX（无需自行训练/量化）：fp32 基线、**fp16（WebGPU 路径）**、**int8（WASM 路径）**、q8（WASM 降级备选） |

**体积与压缩比（实测字节数，HF LFS sha256 校验；含 tokenizer/config 口径另列）**

| 档位 | 权重文件 | 权重体积 | 含 tokenizer/config 总下载 | 压缩比（fp32/该档） |
| --- | --- | ---: | ---: | ---: |
| fp32（基线） | `onnx/model.onnx` | 94,851,877 B (90.46 MiB) | 95,402,424 B | 1.00× |
| fp16 | `onnx/model_fp16.onnx` | 47,497,427 B (45.30 MiB) | 48,047,974 B | **2.00×**（含 tokenizer 1.99×） |
| int8 | `onnx/model_int8.onnx` | 23,903,394 B (22.80 MiB) | 24,453,941 B | **3.97×**（含 tokenizer 3.90×） |
| q8（降级） | `onnx/model_quantized.onnx` | 24,010,842 B (22.90 MiB) | 24,561,389 B | 3.95× |

> 口径：压缩比 = 量化前体积 / 量化后体积；tokenizer/config 共 550,547 B。模型文件不随仓库分发，`npm run fetch:models` 一键下载并校验。

**检索质量变化**（同一语料 50 篇 / 查询 30 条（单 gold）/ 混合检索 top-10 / 每次 5 轮取中位数，浏览器实测）：

| 配置 | Recall@10 | nDCG@10 | 说明 |
| --- | ---: | ---: | --- |
| FP32 + WASM（基线） | 1.000 | 1.000 | 30/30 命中 top-10 |
| FP16 + WebGPU | 0.967（29/30） | 0.967 | 唯一未命中 q08（gold=d11），5/5 轮稳定复现；**复测证据**：同一 fp16 模型在另一份 52 行数据实例上，该查询 gold 可排 hybrid/vector 第 1 名（k=20），故更可能是 seekdb v1.4.0 嵌入式「WHERE MATCH 过滤 + HNSW 近似」在特定建表/写入历史下的候选波动，而非模型质量稳定退化 |
| INT8 + WASM | 1.000 | 0.988 | 1 条 gold 排名第 2（nDCG 0.988），Recall 无损 |

**结论**：fp16 权重体积减半（2.00×）、int8 降至 1/4（3.97×）；在 50 篇评测集上 Recall@10 分别为 96.7% / 100%，nDCG@10 为 0.967 / 0.988，相对 fp32 基线变化 ≤3.3%，满足「检索质量不明显下降」；q08 的差异已按上面说明如实归因（ANN 近似波动），未删改原始数据。数据来自应用内评测面板实际运行，原始 JSON 见 `outputs/logs/2026-10-31_web-smoke-benchmark.json`。

## 2. 端侧运行（Transformers.js v4 + WebGPU / WASM）

- 运行时：`@huggingface/transformers` **v4.3.2**，模型与 ONNX Runtime WASM 二进制**全部同源自托管**（`/models/`、`/ort/`），无 CDN、无远程推理。
- 推理在 **Web Worker** 中执行，主线程不阻塞；文档批量向量化按 batch 提交并汇报进度。
- **WebGPU 显式配置**：启动时依次检查 `navigator.gpu` → `requestAdapter()` → `requestDevice()`，成功则 `pipeline(..., {device:'webgpu', dtype:'fp16'})`；并校验 `shader-f16` feature。
- **自动降级链**：WebGPU 不可用或首次推理抛错 → 销毁并重建 `{device:'wasm', dtype:'q8'}`（`model_quantized.onnx`）；q8 文件异常时再退 `int8`。界面顶部徽标固定文案：`WebGPU · FP16` / `WASM · INT8`，降级时显示黄色提示条说明原因（本机实测：Chrome 156 关闭 WebGPU 后自动进入 WASM 路径，流程完整可检索）。
- **WASM 多线程前提**：后端与 Vite dev server 均对静态资源下发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`；实测 `crossOriginIsolated=true`，`SharedArrayBuffer` 可用（WASM threads=4）。
- **合规自证**：后端 `server/` 依赖仅 `express` + `seekdb`，不含任何推理库（`grep -r "transformers\|onnxruntime" server/` 为空）；浏览器 Network 证据见 `submission/evidence/02-network-no-inference.json`。

**分阶段实测耗时**（Windows 11 / Chrome 156.0.8078.74 / NVIDIA RTX 4060 Laptop / 24 线程；语料 50 篇、查询 30 条、每次 5 轮中位数）：

| 配置 | 模型cold加载 | 预热 | 文档向量化吞吐 | 查询向量化 | seekdb 检索 | API 往返 | 端到端（首次 / 中位） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FP32 + WASM | 1222.7 ms | 31.7 ms | 9.30 docs/s（5.38 s/50） | 18.53 ms | 4.0 ms | 9.56 ms | 28.89 / 28.79 ms |
| FP16 + WebGPU | 1067.3 ms | 65.7 ms | **41.89 docs/s**（1.19 s/50） | 11.33 ms | 4.5 ms | 9.87 ms | 21.48 / **21.59 ms** |
| INT8 + WASM | 1042.6 ms | 37.9 ms | 12.45 docs/s（4.02 s/50） | 12.93 ms | 5.0 ms | 9.97 ms | 27.27 / 23.45 ms |

> 说明：模型加载为「fetch+初始化」；预热为首次推理（含 WebGPU shader 编译/ONNX session 初始化）。小批量查询（单条）下 GPU 调度开销显现，WebGPU 的优势主要体现在文档批量向量化（41.9 vs 9.3 docs/s）；查询侧 WebGPU 仍略优于 WASM（11.3 vs 12.9–18.5 ms）。

## 3. seekdb 使用

- **接入方式**：npm `seekdb@1.4.0`（`SeekdbClient` / `SeekdbAdminClient`），默认 **嵌入式**（本机进程内，原生插件 `@seekdb/js-bindings`）；亦支持 `SEEKDB_MODE=server` 连接外部 seekdb。题面 2.3.1 允许嵌入式或本地 server 部署，本项目两种模式代码同构。
- **表结构**（每个知识库一张表，注册表 `kb_registry` 管理集合状态）：

```sql
CREATE TABLE kb_<id> (
  id VARCHAR(128) PRIMARY KEY, content TEXT NOT NULL,
  category VARCHAR(64), meta JSON, created_at VARCHAR(32),
  embedding VECTOR(512) NOT NULL,
  FULLTEXT INDEX ft_content (content) WITH PARSER ik,
  VECTOR INDEX vec_embedding (embedding)
    WITH (distance=l2, type=hnsw, lib=vsag, m=16, ef_construction=200, ef_search=100)
) ORGANIZATION = HEAP;
```

- **混合检索（单条 SQL，库内完成）**：

```sql
SELECT id, content, MATCH(content) AGAINST('查询词') AS score,
       l2_distance(embedding, '[512 维向量]') AS distance
FROM kb_<id>
WHERE MATCH(content) AGAINST('查询词')
ORDER BY l2_distance(embedding, '[512 维向量]') APPROXIMATE
LIMIT 10;
```
全文谓词走 `FULLTEXT INDEX(ik)`，向量排序走 HNSW 向量索引（`APPROXIMATE` 必需）；两路召回均在 seekdb 执行，客户端只做结果渲染，**不做两路拼合**。
> 距离函数说明：seekdb v1.4.0 嵌入式实测 `cosine_distance + APPROXIMATE` 返回不完整（5 行只回 1 行），故统一对向量做 L2 归一化后使用 `l2_distance`（对归一化向量，L2 排序与余弦排序等价）。

- **写入与索引刷新**：批量 `INSERT ... ON DUPLICATE KEY UPDATE`（每批 20 条，参数化）；seekdb HNSW 是异步双层索引，写入即返回、查询可命中，但新文档的 ANN 可见性可能有毫秒级延迟。因此「刷新索引」实现为**显式就绪探针**：对最新写入文档同时做 FTS 可见性与 ANN top-N 可见性轮询，返回 `waitMs/probe{ftsHit,vectorHit}`；界面提供「刷新索引」按钮并展示耗时。实测 60 篇导入后 probe `ftsHit=true, vectorHit=true`。
- **库内检索证据**（本 build 不支持 EXPLAIN，见下）：`SHOW CREATE TABLE` / `SHOW INDEX` 显示 `FULLTEXT` 与 `VECTOR` 索引均 "available"；单条 SQL 原文由 API 原样返回并在 UI 展示；同数据量下混合检索 db 侧延迟 4–16 ms（毫秒级，远低于全量精确扫描量级）。

## 4. 状态管理与优化

- **集合/会话状态**：`kb_registry` 记录每个知识库的 id/名称/表名/模型/维度/创建时间；前端保存当前选中知识库（localStorage）+ 会话内检索历史；新建/删除/切换知识库后检索只查询当前库表，避免跨库串结果。
- **增量写入**：导入面板支持文本粘贴与 `.txt/.md/.json` 文件；按批提交（批大小 20），同 id 覆盖写入；返回 `writeMs/refreshMs` 并在 UI 展示。
- **批处理与加载优化**：Worker 内按 batch 向量化（减少 per-call 开销）；模型文件自托管 + 浏览器 HTTP 缓存（`Cache-Control: immutable`）；WASM 二进制预加载；`env.allowRemoteModels=false` 避免运行时探测下载。文档批处理是最大收益点（WebGPU 41.9 docs/s vs WASM 9.3 docs/s）。
- **已知引擎限制（如实记录）**：
  1) 嵌入式 C ABI 对 `EXPLAIN`（含 FORMAT=JSON）返回 0 行、`DBMS_HYBRID_SEARCH.GET_SQL` 报 `ret=-4182` → 无法给出 EXPLAIN 双算子截图；以「单条 SQL 原文 + SHOW CREATE TABLE/SHOW INDEX + 索引度量」替代，**未伪造**。
  2) 原生插件 `open()` 会接管 stdout → 后端日志写文件；进程退出需强制终止（原生 atexit 阻塞），数据由 seekdb redo 恢复。
  3) seekdb 嵌入式同一数据目录同一时刻仅允许一个进程打开。

## 5. 复现

```bash
cd src && npm install --ignore-scripts && npm run fetch:models && npm run build && npm start
# 打开 http://127.0.0.1:18270
```
数据层：`node scripts/verify-db.mjs`；质量评测：`node eval/quality.mjs`；浏览器 e2e：`npm run e2e`（详见 `e2e/README.md`）。
评测原始数据：`outputs/logs/2026-10-31_final-benchmark.json`（若存在）、`2026-10-31_web-smoke-benchmark.json`、`2026-10-31_eval-quality.*`。
