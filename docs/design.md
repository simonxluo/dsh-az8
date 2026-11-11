# dsh-az8 设计文档（SDD）

> 参考 dsh-comfyui（fandc520，181★）的展示层设计，为 AZ8 Studio（studio.az8.art）构建的
> DeepSeek Harness 原生插件。本文档是唯一权威设计源：先数据结构、数据流、控制流与全流程
> DAG，再按拓扑序开发模块。实现与本文冲突时，先改本文再改代码。

## 0. 目标 / 非目标

**目标**
1. 对话内直接生成图片/视频并展示：agent 调一个工具完成「选题型 → 报价 → 生成 → 下载 →
   对话出图」全链路。
2. 右侧停靠面板三页签（参考 dsh-comfyui 的 工作流/资产/队列）：运行 / 资产 / 设置。
3. 严格遵守 az8 CLI 契约：一次一个操作、等终态 Receipt、写失败绝不自动重试、watch 不套循环。
4. 花钱有闸门：plan 报价超过阈值必须停下等用户确认。
5. 技能包体系（从 dsh-comfyui 移植）：三级披露、运行前必读、agent 可写回经验。

**非目标（v1 不做）**
- 不做画布编辑器可视化（AZ8 网页版已有；未来可做 iframe 面板）。
- 不做面板内发起生成（面板 v1 只读 + 设置；生成走对话）。
- 不绕过 az8 CLI 直连 HTTP——CLI 是唯一云端写入通道。
- 不做多 Workspaces 切换管理（只消费 `az8 credits` 的返回，不做 UI）。

## 1. 架构总览

```
┌────────────────────────── DeepSeek Harness Host ──────────────────────────┐
│  dsh-az8 (host plugin)                                                    │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────────┐  │
│  │ tools.js │──▶│orchestrator.js│──▶│  cli.js    │──▶│ az8 CLI 子进程    │  │
│  │ 6 工具    │   │ 生成状态机     │   │ spawn 封装  │   │ (session daemon) │  │
│  └──────────┘   └──────┬───────┘   └────────────┘   └────────┬─────────┘  │
│                        │                                      │            │
│                   ┌────▼─────┐                        ┌───────▼────────┐   │
│                   │ store.js │                        │ studio.az8.art │   │
│                   │ state.json│                       │  (云端画布)     │   │
│                   └────┬─────┘                        └────────────────┘   │
│                        │                                                   │
│  ┌─────────────┐  ┌────▼──────────┐   webServer 路由                       │
│  │  client.js  │◀─│ panel.js      │  /_dsh/dsh-az8/{state,credits,media}  │
│  │ 右侧三页签   │  │ 面板 API+媒体  │                                       │
│  └─────────────┘  └───────────────┘                                       │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ markdown 相对 URL：/_dsh/dsh-az8/media?id=a3（对话内出图同一条路由）
```

关键原则：
- **az8 CLI 是唯一云通道**。凭证由 CLI 自管，插件进程绝不读取/转发/记录 token。
- **对话出图复用面板媒体路由**（相对 URL，同源，无 CORS，dsh-comfyui 已验证该模式）。
- **journal 优先**：所有运行/资产先落 state.json 再返回工具结果；面板与对话读同一份。

## 2. 数据结构

### 2.1 state.json（$DSH_HOME/integrations/dsh-az8/state.json，0600，原子写）

```jsonc
{
  "schemaVersion": 1,
  "settings": {
    "defaultProjectId": "",        // 空 = 每次必须显式给 projectId
    "maxAutoCredits": 30,          // plan 报价 ≤ 此值才自动开跑；超过 → awaiting_confirm
    "waitTimeoutMs": 180000,       // sync 模式单次观察窗口
    "panelPollMs": 5000            // 面板轮询间隔
  },
  "projectsCache": [               // az8 projects list 的缓存（面板顶部选择器用）
    { "id": "e2c9…", "name": "Blank Reel", "role": "owner", "updatedAt": "…" }
  ],
  "runs": [                        // 运行日志，append-only，上限 200 条（超出裁最老）
    {
      "id": "r17",                 // 本地 id（水位线分配，见 meta.idSeq）
      "projectId": "e2c9…", "projectName": "Blank Reel",
      "target": "image",           // image|video|audio|text
      "prompt": "…（截断 500 字）",
      "definitionId": "…", "definitionName": "GPT-Image-2 …",  // 可空=默认 Draft
      "status": "succeeded",       // 见 §6 状态机
      "viewNodeId": "…",           // 生成目标 View Node
      "workflowRunId": "…",        // az8 侧 Run id
      "creditsEstimated": 8, "creditsActual": 8,
      "assets": ["a9"],            // 产物 asset id 列表
      "startedAt": "…", "endedAt": "…",
      "error": null,               // { code, message, classification }
      "confirm": null              // awaiting_confirm 时挂 { planSummary, estimate }
    }
  ],
  "assets": [                      // 下载到本地的产物索引
    {
      "id": "a9",
      "runId": "r17", "projectId": "e2c9…",
      "kind": "image",             // image|video|audio|other（按 MIME）
      "filename": "r17-a9.png",    // 落盘名：{runId}-{assetId}.{ext}
      "bytes": 1234567, "mime": "image/png", "sha256": "…",
      "viewNodeId": "…", "coreNodeId": "…",
      "downloadedAt": "…"
    }
  ],
  "meta": { "idSeq": { "r": 16, "a": 8 }, "updatedAt": "…" }
}
```

### 2.2 skills 目录（默认 $DSH_HOME/integrations/dsh-az8/skills/，可指到同步盘）

```
skills/<slug>/            // slug = 定义名/场景的 kebab-case，如 gpt-image-2-人像
  SKILL.md                // 主文档：适用场景 / 关键参数 / 踩坑记录
  references/*.md         // 参考文档（正文点名才读）
  assets/                 // 参考图（面板可预览）
```
- 三级披露：`az8_skill list` 一行摘要 → `read` 取 SKILL.md → 点名 references 才读那篇。
- `mustRead: true` 标记（SKILL.md front-matter）：勾选后同会话未读就 generate 会被拒。
  v1 用 SKILL.md 首行注释 `<!-- must-read -->` 判定，不做 front-matter 解析器。

### 2.3 会话内内存态（不落盘）

- `sessionRef: { projectId, openedAt }` —— orchestrator 持有；`az8 session open` 幂等
  （已开且同 project 则复用，跨 project 先 close 再 open）。
- `capabilitiesCache: { loadedAt, ops: Set<string> }` —— capabilities.summary 缓存 10 分钟，
  用于操作名存在性预检（缺失时给出可读错误，而不是 CLI 原样 400）。

## 3. 外部接口（az8 CLI 命令面）

| 用途 | 命令 | 类别 |
|---|---|---|
| 身份/余额 | `az8 whoami` / `az8 credits` | 读 |
| 项目 | `az8 projects list --scope owned` / `get <id>` | 读 |
| 会话 | `az8 session open <pid>` / `current` / `close` / `resynchronize` | 载体 |
| 目录 | `az8 canvas query <pid> workflowDefinitions.summary --workflow-target T --workflow-capability C --workflow-search S --page-size N`（follow `pagination.nextCursor`） | 读 |
| 画布读 | session query `canvas.detail --view-node-id` / `capabilities.summary` | 读 |
| 生成操作链 | session operation `createGenerationTarget` → `planGeneration`(detail) → plan.operations(`addReference`/`removeReference`/`insertPromptReference` 按 plan 原样) → `startGeneration` | 写(除 plan) |
| 运行 | session query `getWorkflowRun --workflow-run-id` / operation `waitWorkflowRun`（单窗口） | 读/等 |
| 媒体 | `az8 canvas download <pid> --view-node-id V --output F` / `az8 canvas upload <pid> --file F --idempotency-key K --position-x/y` | 下载/上传 |

CLI 语义（契约，全部透传到工具层错误分类）：
- 退出码 `0` 成功 / `1` 确定性失败 / `2` 不确定（indeterminate）→ orchestrator 立即停链。
- stderr `az8.operation-progress.v1` 行是临时进度，只有终态 Receipt 算数；v1 不解析（工具结果
  只在最终块给阶段摘要），留 hook。
- 读类失败仅在 `error.retryable` 时由 cli.js 有限重试（≤3，同 deadline）；写类零重试。
- 每个写操作 `--request-id` 用 `az8-{runId}-{step}-{nanoid8}`，可追溯且不撞。

## 4. 数据流

### 4.1 对话生成流（主链路）
```
用户消息 → agent 调 az8_generate
  → orchestrator.generate(args)
     1. resolveProject（args > settings > 报错要求给 projectId）
     2. ensureSession（open/current，macOS daemon）
     3. [如指定模型] definitions 查询 → definitionId（0 或 >1 命中都停下返回候选）
     4. createGenerationTarget(op) ──Receipt──▶ viewNodeId        ─┐ journal: planning
     5. planGeneration(op, detail) ──▶ estimate + plan.operations  ─┤ journal: planning
     6. 闸门: estimate ≤ maxAutoCredits ?                          │
          否 → journal: awaiting_confirm，返回报价（STOP，用户确认后 resume） ◀─ 用户
          是 ↓                                                      │
     7. 逐个执行 plan.operations（每个等终态 Receipt）              ├─ journal: starting
     8. startGeneration(op) ──▶ workflowRunId                      │ journal: running
     9. sync: waitWorkflowRun(单窗口) / async: 后台 job 包同一个等待  │
    10. 终态 succeeded → canvas.detail(target) → 输出 coreNode       │
        → canvas download → assets 落盘 → journal: succeeded       ─┘
  → 工具结果：状态 + credits + 媒体 markdown 行（`![AZ8 image](/_dsh/dsh-az8/media?id=a9)`）
  → agent 把 markdown 行贴进回复 → 对话内出图（同源路由）
```

### 4.2 面板流（右侧停靠三页签）
```
client.js 轮询(pollMs) ──GET /state──▶ panel.js ──▶ store 只读快照
  运行页签: runs[] 状态徽章/credits/耗时 + 手动刷新按钮（顺带触发 credits 活查）
  资产页签: assets[] 网格（<img src=media?id> / <video controls>）+ 点击放大
  设置页签: 表单 ──POST set-settings──▶ store.mutate（校验后原子写）
credits 徽标: GET /credits → cli.js `az8 credits`（60s 内用缓存）
媒体: GET /media?id=a9 → assets 索引定位绝对路径 → 本地文件流（Range 206，视频可拖）
```

### 4.3 引用图流（img2img / 首末帧）
```
args.references[] 三种来源统一折算成 viewNodeId：
  source=file(path)   → canvas upload（幂等键=文件 sha256 前 16）→ Receipt 取 viewNodeId
  source=asset(assetId)→ 索引查 viewNodeId（已在画布上，直接用）
  source=viewNode(id)  → 原样透传
→ 交给 planGeneration 的 references（slotName 可选，意图明确时才给）
```

## 5. 控制流：生成状态机

状态枚举（journal.status）与转移：

```
            ┌────────────┐
            │  resolving │ resolveProject / ensureSession / definition 匹配
            └─────┬──────┘
        确定性失败 ▼
            ┌────────────┐
            │  planning  │ createTarget + plan
            └─────┬──────┘
      estimate>阈值│estimate≤阈值
   ┌──────────────▼──────────────┐
   │  awaiting_confirm ──resume─▶│（confirmed:true 重新进入 starting）
   └──────────────┬──────────────┘
                  ▼
            ┌────────────┐  plan.operations 逐个执行 + startGeneration
            │  starting  │
            └─────┬──────┘
                  ▼
            ┌────────────┐  waitWorkflowRun 单窗口结束仍未终态 → 保持 running，
            │  running   │  返回 runId 给 agent（az8_runs 再等）；不定结果→indeterminate
            └─────┬──────┘
        终态 succeeded / failed
                  ▼
            ┌────────────┐  canvas.detail → download → asset 落盘
            │downloading │
            └─────┬──────┘
                  ▼
       ┌────────────────────┐
       │succeeded │ failed  │ failed 只描述确定性失败；不确定一律 indeterminate
       └────────────────────┘
任意状态遇 exit 2 / 不确定 Receipt → indeterminate，停链，journal 记恢复指引
（reconnect + inspect + reconcileGenerationStart，绝不自动重试）。
```

守卫与不变量：
- I1 写操作串行：同一时刻至多一个 in-flight 写（orchestrator 内部队列锁）。
- I2 每个 request-id 全局唯一且含 runId，可审计。
- I3 下载产物先写 tmp 再 rename 入 assets 目录，索引条目与文件原子性以索引为准（孤儿文件
  下次启动清扫）。
- I4 报价闸门只在 plan → start 之间判定一次；resume 不重新判定（用户已确认）。
- I5 工具结果里的媒体 URL 是最终答案，提示 agent 直接贴、不要回查（抄 dsh-comfyui 话术）。

## 6. 全流程 DAG

### 6.1 模块依赖 DAG（= 开发拓扑序）
```
cli.js ──────────────┐
store.js ────────────┤
   │                │
   ▼                ▼
skills.js      orchestrator.js ──▶ panel.js ──▶ client.js(面板 UI)
   │                │
   └──────┬─────────┘
          ▼
      tools.js ──▶ index.js ──▶ locale/icon/docs ──▶ install_bundle
          │
          ▼
   test/(store 单测 + cli mock 的 orchestrator 状态机测试) ──▶ 真机冒烟
```

### 6.2 运行时 DAG（节点=动作，边=依赖）
```
login态(已配) ─ session ─ definitions ─ target ─ plan ─ ─gate─ operations ─ start ─ wait ─ detail ─ download ─ media路由
                   │        (可选)                                        │                      │
                   │                                                        ▼                      ▼
                   └── credits(徽标)                          journal(每步快照) ──▶ 面板轮询 / 对话 markdown
```

## 7. 模块清单与接口

| 模块 | 导出 | 职责 |
|---|---|---|
| cli.js | `run(args,{timeoutMs,parseJson})`, `runJson` | spawn az8；退出码分类 `{ok, definitive, indeterminate}`；读类有限重试；日志走 ctx.logger，永不打印 env/token |
| store.js | `loadState/saveState/mutate/nextId/settings` | state.json 读写（0600 原子）、水位线 id、journal 追加与裁剪 |
| orchestrator.js | `generate/resolve/runs/media` 高层 API | §5 状态机、session 生命周期、闸门、下载落盘、capabilities 预检 |
| skills.js | `list/read/write/append/mustReadGate` | §2.2 技能包 |
| panel.js | `installPanelWeb(ctx, deps)` | webServer 路由：GET state/credits/media，POST set-settings；localhost-only + Origin 校验（照搬 dsh-myinfo 语义） |
| tools.js | `buildTools()` → 6 个定义 | §8 工具契约；render 给可读 markdown；presentationMeta 标 sync/background |
| index.js | `apply/inject/Config` | 装配 + `inject:['tools']`；Config=schemastery（defaultProjectId 等） |
| client.js | `__ModuleLoader__.load` 工厂 | 右侧 dock 三页签 + settings.section；React=h；locale 服务可选 |

## 8. 工具契约（agent-facing）

1. `az8_status`：projects + credits + whoami 摘要 + settings + 当前 session。读。
2. `az8_definitions`：`{target, capability?, search?, pageSize?}` → 定义列表（跟随 cursor）。
3. `az8_generate`：`{prompt, target, definition?(名/模糊), references?[], projectId?, mode?, maxCredits?, confirmed?, resumeRunId?}` → journal 快照 + 媒体 markdown。sync/async（async 用 ctx.get('jobs')，缺失则降级 sync 并说明）。
4. `az8_runs`：`{action: list|get|wait, runId?, timeoutMs?}`。
5. `az8_media`：`{action: download|upload, ...}`（下载补挂资产 / 上传参考图）。
6. `az8_skill`：`{action: list|read|write|append, slug?, content?}`。

命名与描述遵守 agent-experience 原则：动作枚举进 description，返回块自带"下一步话术"。

## 9. 错误分类与恢复

| 分类 | 来源 | 处理 |
|---|---|---|
| 确定性失败 | exit 1 / Receipt error / 0 命中模型 | journal failed + 可读原因；agent 修正后**新** request-id 重试 |
| 不确定 | exit 2 / 超时丢回包 | journal indeterminate + 恢复指引（resync/reconcile）；绝不自动重试 |
| 读失败 | query 报错 | error.retryable 才重试 ≤3；否则上抛 |
| 等待窗口到点 | Run 仍 running | 普通 read 结果；返回 runId，不算失败 |

## 10. 安全

- 面板/媒体路由：仅回环、Host 白名单、POST JSON+Origin 校验（复用 dsh-myinfo panel.js 语义）。
- 媒体按 assetId 索引寻址（文件名仅展示），天然无路径穿越；Range 支持 206。
- state.json 0600；不存任何 az8 凭证；不 `cat/grep` CLI 凭证文件。
- 工具描述明示"报价超阈值必须停下问用户"，把闸门写进 agent 行为。

## 11. 测试计划

1. `test/store.test.mjs`：水位线、裁剪、原子写、settings 校验。
2. `test/orchestrator.test.mjs`：注入 fake cli（脚本桩），覆盖状态机全转移 + 闸门 + exit2 停链。
3. 真机冒烟（手动，一次）：definitions → generate(image, 最便宜) → 面板资产页出现 → 对话内出图。

## 12. 开发顺序（按 §6.1 拓扑）

cli → store → skills → orchestrator → panel → tools → index → client → locale/icon/docs
→ 单测 → install_bundle → 冒烟 → 交付报告

## 13. 真机校准记录（2026-11-09 冒烟后回写）

实现期用 fake-CLI 单测跑通状态机后，真机冒烟校准了四处 Receipt 真实形态：

1. **planGeneration 返回嵌套**：`result.plan.{definition, draft, estimate.credits.{total,canAfford},
   issues[], operations[], ready, configFields[]}`；`result.alternatives[]` 在默认 Draft 不可用时
   给候选定义。适配层 `inner = result.plan ?? result`。
2. **默认 Draft 可能带脏 config**（config-field-unknown，ready:false）：planGeneration 是
   bounded-read，允许用 `configFields` 重建干净 config 重 plan 一次（orchestrator 自动做）。
3. **产物挂点是 coreNodeId**：`workflowRun.outputs[] = {coreNodeId, role, slotName}`；
   `az8 canvas download --core-node-id` 直取。下载 Receipt（az8.canvas.media-download.v1）
   的元数据在 `file.{bytes, contentType, detectedExtension, path, checksum.hex}`。
4. **getWorkflowRun 是 operation 不是 query flag**：`session operation getWorkflowRun
   --input-json {"workflowRunId"}`；`waitWorkflowRun` 同为 operation，单窗口等待已验证。
   实耗 credits 在 `workflowRun.usage.credits.actual`（首单实测 estimate 6 / actual 0）。
5. **Desktop GUI 进程 PATH 缺 npm 全局 bin**：cli.js 做 PATH 增广 + 裸名解析绝对路径，
   否则宿主侧 az8_status/credits 会 502。

冒烟结果：r4（GPT-Image-2 文生图，报价 6）全链路 succeeded → 产物 a1（85,667 B PNG）
经 `/_dsh/dsh-az8/media?id=a1` 出图（200/206 Range 均通过）。
