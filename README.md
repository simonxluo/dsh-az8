# dsh-az8

[![License: MIT](https://img.shields.io/badge/License-MIT-5b2bd9.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-0a84ff.svg)](https://github.com/topics/dsh-plugin)
[![az8 CLI](https://img.shields.io/badge/az8-CLI%20contract-b82b8f.svg)](https://www.npmjs.com/package/@everfir/az8-cli)

**在 DeepSeek Harness 对话里直接生成 AZ8 图片/视频**：报价闸门、运行日志、资产面板、
技能包。展示层参考
[dsh-comfyui](https://github.com/fandc520/dsh-comfyui) 的三页签面板 / 媒体
markdown 直贴 / 技能包三级披露；云端通道严格遵守
[az8 CLI](https://www.npmjs.com/package/@everfir/az8-cli) 契约（一次一个操作、写操作等
终态 Receipt、失败绝不自动重试）。

> 设计文档（数据结构 / 数据流 / 控制流 / 全流程 DAG / 真机校准记录）：
> [docs/design.md](docs/design.md)

## 它能干什么

对话里一句"用 AZ8 画一张红猫"，agent 走完：选题型 → plan 报价 → **报价闸门** →
生成 → 下载 → 把媒体 markdown 直接贴进回复——你在对话里看到图，同时右侧面板的
「资产」页签出现同一条产物。

- 报价超过 `maxAutoCredits`（默认 30）会停在 `awaiting_confirm` 并返回
  `resumeRunId`：**问过用户才继续**，agent 不能自作主张确认
- 视频用 `mode: "async"`：后台 job，启动后结束回合，完成通知回来取结果
- 生成产物（图/视频/音频）落盘到本地资产目录，经同源媒体路由
  `/_dsh/dsh-az8/media?id=<assetId>` 展示——对话 markdown 与面板共用一条路由，
  无 CORS、无凭证下发
- 踩坑经验用 `az8_skill` 写进技能包，跨会话复用；标记 `must-read` 的技能没读就
  生成会被拒

### Agent 工具（6 个）

| 工具 | 用途 |
|---|---|
| `az8_status` | 账号 / credits / 项目列表（含 id）/ 会话 / 设置，只读 |
| `az8_definitions` | 工作流定义目录搜索（target / capability / 子串） |
| `az8_generate` | 主链路：选题型 → 报价 → 闸门 → 生成 → 下载 → 媒体 markdown |
| `az8_runs` | 运行日志 list / get / wait（单观察窗口） |
| `az8_media` | upload（本地文件上画布当引用/首末帧）/ download（补挂产物） |
| `az8_skill` | 技能包 list / read / write / append（must-read 闸门） |

### 面板（右侧 dock 三页签 + 设置页区块）

- **运行** — 状态徽章、报价/实耗 credits、错误与恢复指引
- **资产** — 产物网格：图片点击放大、视频可拖进度条（Range/206）、音频播放
- **设置** — 默认项目、报价闸门、等待窗口、面板刷新间隔

## 安装

前置：[az8 CLI](https://www.npmjs.com/package/@everfir/az8-cli) 已安装且
`az8 whoami` 可用。凭证由 az8 CLI 按操作系统用户保管，本插件不接触。

```bash
# web profile
dsh plugin --profile web add github:simonxluo/dsh-az8
# desktop profile
dsh plugin --profile desktop add github:simonxluo/dsh-az8
```

重启应用后：右侧 dock 出现 **AZ8** 页签，设置页出现「AZ8 生成」区块，agent 获得
全部工具。

## 架构

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
│  ┌─────────────┐  ┌────▼──────────┐   webServer 路由                       │
│  │  client.js  │◀─│ panel.js      │  /_dsh/dsh-az8/{state,credits,media}  │
│  │ 右侧三页签   │  │ 面板 API+媒体  │                                       │
│  └─────────────┘  └───────────────┘                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

模块拓扑（依赖序）：`cli` → `store` → `skills` → `orchestrator` → `panel` →
`tools` → `index` → `client`。每个模块的职责、接口与生成状态机设计见
[docs/design.md](docs/design.md)。

## 配置

`cordis.yml` 的 `az8` 段：

| 键 | 默认 | 说明 |
|---|---|---|
| `cliBin` | `az8` | CLI 可执行名/绝对路径（Desktop GUI 的 PATH 会自动增广常见 npm 全局 bin） |
| `stateFile` | `$DSH_HOME/integrations/dsh-az8/state.json` | 运行日志/资产索引（0600 原子写） |
| `assetsDir` | `…/dsh-az8/assets` | 产物落盘目录（可指大容量盘） |
| `skillsDir` | `…/dsh-az8/skills` | 技能包根目录（可指 git 仓库做版本管理） |

面板设置页可改：默认项目、报价闸门（默认 30 credits）、等待窗口（默认 180s）、
轮询间隔。

## 安全

- az8 凭证由 CLI 自管：本插件只 spawn `az8`，不读取、不记录、不转发任何 token
- 面板与媒体路由仅本机回环、Host 白名单（防 DNS rebinding）、POST 校验
  Origin / Sec-Fetch-Site（防跨站写入）
- 媒体按 assetId 索引寻址，文件名仅展示，无路径穿越面；`state.json` 0600

## 开发

```bash
npm install
npm test   # store + orchestrator 状态机（fake CLI，不碰真 az8）
```

测试覆盖：水位线 id、journal 裁剪、settings 校验、报价闸门 → resume、脏 config
自动清洗、exit 2 不确定停链、plan 阻塞、running → 再等一窗口等。真机校准记录
（AZ8 Receipt 真实形态）在 [docs/design.md §13](docs/design.md)。

## License

[MIT](LICENSE)
