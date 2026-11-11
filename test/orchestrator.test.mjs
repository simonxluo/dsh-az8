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

const { createOrchestrator } = await import('../orchestrator.js');
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
				json: { absolutePath: output, bytes: 16, mime: 'image/png', sha256: 'abc', coreNodeId: 'cn-1' },
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

await rm(dir, { recursive: true, force: true });
console.log('orchestrator.test.mjs ✅ 全部通过');
