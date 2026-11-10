import { createRuntime } from './runtime.js';
import { stateRoute, storeRoute } from './routes.js';

export { Config } from './config.js';
export const inject = ['credentials', 'sessionController', 'workspaceRegistry', 'connection'];

export function apply(ctx, config) {
  const log = ctx.logger?.('wecom-ai-bot') ?? console;
  const journal = {
    write(record) {
      const level = record?.level ?? 'info';
      if (level === 'error' || level === 'warn') log.warn?.(JSON.stringify(record));
      else log.debug?.(JSON.stringify(record));
    },
  };
  ctx.effect(async () => {
    let runtime;
    runtime = createRuntime({ ctx, config, log, journal });
    const removeState = ctx.connection.fetch.register(stateRoute(runtime));
    const removeStore = ctx.connection.fetch.register(storeRoute(runtime));
    try {
      await runtime.start();
    } catch (error) {
      log.error('WeCom AI bot setup failed');
      journal.write({ event: 'bridge.error', level: 'error', stage: 'start', error });
    }
    journal.write({ event: 'plugin.start', pid: process.pid, node: process.version });
    return async () => {
      await runtime?.stop();
      await removeState();
      await removeStore();
      journal.write({ event: 'plugin.stop' });
    };
  });
}
