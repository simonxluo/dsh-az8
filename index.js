/**
 * dsh-az8 — Cordis 插件入口（docs/design.md §7）。
 *
 * apply：注册 6 个 agent 工具（az8_status / az8_definitions / az8_generate /
 * az8_runs / az8_media / az8_skill），并挂面板与媒体路由（/_dsh/dsh-az8/*）。
 * jobs 是可选服务：有则 az8_generate 支持 mode:async 后台任务，没有自动降级 sync。
 * 数据落在 $DSH_HOME/integrations/dsh-az8/（state.json 0600、assets/、skills/）。
 */
import Schema from '@deepseek-ai/schemastery';
import { buildTools } from './tools.js';
import { createOrchestrator } from './orchestrator.js';
import { installPanelWeb } from './panel.js';
import { setPaths } from './store.js';

export const inject = ['tools'];

export const Config = Schema.object({
	cliBin: Schema.string().default('az8').description(
		'az8 CLI 可执行文件名或绝对路径（默认走 PATH）。'
	).volatile(),
	stateFile: Schema.string().default('').description(
		'state.json 绝对路径。空 = $DSH_HOME/integrations/dsh-az8/state.json；'
		+ '可指到同步目录让运行日志/资产索引跨机同步（媒体文件在 assetsDir，另行同步）。'
	).volatile(),
	assetsDir: Schema.string().default('').description(
		'产物落盘目录。空 = $DSH_HOME/integrations/dsh-az8/assets。可指到大容量盘。'
	).volatile(),
	skillsDir: Schema.string().default('').description(
		'技能包根目录。空 = $DSH_HOME/integrations/dsh-az8/skills。可指到 git 仓库做版本管理。'
	).volatile(),
});

export function apply(ctx, rowConfig) {
	const cfg = rowConfig ?? {};
	setPaths(cfg);
	let jobs;
	try { jobs = ctx.get('jobs'); } catch { jobs = undefined; }
	// 类型防御：配置层过来的值可能不是字符串（曾导致宿主 fatal）——统一回退。
	const cliBinRaw = cfg.cliBin;
	const cliBin = typeof cliBinRaw === 'string' && cliBinRaw.trim() !== '' ? cliBinRaw.trim() : 'az8';
	const orch = createOrchestrator({
		cliBin,
		logger: ctx.logger,
		jobs,
	});
	for (const definition of buildTools(orch)) {
		ctx.effect(() => ctx.tools.register(definition));
	}
	installPanelWeb(ctx, orch, () => orch.status());
}
