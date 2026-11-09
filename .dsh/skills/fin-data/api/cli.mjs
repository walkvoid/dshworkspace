#!/usr/bin/env node
/**
 * fin-data 查询入口的命令行外壳。
 *
 * 与 `api/index.mjs` 是**同一个门面**，只是给 agent、shell 脚本和非 JS 消费方用：
 *
 *   node .dsh/skills/fin-data/api/cli.mjs describe
 *   node .dsh/skills/fin-data/api/cli.mjs status
 *   node .dsh/skills/fin-data/api/cli.mjs query --kind quote --code 600519
 *   node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --periods 4
 *   node .dsh/skills/fin-data/api/cli.mjs query --kind financials --code 600519 --source mock
 *   node .dsh/skills/fin-data/api/cli.mjs query --kind bars --code 600519 --source local --limit 120
 *
 * 输出：单个 JSON 到 stdout。退出码：0 = ok；2 = 信封 ok:false；1 = 参数/异常。
 */

import { describe, query } from './index.mjs';

function usage() {
  process.stdout.write(
    [
      'fin-data api — 统一取数入口的命令行外壳',
      '',
      '  node api/cli.mjs describe',
      '  node api/cli.mjs status',
      '  node api/cli.mjs query --kind <kind> [--code <标的>] [--q <名称>] [--pair <HKDCNY>]',
      '                          [--periods n] [--limit n] [--id sse50|hk-connect]',
      '                          [--source live|local|auto|real|mock]',
      '',
      `kind：status / quote / bars / financials / dividends / annual / universe / fx / search / announcements`,
      '',
      '示例：',
      '  node api/cli.mjs query --kind financials --code 600519 --periods 4',
      '  node api/cli.mjs query --kind bars --code 600519 --source local --limit 120',
      '  node api/cli.mjs query --kind universe --id sse50',
      '',
    ].join('\n'),
  );
}

/** 收集 `--key value` 形式的参数。 */
function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = 'true';
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? '', options };
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === '' || command === 'help' || options.help !== undefined) {
    usage();
    return command === '' ? 1 : 0;
  }
  if (command === 'describe') {
    print(describe());
    return 0;
  }
  if (command === 'status') {
    const result = await query({ kind: 'status' });
    print(result);
    return result.ok === true ? 0 : 2;
  }
  if (command !== 'query') {
    usage();
    return 1;
  }

  const kind = options.kind;
  if (kind === undefined || kind === 'true') {
    process.stderr.write('缺少 --kind\n');
    return 1;
  }
  const request = { kind };
  if (options.code !== undefined) request.instrument = options.code;
  if (options.q !== undefined) request.query = options.q;
  if (options.pair !== undefined) request.pair = options.pair;
  const financialsSource = options['source'] ?? undefined;
  const isFinancials = kind === 'financials';
  const optionsOut = {};
  if (options.periods !== undefined) optionsOut.periods = Number(options.periods);
  if (options.limit !== undefined) optionsOut.limit = Number(options.limit);
  if (options.start !== undefined) optionsOut.start = options.start;
  if (options.end !== undefined) optionsOut.end = options.end;
  if (options.id !== undefined) optionsOut.id = options.id;
  if (financialsSource !== undefined) optionsOut.source = financialsSource;
  if (isFinancials && financialsSource === undefined) optionsOut.source = 'auto';
  request.options = optionsOut;

  const result = await query(request);
  print(result);
  return result.ok === true ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    print({
      ok: false,
      code: error instanceof Error && typeof error.code === 'string' ? error.code : 'internal',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  },
);
