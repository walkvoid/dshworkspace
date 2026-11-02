import { apply, ROUTE_PATH, parseSnapshot } from '../index.js';

let registered;
const ctx = {
  effect(fn) {
    return fn();
  },
  webServer: {
    register(route) {
      registered = route;
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
};

let forwarded = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  forwarded += 1;
  return realFetch(...args);
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
  const req = { method, url: `${ROUTE_PATH}${query}`, headers: {} };
  await registered.handler(req, res);
  if (res.headers['content-type'] === undefined) return res;
  return { ...res, json: JSON.parse(res.body) };
};

const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('ok  -', message);
  }
};

console.log('route:', registered.kind, registered.path);

const first = await call('?codes=sh000001,sz399001,sh600519,sz000001&daily=sh600519');
assert(first.statusCode === 200, 'GET returns 200');
assert(first.json.ok === true, 'ok true on a healthy upstream');
assert(first.json.stale === false, 'stale false on a healthy upstream');
assert(first.json.quotes.length === 4, `four quotes (got ${first.json.quotes.length})`);
assert(first.json.quotes.some((quote) => quote.code === 'sh600519' && typeof quote.price === 'number'), 'watchlist price parsed');
assert(first.json.quotes.some((quote) => quote.code === 'sh000001' && quote.name.length > 0), 'index name parsed');
assert(first.json.daily?.code === 'sh600519' && first.json.daily.bars.length > 60, `daily bars served (${first.json.daily?.bars?.length})`);
assert(first.json.daily?.stale === false, 'daily fresh');
const forwardedAfterFirst = forwarded;
const second = await call('?codes=sh000001,sz399001,sh600519,sz000001&daily=sh600519');
assert(second.json.fetchedAt === first.json.fetchedAt, '10 s snapshot cache served a repeated request');
assert(forwarded === forwardedAfterFirst, 'cache hit performs no upstream call');

const bad = await call('?codes=bogus');
assert(bad.statusCode === 400, 'invalid codes rejected with 400');

const post = await call('?codes=sh600519', 'POST');
assert(post.statusCode === 405, 'non-GET rejected with 405');

await call('?codes=sh600519', 'GET', 401);
const fenced = await call('?codes=sh600519', 'GET', 403);
assert(fenced.statusCode === 403 && fenced.body === '', 'connection rejection short-circuits the route');

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const healthy = await call('?codes=sh000001,sz399001,sh600519,sz000001&daily=sh600519');
assert(healthy.json.stale === false, 'fresh fetch before the failure');

clock += 11_000;
globalThis.fetch = () => Promise.reject(new Error('offline'));
const degraded = await call('?codes=sh000001,sz399001,sh600519,sz000001&daily=sh600519');
assert(degraded.statusCode === 200, 'degraded snapshot still answers 200');
assert(degraded.json.stale === true, 'degraded snapshot is marked stale');
assert(degraded.json.quotes.length === 4, 'degraded snapshot returns the last cached quotes');
assert(typeof degraded.json.error === 'string' && degraded.json.error.includes('offline'), 'degraded snapshot carries the upstream error');

clock += 301_000;
const staleDaily = await call('?codes=sh000001,sz399001,sh600519,sz000001&daily=sh600519');
assert(staleDaily.json.daily?.stale === true, 'daily series marked stale after 5 min of failures');
assert((staleDaily.json.daily?.bars?.length ?? 0) > 60, 'daily series falls back to cached bars');

globalThis.fetch = () => Promise.reject(new Error('offline forever'));
clock += 400_000;
const noCache = await call('?codes=sh601318&daily=sh601318');
assert(noCache.statusCode === 200, 'cold cache failure answers 200');
assert(noCache.json.ok === false && noCache.json.quotes.length === 0, 'cold cache failure reports ok:false with no quotes');
assert(noCache.json.daily?.stale === true && noCache.json.daily.bars.length === 0, 'cold daily failure reports stale with no bars');

Date.now = realNow;
globalThis.fetch = realFetch;

console.log(process.exitCode === 1 ? 'RESULT: failures' : 'RESULT: all checks passed');
