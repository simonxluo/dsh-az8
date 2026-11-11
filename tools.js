/**
 * dsh-az8 — agent 工具（docs/design.md §8）。6 个工具全部薄封装 orchestrator，
 * 返回结构化 JSON + render 出可读 markdown。az8_generate 的返回自带媒体
 * markdown 行与「直接贴、不要回查」话术（dsh-comfyui 验证过的展示模式）。
 */
import * as store from './store.js';
import { markdownForAsset } from './panel.js';

const OBJ = { type: 'object', additionalProperties: true };

function textBlock(text) {
	return [{ type: 'text', text }];
}

function statusEmoji(status) {
	return { succeeded: '✅', failed: '❌', running: '⏳', awaiting_confirm: '🛑', planning: '🧭', resolving: '🔍', 'needs-choice': '❓', indeterminate: '⚠️', starting: '🚀', downloading: '📥' }[status] ?? '•';
}

function renderRun(run, extras = {}) {
	const lines = [`${statusEmoji(run.status)} AZ8 run ${run.id} — ${run.status}${run.target ? `（${run.target}）` : ''}`];
	if (run.projectName !== '') lines.push(`项目：${run.projectName}（${run.projectId}）`);
	if (run.definitionName !== '' || run.definitionId !== '') lines.push(`工作流：${run.definitionName || run.definitionId}`);
	if (run.prompt !== '') lines.push(`prompt：${run.prompt.slice(0, 120)}${run.prompt.length > 120 ? '…' : ''}`);
	const credits = [];
	if (run.creditsEstimated !== undefined && run.creditsEstimated !== null) credits.push(`报价 ${run.creditsEstimated}`);
	if (run.creditsActual !== undefined && run.creditsActual !== null) credits.push(`实耗 ${run.creditsActual}`);
	if (credits.length > 0) lines.push(`credits：${credits.join(' / ')}`);
	if (run.error !== null && run.error !== undefined) lines.push(`错误：${run.error.message}`);
	if (extras.assets !== undefined && extras.assets.length > 0) {
		lines.push('');
		lines.push('生成产物（直接把下面几行贴进回复即可展示，不要再查状态）：');
		for (const asset of extras.assets) lines.push(markdownForAsset(asset));
	}
	if (extras.needsConfirmation === true) lines.push('', extras.hint ?? '');
	if (extras.candidates !== undefined) {
		lines.push('', '候选工作流（带 definitionId 重试）：');
		for (const c of extras.candidates) lines.push(`- ${c.name} — ${c.definitionId}${c.capability ? `（${c.capability}）` : ''}`);
	}
	if (extras.stillRunning === true) lines.push('', extras.note ?? '仍在运行，稍后再等一个窗口。');
	if (extras.background !== undefined) {
		lines.push('', `后台任务已启动（job ${extras.background.jobId}）。本回合到此为止，收到完成通知后用 job_output 取结果。`);
	}
	if (extras.note !== undefined && extras.stillRunning !== true && extras.background === undefined && extras.note !== '') lines.push('', extras.note);
	if (extras.guidance !== undefined && extras.guidance !== '') lines.push('', extras.guidance);
	return lines.join('\n');
}

function renderStatus(status) {
	const lines = ['### AZ8 状态'];
	const account = status.whoami ?? {};
	lines.push(`- 账号：${account.nickname ?? account.email ?? '未知'}${account.subscriptionType ? `（${account.subscriptionType}）` : ''}`);
	for (const balance of status.credits ?? []) {
		lines.push(`- credits：${balance.availableCredits}（${balance.payer}）`);
	}
	lines.push(`- 会话：${status.session?.active === true ? '已连接' : '未连接'}`);
	const settings = status.settings ?? {};
	lines.push(`- 设置：默认项目 ${settings.defaultProjectId || '（未设）'}，报价闸门 ${settings.maxAutoCredits} credits，等待窗口 ${Math.round((settings.waitTimeoutMs ?? 0) / 1000)}s`);
	if ((status.projects ?? []).length > 0) {
		lines.push('', '| 项目 | id |', '|---|---|');
		for (const p of status.projects) lines.push(`| ${p.name} | \`${p.id}\` |`);
	}
	return lines.join('\n');
}

export function buildTools(orch) {
	return [
		{
			name: 'az8_status',
			description: '查看 AZ8 状态：账号、credits 余额、项目列表（含 id）、当前会话与插件设置。'
				+ '生成前想确认项目 id / 余额，或用户问"我还剩多少额度"时调用。只读。',
			parameters: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			output: { schema: OBJ, render: (_a, v) => textBlock(renderStatus(v)) },
			async execute() { return orch.status(); },
		},
		{
			name: 'az8_definitions',
			description: '搜索 AZ8 工作流定义目录（模型/能力）。用户点名模型（如 "GPT-Image-2"）、'
				+ '问"有什么模型能画视频"时调用；把返回的 definitionId 传给 az8_generate。只读。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', enum: ['image', 'video', 'audio', 'text'], description: '生成目标类型' },
					capability: { type: 'string', description: '精确能力过滤，如 text-to-image / image-to-video（空格/下划线会归一为连字符）' },
					search: { type: 'string', description: '大小写不敏感子串搜索（匹配 id/name/group）' },
					pageSize: { type: 'number', minimum: 1, maximum: 50, description: '页大小，默认 20' },
					projectId: { type: 'string', description: '项目 id（缺省用设置里的默认项目）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: OBJ,
				render: (_a, v) => textBlock((v.definitions ?? []).length === 0
					? '没有命中的工作流定义（换 search/target 再试）'
					: ['### 工作流定义', ...(v.definitions ?? []).map((d) => `- **${d.name ?? d.definitionId ?? d.id}** — \`${d.definitionId ?? d.id}\`（${d.capability ?? '?'}）`)].join('\n')),
			},
			async execute(args) {
				return orch.definitions(args ?? {});
			},
		},
		{
			name: 'az8_generate',
			description: '在 AZ8 生成图片/视频/音频：选题型 → plan 报价 → （过闸门自动跑 / 超闸门停下等确认）'
				+ '→ 生成 → 下载产物。THE way to generate。参数：prompt 必填；target 默认 image；'
				+ 'definition 传用户点名的模型名（模糊命中多个会返回候选）；references 支持本地图片路径'
				+ '（自动上传）/ 之前产物 assetId / 画布 viewNodeId，slotName 在意图明确时才给（如 first_frame_url）。'
				+ '报价超过 maxAutoCredits（默认 30）会停在 awaiting_confirm 并给 resumeRunId——问用户，同意后带 '
				+ '{ resumeRunId, confirmed: true } 继续，绝不能自作主张确认。视频建议 mode:"async"（后台 job，'
				+ '启动后结束回合，等完成通知再 job_output）。结果里的媒体 markdown 行是最终答案：直接贴进回复展示，'
				+ '不要回查状态。',
			parameters: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: '生成提示词' },
					target: { type: 'string', enum: ['image', 'video', 'audio', 'text'], description: '默认 image' },
					definition: { type: 'string', description: '模型/工作流名（用户点名时传）' },
					definitionId: { type: 'string', description: '精确 definitionId（az8_definitions 拿到的）' },
					references: {
						type: 'array',
						description: '引用（图生图/首末帧等）',
						items: {
							type: 'object',
							properties: {
								path: { type: 'string', description: '本地文件路径（自动上传到画布）' },
								assetId: { type: 'string', description: '之前 az8_generate 产物的 assetId' },
								viewNodeId: { type: 'string', description: '画布上已有的 view node id' },
								slotName: { type: 'string', description: '目标输入槽名，如 first_frame_url；意图明确才给' },
							},
							additionalProperties: false,
						},
					},
					config: { type: 'object', description: '工作流配置项覆盖（如 {"aspect_ratio":"1:1","quality":"low"}），字段见 plan 的 configFields；不传用默认 Draft（脏配置会自动清洗重 plan 一次）', additionalProperties: true },
					projectId: { type: 'string', description: '项目 id（缺省用默认项目）' },
					mode: { type: 'string', enum: ['sync', 'async'], description: '默认 sync；视频用 async（后台 job）' },
					maxCredits: { type: 'number', description: '本次报价闸门（覆盖设置值）' },
					confirmed: { type: 'boolean', description: 'resume 时必须 true（用户已同意报价）' },
					resumeRunId: { type: 'string', description: 'awaiting_confirm 的 run id' },
					waitMs: { type: 'number', description: 'sync 等待窗口 ms（默认 180000）' },
					skill: { type: 'string', description: '遵循的技能包 slug（must-read 的必须先 az8_skill read）' },
				},
				required: ['prompt'],
				additionalProperties: false,
			},
			output: {
				schema: OBJ,
				render: (_a, v) => textBlock(renderRun(v, v)),
				presentationMeta(_args, value) {
					if (value?.background !== undefined) return { kind: 'background', jobId: value.background.jobId, label: value.background.label };
					return { kind: 'sync', status: value?.status, runId: value?.id, mediaCount: value?.assets?.length ?? 0 };
				},
			},
			timeoutMs: 3_600_000,
			async execute(args) { return orch.generate(args ?? {}); },
		},
		{
			name: 'az8_runs',
			description: '查看/等待生成运行：list 列运行日志（含历史），get 看单个 run（含错误与恢复指引），'
				+ 'wait 对 running 的 run 再等一个观察窗口（视频后台跑完后收尾用）。只读 + 有界等待。',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'get', 'wait'], description: '默认 list' },
					runId: { type: 'string', description: 'get/wait 必填' },
					timeoutMs: { type: 'number', description: 'wait 的观察窗口 ms（默认 180000）' },
				},
				additionalProperties: false,
			},
			output: { schema: OBJ, render: (_a, v) => textBlock(renderRun(v, v)) },
			async execute(args) {
				const a = args ?? {};
				if (a.action === 'get' || a.action === 'wait') {
					if (!a.runId) throw new store.StoreError(`${a.action} 需要 runId`);
					if (a.action === 'wait') return orch.waitRun(a.runId, a.timeoutMs);
					const state = store.loadState();
					return store.getRun(state, a.runId) ?? (() => { throw new store.StoreError(`run ${a.runId} 不存在`); })();
				}
				return { runs: store.loadState().runs.slice(0, 30) };
			},
		},
		{
			name: 'az8_media',
			description: '媒体搬运：upload 把本地文件传到项目画布（拿 viewNodeId 当引用/首末帧）；'
				+ 'download 按 viewNodeId 下载画布产物补挂资产（az8_generate 没自动下载到时用）。',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['upload', 'download'] },
					path: { type: 'string', description: 'upload：本地文件绝对路径' },
					projectId: { type: 'string', description: '项目 id' },
					name: { type: 'string', description: 'upload：画布上显示的名称（可选）' },
					viewNodeId: { type: 'string', description: 'download：产物 view node id' },
					runId: { type: 'string', description: 'download：归属的 run（日志里记资产）' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			output: {
				schema: OBJ,
				render: (_a, v) => textBlock(v.asset !== undefined
					? `已下载 ${v.asset.filename}（${v.asset.kind}）。展示用：\n${markdownForAsset(v.asset)}`
					: `已上传，viewNodeId: ${v.viewNodeId}`),
			},
			async execute(args) {
				const a = args ?? {};
				if (a.action === 'upload') {
					const status = await orch.status();
					const projectId = a.projectId ?? status.settings.defaultProjectId;
					if (!projectId) throw new store.StoreError('需要 projectId（或先设置默认项目）');
					if (!a.path) throw new store.StoreError('upload 需要 path');
					return orch.uploadMedia({ path: a.path, projectId, name: a.name });
				}
				if (a.action === 'download') {
					if (!a.viewNodeId) throw new store.StoreError('download 需要 viewNodeId');
					const runId = a.runId ?? 'manual';
					const state = store.loadState();
					const projectId = a.projectId ?? state.settings.defaultProjectId;
					if (!projectId) throw new store.StoreError('需要 projectId（或先设置默认项目）');
					const asset = await orch.downloadOne(projectId, { viewNodeId: a.viewNodeId }, runId);
					if (runId !== 'manual') {
						await store.mutate((s) => {
							const run = store.getRun(s, runId);
							if (run !== undefined && !run.assets.includes(asset.id)) run.assets.push(asset.id);
						});
					}
					return { asset };
				}
				throw new store.StoreError('action 需是 upload 或 download');
			},
		},
		{
			name: 'az8_skill',
			description: 'AZ8 技能包（跨会话沉淀生成经验）：list 一行摘要（含 must-read 标记）；read 读正文'
				+ '（同时解除该技能的必读闸门）；write/append 写回踩坑经验。生成某类图前先 list 看有没有相关技能。',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'read', 'write', 'append'] },
					slug: { type: 'string', description: '技能包 slug（read/write/append 必填）' },
					content: { type: 'string', description: 'write/append 的 markdown 内容' },
					reference: { type: 'string', description: 'read 的参考文档文件名（可选，正文点名才读）' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			output: {
				schema: OBJ,
				render: (_a, v) => textBlock(v.content !== undefined ? v.content
					: (v.skills ?? []).length === 0 ? '暂无技能包。生成踩到坑就 append 一条。'
						: ['### 技能包', ...(v.skills ?? []).map((s) => `- ${s.mustRead ? '⭐ ' : ''}**${s.slug}** — ${s.summary}`)].join('\n')),
			},
			async execute(args) {
				const a = args ?? {};
				if (a.action === 'list') return { skills: await orch.listSkills() };
				if (a.action === 'read') {
					if (!a.slug) throw new store.StoreError('read 需要 slug');
					const { readSkill } = await import('./skills.js');
					const result = await readSkill(a.slug, a.reference);
					orch.markSkillRead(a.slug);
					return result;
				}
				if (a.action === 'write' || a.action === 'append') {
					if (!a.slug || !a.content) throw new store.StoreError('write/append 需要 slug 和 content');
					const { writeSkill } = await import('./skills.js');
					return writeSkill(a.slug, a.content, a.action === 'append' ? 'append' : 'write');
				}
				throw new store.StoreError('action 需是 list/read/write/append');
			},
		},
	];
}
