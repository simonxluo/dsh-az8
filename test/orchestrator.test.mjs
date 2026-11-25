/**
 * orchestrator 状态机单测：注入 fake CLI runner（不碰真 az8），覆盖
 * design §5 的关键转移：无项目失败 / 模型候选歧义 / 报价闸门 → awaiting_confirm
 * → resume 执行 planOps → 等待成功 → 下载落盘 / exit 2 不确定停链。
 * 运行：node test/orchestrator.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'dsh-az8-orch-'));
process.env.DSH_AZ8_STATE = join(dir, 'state.json');
process.env.DSH_AZ8_ASSETS = join(dir, 'assets');
process.env.DSH_AZ8_SKILLS = join(dir, 'skills');

const { createOrchestrator, buildRunDetail, scrubFacts, pickHistory } = await import('../orchestrator.js');
const store = await import('../store.js');

const OPS = ['createGenerationTarget', 'planGeneration', 'startGeneration', 'waitWorkflowRun', 'getWorkflowRun', 'addReference'];
const CAPS = { operations: OPS.map((name) => ({ name })) };
const SCHEMAS = {
	createGenerationTarget: { type: 'object', properties: { target: { enum: ['image', 'video', 'audio', 'text'] } } },
	planGeneration: { type: 'object', properties: { viewNodeId: {}, prompt: {}, definitionId: {}, references: {}, detail: { enum: ['summary', 'detail'] } } },
	waitWorkflowRun: { type: 'object', properties: { workflowRunId: {}, timeoutMs: {} } },
};

function fakeRunner(script = {}) {
	return async (args) => {
		const key = args.join(' ');
		// capabilities.detail 按操作名分发
		if (args[0] === 'session' && args[2] === 'capabilities.detail') {
			const name = args.at(-1);
			return { exitCode: 0, killed: false, classification: 'ok', stdout: JSON.stringify({ name, schema: SCHEMAS[name] ?? { type: 'object', properties: {} } }), stderr: '', json: { name, schema: SCHEMAS[name] ?? { type: 'object', properties: {} } } };
		}
		if (args[0] === 'session' && args[2] === 'capabilities.summary') {
			return { exitCode: 0, killed: false, classification: 'ok', stdout: JSON.stringify(CAPS), stderr: '', json: CAPS };
		}
		if (args[0] === 'session' && (args[1] === 'open' || args[1] === 'current' || args[1] === 'close')) {
			return { exitCode: 0, killed: false, classification: 'ok', stdout: '{}', stderr: '', json: {} };
		}
		if (args[0] === 'session' && args[2] === 'workflowDefinitions.summary') {
			const defs = script.definitions ?? [{ definitionId: 'def-1', name: 'GPT-Image-2 Pro', capability: 'text-to-image' }];
			return { exitCode: 0, killed: false, classification: 'ok', stdout: JSON.stringify({ definitions: defs, pagination: { hasMore: false } }), stderr: '', json: { definitions: defs, pagination: { hasMore: false } } };
		}
		if (args[0] === 'session' && args[2] === 'canvas.detail') {
			const canvasDetail = script.canvasDetail ?? {};
			return { exitCode: 0, killed: false, classification: 'ok', stdout: JSON.stringify(canvasDetail), stderr: '', json: canvasDetail };
		}
		if (args[0] === 'session' && args[1] === 'operation') {
			const name = args[2];
			if (script.opFail?.[name] !== undefined) {
				const { exitCode, stderr } = script.opFail[name];
				return { exitCode, killed: false, classification: exitCode === 2 ? 'indeterminate' : 'definitive', stdout: '', stderr, json: undefined };
			}
			const json = script.ops?.[name] ?? { outcome: 'ok', result: {} };
			return { exitCode: 0, killed: false, classification: 'ok', stdout: JSON.stringify(json), stderr: '', json };
		}
		if (args[0] === 'canvas' && args[1] === 'download') {
			const output = args[args.indexOf('--output') + 1];
			await writeFile(output, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
			return {
				exitCode: 0, killed: false, classification: 'ok',
				stdout: '{}', stderr: '',
				// 真机 Receipt（az8.canvas.media-download.v1）：元数据在 file.{bytes, contentType, detectedExtension}
				json: { absolutePath: output, bytes: 16, mime: 'image/png', sha256: 'abc', coreNodeId: 'cn-1', file: { bytes: 16, contentType: 'image/png', detectedExtension: '.png' } },
			};
		}
		if (args[0] === 'whoami' || args[0] === 'credits' || args[0] === 'projects') {
			return { exitCode: 0, killed: false, classification: 'ok', stdout: '{}', stderr: '', json: args[0] === 'projects' ? { projects: [] } : {} };
		}
		return { exitCode: 1, killed: false, classification: 'definitive', stdout: '', stderr: `fake: no handler for ${key}`, json: undefined };
	};
}

const PLAN_OPS = [
	{ name: 'editGenerationDraft', input: { viewNodeId: 'vn-1' } },
	{ name: 'startGeneration', input: { viewNodeId: 'vn-1' } },
];
const planResult = (overrides = {}) => ({ alternatives: [], plan: { ready: true, issues: [], estimate: { credits: { total: 50, canAfford: true } }, operations: PLAN_OPS, ...overrides } });
const GOOD_OPS = {
	createGenerationTarget: { outcome: 'succeeded', result: { viewNodeId: 'vn-1' } },
	planGeneration: { outcome: 'succeeded', result: planResult() },
	startGeneration: { outcome: 'succeeded', result: { workflowRunId: 'wr-1' } },
	waitWorkflowRun: { outcome: 'succeeded', result: { status: 'succeeded', usage: { credits: 48 }, outputs: [{ viewNodeId: 'out-1' }] } },
};

async function freshOrch(script) {
	await rm(process.env.DSH_AZ8_STATE, { force: true });
	return createOrchestrator({ runner: fakeRunner(script), logger: undefined });
}

// --- 1) 无项目 → 失败且指引明确 ----------------------------------------------
{
	const orch = await freshOrch({});
	const result = await orch.generate({ prompt: '红猫', target: 'image' });
	assert.equal(result.status, 'failed');
	assert.equal(result.error.code, 'no-project');
}

// --- 2) 模型名歧义 → needs-choice + 候选 ---------------------------------------
{
	const orch = await freshOrch({
		definitions: [
			{ definitionId: 'd1', name: 'GPT-Image-2 Pro', capability: 'text-to-image' },
			{ definitionId: 'd2', name: 'GPT-Image-2 Mini', capability: 'text-to-image' },
		],
	});
	const result = await orch.generate({ prompt: 'x', target: 'image', projectId: 'p1', definition: 'GPT-Image-2' });
	assert.equal(result.status, 'needs-choice');
	assert.equal(result.candidates.length, 2);
}

// --- 3) 报价闸门 → awaiting_confirm → resume → 成功 + 产物落盘 -------------------
{
	const orch = await freshOrch({ ops: GOOD_OPS });
	const gated = await orch.generate({ prompt: '红猫', target: 'image', projectId: 'p1' });
	assert.equal(gated.status, 'awaiting_confirm');
	assert.equal(gated.confirm.estimate, 50);
	assert.equal(gated.needsConfirmation, true);

	const done = await orch.generate({ resumeRunId: gated.id, confirmed: true });
	assert.equal(done.status, 'succeeded');
	assert.equal(done.workflowRunId, 'wr-1');
	assert.equal(done.assets.length, 1);
	assert.equal(done.assets[0].kind, 'image');
	assert.equal(done.creditsActual, 48);
	const asset = store.getAsset(store.loadState(), done.assets[0].id);
	assert.ok(asset !== undefined && existsSync(join(store.getAssetsDir(), asset.filename)), '产物文件应落盘');

	// resume 但没 confirmed → 拒绝
	const gated2 = await orch.generate({ prompt: 'y', target: 'image', projectId: 'p1' });
	await assert.rejects(() => orch.generate({ resumeRunId: gated2.id }), /confirmed/);
}

// --- 4) 低报价直通（estimate ≤ 闸门）-------------------------------------------
{
	const orch = await freshOrch({
		ops: { ...GOOD_OPS, planGeneration: { outcome: 'succeeded', result: planResult({ estimate: { credits: { total: 8, canAfford: true } } }) } },
	});
	const done = await orch.generate({ prompt: '小图', target: 'image', projectId: 'p1' });
	assert.equal(done.status, 'succeeded');
}

// --- 5) exit 2（不确定）→ indeterminate 停链，绝不自动重试 ------------------------
{
	const orch = await freshOrch({
		ops: { ...GOOD_OPS, startGeneration: undefined },
		opFail: { startGeneration: { exitCode: 2, stderr: 'transport lost' } },
	});
	const result = await orch.generate({ prompt: 'x', target: 'image', projectId: 'p1', maxCredits: 100 });
	assert.equal(result.status, 'indeterminate');
	assert.match(result.error.message, /transport lost/);
}

// --- 6) plan 阻塞问题 → failed --------------------------------------------------
{
	const orch = await freshOrch({
		ops: { ...GOOD_OPS, planGeneration: { outcome: 'succeeded', result: planResult({ ready: false, issues: [{ code: 'no-model', severity: 'error' }] }) } },
	});
	const result = await orch.generate({ prompt: 'x', target: 'image', projectId: 'p1' });
	assert.equal(result.status, 'failed');
	assert.equal(result.error.code, 'plan-blocking');
}

// --- 7) waitRun：running → 再等一窗口成功 ---------------------------------------
{
	const orch = await freshOrch({
		ops: { ...GOOD_OPS, waitWorkflowRun: { outcome: 'ok', result: { status: 'running' } } },
	});
	const first = await orch.generate({ prompt: 'x', target: 'image', projectId: 'p1', maxCredits: 100 });
	assert.equal(first.status, 'running');
	assert.equal(first.stillRunning, true);

	const orch2 = createOrchestrator({ runner: fakeRunner({ ops: GOOD_OPS }) });
	// 直接对同一 run 再等：换一个 runner 让 wait 返回成功（daemon 无状态，走 getWorkflowRun 分支不可用，仍走 waitWorkflowRun）
	const done = await orch2.waitRun(first.id, 60000);
	assert.equal(done.status, 'succeeded');
}


// --- 8) runDetail：老 run 从画布 history 回填，中间产物按血缘，回填后零 CLI ------------
// 形态取自 2026-11-25 真机抓包（design §13b-6）：canvas.detail 只返回目标节点本身。
{
	const FACTS = {
		id: 'wr-old', status: 'completed', definitionId: 'def-1', definitionVersion: 38,
		startedAt: '2026-11-09T18:24:03.527855+08:00', endedAt: '2026-11-09T18:24:18.976441+08:00',
		inputs: { config: ['cfg-core'], prompt: ['prompt-core'], image_url: 'https://example.com/presigned-secret' },
		outputs: [{ coreNodeId: 'core-final', role: '', slotName: 'image_urls' }],
		usage: { credits: { actual: 0, estimated: 6, status: 'actual' } },
	};
	const NODE = {
		id: 'vn-old', type: 'resource', contentType: 'image', createdAt: 1794219658826, resolvedCoreNodeId: 'core-final',
		history: [
			// 同一节点上另一代生成：config 不同，必须不被选中
			{ id: 'gen-other', definitionId: 'def-other', createdAt: 1794219000000, inputs: { slots: { config: [{ kind: 'literal', content: '{"quality":"high"}' }] } }, runtime: { instanceIds: ['wr-other'] } },
			{
				id: 'gen-mine', definitionId: 'def-1', createdAt: 1794219840739, updatedAt: 1794219843586,
				inputs: { slots: { prompt: [{ kind: 'literal', content: '红猫' }], config: [{ kind: 'literal', content: '{"aspect_ratio":"1:1","quality":"low"}' }] } },
				runtime: { expectedCost: 6, expectedDefinitionVersion: 38, instanceIds: ['wr-old'], submittedAt: 1794219843435 },
			},
		],
	};
	const script = {
		ops: { getWorkflowRun: { outcome: 'succeeded', result: { workflowRun: FACTS } } },
		definitions: [{ id: 'def-1', name: 'GPT-Image-2', capability: 'text-to-image', target: 'image', group: 'gpt_lmage_2', version: 38 }],
		canvasDetail: { result: { canvas: { viewNodes: [NODE] } } },
	};
	const base = fakeRunner(script);
	let cliCalls = 0;
	const downloads = [];
	const orch = createOrchestrator({ runner: async (args) => { cliCalls++; if (args[0] === 'canvas' && args[1] === 'download') downloads.push(args.slice(2)); return base(args); } });
	await rm(process.env.DSH_AZ8_STATE, { force: true });
	await store.mutate((s) => {
		store.appendRun(s, {
			id: 'r1', projectId: 'p1', projectName: 'p1', target: 'image', prompt: '红猫',
			definitionId: 'def-1', definitionName: '', status: 'succeeded',
			viewNodeId: 'vn-old', workflowRunId: 'wr-old', creditsEstimated: 6, creditsActual: 0,
			assets: ['a1'], startedAt: '2026-11-09T10:20:50.667Z', endedAt: '2026-11-09T10:33:29.852Z', error: null, confirm: null,
		});
		store.appendAsset(s, { id: 'a1', runId: 'r1', projectId: 'p1', kind: 'image', filename: 'r1-a1.png', mime: 'image/png', bytes: 85667, sha256: 'a554387a', viewNodeId: '', coreNodeId: 'core-final', downloadedAt: '2026-11-09T10:33:29.851Z' });
	});

	const first = await orch.runDetail('r1');
	assert.deepEqual(first.intermediates, [], '唯一的 output 就是最终产物：不得再当成中间产物');
	assert.equal(first.notes.includes('single-step'), true);
	assert.equal(first.workflow.definitionName, 'GPT-Image-2');
	assert.equal(first.workflow.capability, 'text-to-image');
	assert.equal(first.workflow.definitionVersion, 38);
	assert.deepEqual(first.config, { aspect_ratio: '1:1', quality: 'low' }, 'config 必须来自本次 run 那一代 history');
	assert.deepEqual(first.steps.map((x) => [x.key, x.state]), [['target', 'done'], ['plan', 'done'], ['submit', 'done'], ['run', 'done'], ['assets', 'done']]);
	assert.deepEqual(first.steps.map((x) => x.at.slice(11, 19)), ['10:20:58', '10:24:00', '10:24:03', '10:24:03', '10:33:29']);
	assert.equal(Math.round(first.steps[3].durationMs), 15449, '工作流耗时取自 Run 事实（startedAt → endedAt）');
	assert.deepEqual([first.steps[4].count, first.steps[4].bytes], [1, 85667]);
	assert.equal(first.assets[0].id, 'a1');
	assert.equal(downloads.length, 0, '单步工作流不该为"中间产物"多下载一次');
	assert.equal(cliCalls > 0, true);

	const saved = store.getRun(store.loadState(), 'r1');
	assert.equal(saved.enriched, true);
	assert.equal(saved.definitionName, 'GPT-Image-2');
	assert.deepEqual(Object.keys(saved.timeline).sort(), ['plannedAt', 'submittedAt', 'targetAt']);
	assert.equal(saved.facts.id, 'wr-old');
	assert.equal(JSON.stringify(saved.facts).includes('https://'), false, '落盘的 facts 不留预签名 URL');

	cliCalls = 0;
	const second = await orch.runDetail('r1');
	assert.equal(cliCalls, 0, 'journal 齐全之后详情零 CLI');
	assert.deepEqual(second.steps.map((x) => x.state), first.steps.map((x) => x.state));
	assert.equal(second.config.quality, 'low');
}

// --- 9) 多输出工作流：没入库的 output 才是中间产物，按 coreNodeId 预览且不重复下载 -------------
{
	const FACTS = {
		id: 'wr-multi', status: 'completed', definitionId: 'def-1', definitionVersion: 7,
		startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:00:30.000Z',
		outputs: [
			{ coreNodeId: 'core-final', role: '', slotName: 'image_urls' },
			{ coreNodeId: 'core-mid', role: 'intermediate', slotName: 'latent_preview' },
			{ coreNodeId: 'core-final', role: '', slotName: 'image_urls' },
		],
		usage: { credits: { actual: 5, estimated: 5 } },
	};
	const base = fakeRunner({ ops: { getWorkflowRun: { outcome: 'succeeded', result: { workflowRun: FACTS } } } });
	const downloads = [];
	const orch = createOrchestrator({ runner: async (args) => { if (args[0] === 'canvas' && args[1] === 'download') downloads.push(args.slice(2)); return base(args); } });
	await rm(process.env.DSH_AZ8_STATE, { force: true });
	await store.mutate((s) => {
		store.appendRun(s, { id: 'r1', projectId: 'p1', projectName: 'p1', target: 'image', prompt: 'x', definitionId: 'def-1', definitionName: 'M', status: 'succeeded', viewNodeId: 'vn-1', workflowRunId: 'wr-multi', creditsEstimated: 5, creditsActual: 5, assets: ['a1'], startedAt: '', endedAt: '', error: null, confirm: null });
		store.appendAsset(s, { id: 'a1', runId: 'r1', projectId: 'p1', kind: 'image', filename: 'r1-a1.png', mime: 'image/png', bytes: 10, sha256: 'x', viewNodeId: '', coreNodeId: 'core-final', downloadedAt: '2026-11-20T10:01:00.000Z' });
	});
	const first = await orch.runDetail('r1');
	assert.deepEqual(first.intermediates.map((x) => [x.coreNodeId, x.slotName, x.role]), [['core-mid', 'latent_preview', 'intermediate']]);
	assert.equal(first.intermediates[0].url, '/_dsh/dsh-az8/cache?node=c_core-mid&ext=png');
	assert.equal(first.intermediates[0].kind, 'image');
	assert.deepEqual(first.outputs.map((o) => [o.coreNodeId, o.assetId]), [['core-final', 'a1']], '已入库的 output 进 outputs 并带 assetId，按 coreNodeId 去重');
	assert.equal(first.notes.includes('single-step'), false);
	assert.deepEqual(downloads[0].slice(0, 4), ['p1', '--core-node-id', 'core-mid', '--output'], '中间产物按 coreNodeId 下载');
	downloads.length = 0;
	const orch2 = createOrchestrator({ runner: async (args) => { if (args[0] === 'canvas' && args[1] === 'download') downloads.push(args.slice(2)); return base(args); } });
	const second = await orch2.runDetail('r1');
	assert.equal(second.intermediates[0].url, first.intermediates[0].url);
	assert.deepEqual(downloads, [], '磁盘已有预览缓存：不重复下载');
}

// --- 10) buildRunDetail 纯函数：各状态的步骤着色 + 引用血缘 + facts 瘦身 ------------------------
{
	const asset = (id, coreNodeId, viewNodeId = '') => ({ id, runId: 'r9', kind: 'image', filename: `${id}.png`, mime: 'image/png', bytes: 100, coreNodeId, viewNodeId, downloadedAt: '2026-11-20T10:01:00.000Z' });
	const base = { id: 'r9', projectId: 'p1', projectName: 'p1', target: 'image', prompt: 'p', definitionId: '', definitionName: '', status: 'succeeded', viewNodeId: 'vn-9', workflowRunId: 'wr-9', creditsEstimated: 6, creditsActual: 0, assets: ['a1'], error: null, confirm: null };
	const states = (run, facts, state) => buildRunDetail(run, facts, state).steps.map((x) => `${x.key}:${x.state}`).join(' ');
	const good = { status: 'completed', outputs: [{ coreNodeId: 'c1' }] };
	assert.equal(states(base, good, { runs: [base], assets: [asset('a1', 'c1')] }), 'target:done plan:done submit:done run:done assets:done');
	assert.equal(states({ ...base, assets: [] }, good, { runs: [], assets: [] }), 'target:done plan:done submit:done run:done assets:skipped');
	assert.equal(states({ ...base, status: 'running' }, null, { runs: [], assets: [] }), 'target:done plan:done submit:done run:active assets:skipped');
	assert.equal(states({ ...base, status: 'awaiting_confirm', workflowRunId: '', confirm: { estimate: 6 } }, null, { runs: [], assets: [] }), 'target:done plan:done submit:wait run:skipped assets:skipped');
	assert.equal(states({ ...base, status: 'failed', workflowRunId: '', creditsEstimated: null, error: { code: 'plan-blocking', message: 'boom' } }, null, { runs: [], assets: [] }), 'target:done plan:failed submit:skipped run:skipped assets:skipped');
	assert.equal(states({ ...base, status: 'failed', viewNodeId: '', creditsEstimated: null, error: { code: 'no-project', message: 'x' } }, null, { runs: [], assets: [] }), 'target:failed plan:skipped submit:skipped run:skipped assets:skipped');
	assert.equal(states({ ...base, status: 'indeterminate', workflowRunId: '', error: { code: 'x', message: 'transport lost' } }, null, { runs: [], assets: [] }), 'target:done plan:done submit:unknown run:skipped assets:skipped');
	assert.equal(states({ ...base, status: 'planning', workflowRunId: '', creditsEstimated: null }, null, { runs: [], assets: [] }), 'target:done plan:active submit:skipped run:skipped assets:skipped');
	assert.equal(states({ ...base, status: 'failed' }, { status: 'failed' }, { runs: [], assets: [] }), 'target:done plan:done submit:done run:failed assets:skipped');
	assert.equal(buildRunDetail({ ...base, status: 'failed', viewNodeId: '', workflowRunId: '', creditsEstimated: null }, null).workflow.note, 'not-planned');

	// 引用血缘：引用的 viewNode 是更早一条 run 的生成目标
	const upstream = { id: 'r4', viewNodeId: 'vn-4', assets: ['a4'] };
	const chained = buildRunDetail({ ...base, references: [{ viewNodeId: 'vn-4', slotName: 'first_frame_url' }] }, good, { runs: [base, upstream], assets: [asset('a1', 'c1'), asset('a4', 'c4', 'vn-4')] });
	assert.deepEqual(chained.inputs, [{ viewNodeId: 'vn-4', slotName: 'first_frame_url', upstreamRunId: 'r4', assetId: '' }]);

	// facts 瘦身：顶层白名单 + URL 抹除 + 超长截断
	const slim = scrubFacts({ id: 'wr', status: 'completed', inputs: { image_url: 'x' }, outputs: [], usage: { credits: { actual: 1 } }, error: { message: 'failed at https://cdn.example.com/a?sig=secret' }, accessToken: 'nope', note: 'z'.repeat(500) });
	assert.deepEqual(Object.keys(slim).sort(), ['error', 'id', 'outputs', 'status', 'usage']);
	assert.equal(slim.error.message, 'failed at [url]');
	assert.equal(scrubFacts('z'.repeat(500)).length, 401);

	// pickHistory 严格匹配
	const node = { history: [{ definitionId: 'd', runtime: { instanceIds: ['wr-other'] } }] };
	assert.equal(pickHistory(node, { workflowRunId: 'wr-9' }), undefined);
	assert.equal(pickHistory(node, { workflowRunId: 'wr-other' }), node.history[0]);
}

// --- 11) 新 run：生成时就把 detail/timeline/facts 落盘，runDetail 一次 CLI 都不调 ------------------
{
	const base = fakeRunner({ ops: GOOD_OPS });
	let cliCalls = 0;
	const orch = createOrchestrator({ runner: async (args) => { cliCalls++; return base(args); } });
	await rm(process.env.DSH_AZ8_STATE, { force: true });
	const done = await orch.generate({ prompt: '小图', target: 'image', projectId: 'p1', definitionId: 'def-1', maxCredits: 100 });
	assert.equal(done.status, 'succeeded');
	const saved = store.getRun(store.loadState(), done.id);
	assert.deepEqual(Object.keys(saved.timeline).sort(), ['plannedAt', 'submittedAt', 'targetAt']);
	assert.deepEqual(saved.references, []);
	assert.equal(saved.definitionName, 'GPT-Image-2 Pro', 'plan 不带模型名时从目录反查');
	assert.equal(typeof saved.detail, 'object');
	assert.equal(saved.facts !== null && saved.facts !== undefined, true, '终态事实随 run 落盘');
	cliCalls = 0;
	const detail = await orch.runDetail(done.id);
	assert.equal(cliCalls, 0, '新 run 的详情零 CLI');
	assert.equal(detail.steps.at(-1).state, 'done');
	assert.deepEqual(detail.inputs, []);
}

// --- 12) 余额不足：闸门提示要说"跑不了"，而不是"同意后继续" ---------------------------------
{
	const orch = await freshOrch({
		ops: { ...GOOD_OPS, planGeneration: { outcome: 'succeeded', result: planResult({ estimate: { credits: { total: 8, canAfford: false } } }) } },
	});
	const gated = await orch.generate({ prompt: 'x', target: 'image', projectId: 'p1' });
	assert.equal(gated.status, 'awaiting_confirm');
	assert.equal(gated.confirm.canAfford, false);
	assert.match(gated.hint, /余额不足/);
	assert.doesNotMatch(gated.hint, /同意后/);
	assert.equal(buildRunDetail(store.getRun(store.loadState(), gated.id), null).notes.includes('unaffordable'), true);
}

await rm(dir, { recursive: true, force: true });
console.log('orchestrator.test.mjs ✅ 全部通过（12 组）');
