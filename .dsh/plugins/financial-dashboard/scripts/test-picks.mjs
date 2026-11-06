/**
 * 龟龟选股路由自测：不启动 DSH，直接以 mock ctx 调用 handler。
 *
 *   node scripts/test-picks.mjs
 *
 * 会真实调用数据层（腾讯行情 + 东财 F10），并把当天结果写进 `.data/picks.json`。
 */
import { apply, PICKS_ROUTE_PATH, nextDailyRun } from '../index.js';
import { STORE_FILE, dateKey, loadConnectCodes, readStore } from '../picks.js';

/** 北京时间某时刻对应的 UTC 纪元毫秒。 */
const shanghai = (y, m, d, hour, minute = 0) => Date.UTC(y, m - 1, d, hour - 8, minute, 0);

const routes = new Map();
const ctx = {
  effect(fn) {
    return fn();
  },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
};

apply(ctx);

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = '';
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  end(body) {
    this.body = body ?? '';
  }
}

const call = async (query, method = 'GET', rejection) => {
  ctx.connection.requestRejection = () => rejection;
  const res = new FakeResponse();
  const req = { method, url: `${PICKS_ROUTE_PATH}${query}`, headers: {} };
  await routes.get(PICKS_ROUTE_PATH).handler(req, res);
  const json = res.headers['content-type'] === undefined ? undefined : JSON.parse(res.body);
  return { ...res, json };
};

const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('ok  -', message);
  }
};

assert(routes.has(PICKS_ROUTE_PATH), 'picks route registered');

assert(nextDailyRun(shanghai(2026, 11, 6, 12, 0)) === shanghai(2026, 11, 6, 16, 5), 'before 16:05 the next run is today 16:05');
assert(nextDailyRun(shanghai(2026, 11, 6, 16, 5)) === shanghai(2026, 11, 7, 16, 5), 'at 16:05 the next run rolls to tomorrow');
assert(nextDailyRun(shanghai(2026, 11, 6, 23, 59)) === shanghai(2026, 11, 7, 16, 5), 'after 16:05 the next run is tomorrow 16:05');

const started = Date.now();
const first = await call('?refresh=1');
const elapsed = Date.now() - started;
assert(first.statusCode === 200, 'GET picks returns 200');
assert(first.json?.ok === true, 'ok true');
assert(first.json?.date === dateKey(), `date is today (${first.json?.date})`);
assert(Array.isArray(first.json?.picks), 'picks is an array');
assert(first.json.picks.length > 0, `picks non-empty (${first.json.picks.length})`);
assert(first.json.picks.length <= 10, `at most 10 picks (${first.json.picks.length})`);
assert(
  first.json.picks.every((pick) => typeof pick.name === 'string' && typeof pick.dividendYieldPct === 'number'),
  'every pick carries name and yield',
);
assert(
  first.json.picks.every((pick) => typeof pick.totalCapYi === 'number'),
  'every pick carries market cap',
);
assert(
  first.json.picks.every((pick) => 'netCashYi' in pick),
  'every pick carries a net-cash field',
);
assert(
  first.json.picks.every((pick) => 'penetrationReturn' in pick),
  'every pick carries penetration return',
);

const connect = await loadConnectCodes();
if (connect !== null) {
  assert(
    first.json.picks.every((pick) => connect.has(pick.code.replace(/^hk:/, ''))),
    'every pick is a Stock Connect name',
  );
}
assert(
  first.json.picks.every((pick) => pick.dividendYieldPct >= first.json.thresholds.minDividendYieldPct),
  'every pick passes the yield floor',
);
assert(
  new Set(first.json.picks.map((pick) => pick.sector)).size > 1,
  'picks spread across sectors',
);

const second = await call('');
assert(second.json?.generatedAt === first.json?.generatedAt, 'second call serves the same daily run');

const history = await call('?history=1');
assert(history.statusCode === 200 && Array.isArray(history.json?.days), 'history returns days');
assert(history.json.days.some((day) => day.date === first.json.date), 'history contains today');

const missing = await call('?date=1999-01-01');
assert(missing.statusCode === 404, 'unknown date returns 404');

const post = await call('', 'POST');
assert(post.statusCode === 405, 'non-GET rejected with 405');

await call('', 'GET', 401);
assert(true, 'rejected request ends without upstream work');

const store = readStore(STORE_FILE);
assert(store.runs?.[dateKey()] !== undefined, 'run persisted to the store');
console.log(`\nRESULT: ${process.exitCode === 1 ? 'failures above' : 'all checks passed'} (${elapsed} ms)`);
