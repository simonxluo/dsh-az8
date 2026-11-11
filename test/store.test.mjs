/**
 * store 单测：默认状态、水位线 id、journal 裁剪、settings 校验、原子写。
 * 运行：node test/store.test.mjs（用 DSH_AZ8_STATE 指到临时文件）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_AZ8_STATE = '';

const dir = await mkdtemp(join(tmpdir(), 'dsh-az8-store-'));
process.env.DSH_AZ8_STATE = join(dir, 'state.json');

const store = await import('../store.js');

// 1) 默认状态
const fresh = store.loadState();
assert.equal(fresh.schemaVersion, 1);
assert.equal(fresh.settings.maxAutoCredits, 30);
assert.deepEqual(fresh.runs, []);

// 2) 水位线 id：删除最大 id 后不复用
await store.mutate((s) => {
	store.appendRun(s, { id: store.nextRunId(s), status: 'resolving' }); // r1
	store.appendRun(s, { id: store.nextRunId(s), status: 'resolving' }); // r2
});
await store.mutate((s) => { s.runs = s.runs.filter((r) => r.id !== 'r2'); });
await store.mutate((s) => {
	const id = store.nextRunId(s);
	assert.equal(id, 'r3', 'id 水位线不应复用已删除的 r2');
	store.appendRun(s, { id, status: 'resolving' });
});
assert.equal(store.loadState().runs.length, 2);

// 3) settings 校验
await store.mutate((s) => { Object.assign(s.settings, store.settingsPatch({ maxAutoCredits: 100, panelPollMs: 2000 })); });
assert.equal(store.loadState().settings.maxAutoCredits, 100);
assert.throws(() => store.settingsPatch({ maxAutoCredits: -1 }));
assert.throws(() => store.settingsPatch({ waitTimeoutMs: 10 }));
assert.throws(() => store.settingsPatch({}));

// 4) journal 裁剪到 RUN_LIMIT
await store.mutate((s) => {
	for (let i = 0; i < store.RUN_LIMIT + 20; i++) {
		store.appendRun(s, { id: store.nextRunId(s), status: 'failed' });
	}
});
assert.equal(store.loadState().runs.length, store.RUN_LIMIT);

// 5) projectsCache
await store.mutate((s) => store.setProjectsCache(s, [{ id: 'p1', name: 'A', role: 'owner' }, { id: '', name: 'bad' }]));
assert.deepEqual(store.loadState().projectsCache.map((p) => p.id), ['p1']);

// 6) patchRun / getRun / getAsset
{
	const newest = store.loadState().runs[0].id;
	await store.mutate((s) => store.patchRun(s, newest, { status: 'succeeded' }));
	assert.equal(store.getRun(store.loadState(), newest).status, 'succeeded');
}
await assert.rejects(() => store.mutate((s) => store.patchRun(s, 'nope', {})));

await rm(dir, { recursive: true, force: true });
console.log('store.test.mjs ✅ 全部通过');
