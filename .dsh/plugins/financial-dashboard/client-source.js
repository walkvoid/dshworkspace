window.__ModuleLoader__.load({
  id: '@local/financial-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*__ECHARTS_BUNDLE__*/

    /** Tab-type kind the right sidebar dispatches by. */
    const KIND = 'financial-dashboard';
    /** This implementation's identity in the tab system; also the body/title slot key. */
    const TYPE_ID = '@local/financial-dashboard';
    /** The left-sidebar panel id; addresses both the nav row and the `main` panel. */
    const PANEL_ID = 'financial-dashboard';
    /** Copy namespace. */
    const NS = 'financial-dashboard';
    /** Host route serving snapshots and daily bars. */
    const ROUTE = '/financial-dashboard/quotes';
    /** Host route serving today's turtle picks and the history list. */
    const PICKS_ROUTE = '/financial-dashboard/picks';
    /** 全看板每天只在 16:05（港股收盘后）拉一次数据。 */
    const DAILY_HOUR = 16;
    /** 宿主 16:05 跑，页面晚一分钟再读。 */
    const DAILY_MINUTE = 6;
    /** Index cards. */
    const INDEX_CODES = ['sh000001', 'sz399001'];
    /** Watchlist rows. */
    const WATCH_CODES = ['sh600519', 'sz000001'];
    /** Everything one poll asks the Host for. */
    const ALL_CODES = [...INDEX_CODES, ...WATCH_CODES];
    /** Page sub-tabs. */
    const SUBTAB_QUOTES = 'quotes';
    const SUBTAB_PICKS = 'picks';
    /** localStorage key for the up/down colour preference. */
    const UP_DOWN_KEY = 'financial-dashboard.up-down-colors';

    const zh = {
      'tab.title': '金融看板',
      'panel.label': '金融看板',
      'page.subtitle': '指数与自选股行情，每天 16:05 更新',
      'guide.title': '金融看板',
      'guide.description': '行情 · 指数与自选股，每天 16:05 更新',
      'subtab.quotes': '行情',
      'subtab.picks': '龟龟选股',
      'picks.subtitle': '按龟龟法则每天 16:05 在港股挑 10 只：高股息、低估值、派息可持续、负债可控',
      'picks.rule': '门槛：股息率 ≥ 4.5% · PE ≤ 12 · 派息率 ≤ 95% · 负债率 ≤ 75% · 每行业最多 3 只；银行与融资租赁整类回避（他说负债表看不清楚）',
      'picks.today': '今日',
      'picks.generated': '生成于 {time}',
      'picks.count': '共 {n} 只',
      'picks.avgYield': '平均股息 {n}%',
      'picks.history': '历史选股',
      'picks.historyTitle': '历史选股记录',
      'picks.historyEmpty': '还没有历史记录',
      'picks.historyLoading': '正在读取历史…',
      'picks.back': '返回今天',
      'picks.refresh': '重新选股',
      'picks.loading': '正在选股…',
      'picks.error': '选股失败',
      'picks.empty': '今天还没有选出标的',
      'picks.retry': '重试',
      'picks.close': '关闭',
      'picks.yield': '股息率',
      'picks.pe': 'PE',
      'picks.pb': 'PB',
      'picks.payout': '派息',
      'picks.debt': '负债',
      'picks.score': '得分',
      'picks.note': '这是收息层粗筛，不是三因子完整分析；不构成投资建议。',
      'picks.historical': '历史记录',
      'picks.carried': '今天 16:05 还没到，先展示 {date} 的结果',
      'action.refresh': '刷新',
      'action.colors.redUp': '红涨绿跌',
      'action.colors.greenUp': '绿涨红跌',
      'state.loading': '正在加载行情…',
      'state.emptyTitle': '行情暂时不可用',
      'state.emptyHint': '请检查网络连接后重试。',
      'state.retry': '重试',
      'state.stale': '上游暂不可用，正在显示缓存数据',
      'state.offline': '连接中断，正在显示上次成功的数据',
      'state.updated': '更新于 {time}',
      'state.auto': '每天 16:05 更新',
      'state.closed': '未开盘',
      'chart.title': '日线 · 近 120 个交易日',
      'chart.empty': '暂无日线数据',
      'chart.loading': '正在加载日线…',
      'metric.amount': '成交额',
      'metric.turnover': '换手',
      'metric.pe': '市盈率',
      'metric.totalCap': '总市值',
      'watchlist.title': '自选股',
      'watchlist.hint': '点击一行查看日线',
    };

    const en = {
      'tab.title': 'Financial Dashboard',
      'panel.label': 'Financial Dashboard',
      'page.subtitle': 'Index and watchlist quotes, updated daily at 16:05',
      'guide.title': 'Financial Dashboard',
      'guide.description': 'Quotes · indices and watchlist, updated daily at 16:05',
      'subtab.quotes': 'Quotes',
      'subtab.picks': 'Turtle Picks',
      'picks.subtitle': 'Ten Hong Kong names a day at 16:05, screened the turtle way: yield, valuation, payout cover, debt',
      'picks.rule': 'Rules: yield ≥ 4.5% · PE ≤ 12 · payout ≤ 95% · debt ≤ 75% · max 3 per sector; banks and leasing are excluded (he finds their balance sheets unreadable)',
      'picks.today': 'Today',
      'picks.generated': 'Generated {time}',
      'picks.count': '{n} names',
      'picks.avgYield': 'Avg yield {n}%',
      'picks.history': 'History',
      'picks.historyTitle': 'Past picks',
      'picks.historyEmpty': 'No history yet',
      'picks.historyLoading': 'Loading history…',
      'picks.back': 'Back to today',
      'picks.refresh': 'Rescreen',
      'picks.loading': 'Screening…',
      'picks.error': 'Screening failed',
      'picks.empty': 'No names passed the screen today',
      'picks.retry': 'Retry',
      'picks.close': 'Close',
      'picks.yield': 'Yield',
      'picks.pe': 'PE',
      'picks.pb': 'PB',
      'picks.payout': 'Payout',
      'picks.debt': 'Debt',
      'picks.score': 'Score',
      'picks.note': 'A cash-flow screen, not a full three-factor review. Not investment advice.',
      'picks.historical': 'History',
      'picks.carried': 'Today’s 16:05 run hasn’t happened yet — showing {date}',
      'action.refresh': 'Refresh',
      'action.colors.redUp': 'Red up / green down',
      'action.colors.greenUp': 'Green up / red down',
      'state.loading': 'Loading quotes…',
      'state.emptyTitle': 'Quotes are unavailable',
      'state.emptyHint': 'Check the network connection and try again.',
      'state.retry': 'Retry',
      'state.stale': 'Upstream unavailable — showing cached data',
      'state.offline': 'Connection lost — showing the last successful data',
      'state.updated': 'Updated {time}',
      'state.auto': 'Updates daily at 16:05',
      'state.closed': 'Market closed',
      'chart.title': 'Daily · last 120 sessions',
      'chart.empty': 'No daily data',
      'chart.loading': 'Loading daily bars…',
      'metric.amount': 'Turnover',
      'metric.turnover': 'Float',
      'metric.pe': 'P/E',
      'metric.totalCap': 'Market cap',
      'watchlist.title': 'Watchlist',
      'watchlist.hint': 'Select a row to chart its daily bars',
    };

    /** Candlestick mark used by the tab chip, the guide card and the empty state. */
    function CandleGlyph({ size = 16, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          className,
        },
        h('path', { key: 'w1', d: 'M4 3v10', stroke: 'currentColor', strokeLinecap: 'round' }),
        h('rect', { key: 'b1', x: 2.5, y: 5, width: 3, height: 6, rx: 0.75, stroke: 'currentColor' }),
        h('path', { key: 'w2', d: 'M11 2v12', stroke: 'currentColor', strokeLinecap: 'round' }),
        h('rect', { key: 'b2', x: 9.5, y: 6, width: 3, height: 6, rx: 0.75, stroke: 'currentColor' }),
      );
    }

    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function formatPrice(value) {
      return finite(value) ? value.toFixed(2) : '—';
    }

    function formatSigned(value, digits = 2) {
      if (!finite(value)) return '—';
      return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
    }

    function formatPercent(value) {
      if (!finite(value)) return '—';
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
    }

    /** 成交额 arrives in 万元; show a compact yuan-scaled figure. */
    function formatAmount(tenThousandYuan) {
      if (!finite(tenThousandYuan)) return '—';
      const yuan = tenThousandYuan * 10000;
      if (Math.abs(yuan) >= 1e12) return `${(yuan / 1e12).toFixed(2)}万亿`;
      if (Math.abs(yuan) >= 1e8) return `${(yuan / 1e8).toFixed(2)}亿`;
      if (Math.abs(yuan) >= 1e4) return `${(yuan / 1e4).toFixed(2)}万`;
      return yuan.toFixed(0);
    }

    /** 总市值 arrives in 亿元. */
    function formatCap(hundredMillionYuan) {
      if (!finite(hundredMillionYuan)) return '—';
      if (Math.abs(hundredMillionYuan) >= 1e4) return `${(hundredMillionYuan / 1e4).toFixed(2)}万亿`;
      return `${hundredMillionYuan.toFixed(1)}亿`;
    }

    function formatTime(epochMs) {
      if (!finite(epochMs)) return '—';
      const date = new Date(epochMs);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** The feed's timestamp is `YYYYMMDDhhmmss` local exchange time. */
    function formatFeedTime(raw) {
      if (typeof raw !== 'string' || raw.length < 14) return '—';
      return `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
    }

    function readUpDownPreference() {
      try {
        return window.localStorage.getItem(UP_DOWN_KEY) === 'greenUp' ? 'greenUp' : 'redUp';
      } catch {
        return 'redUp';
      }
    }

    function writeUpDownPreference(value) {
      try {
        window.localStorage.setItem(UP_DOWN_KEY, value);
      } catch {
        /* Storage can be unavailable in hardened contexts; the choice stays in memory. */
      }
    }

    /** Tone class for one signed number under the current colour convention. */
    function toneClass(value, preference) {
      if (!finite(value) || value === 0) return 'fnd-flat';
      const rising = value > 0;
      const redIsUp = preference !== 'greenUp';
      return rising === redIsUp ? 'fnd-up' : 'fnd-down';
    }

    function readToken(element, name, fallback) {
      const value = getComputedStyle(element).getPropertyValue(name).trim();
      return value === '' ? fallback : value;
    }

    /* ------------------------------------------------------------------ */
    /*                            data fetching                            */
    /* ------------------------------------------------------------------ */

    /** One poll: snapshot quotes for every code plus the selected daily series. */
    function useQuotes(dailyCode, visible) {
      const key = ALL_CODES.join(',');
      const [state, setState] = React.useState({ data: null, error: null, loading: true });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        if (!visible) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState((prev) => (prev.data === null ? { ...prev, loading: true } : prev));

        const run = async () => {
          const search = new URLSearchParams({ codes: key });
          if (typeof dailyCode === 'string' && dailyCode !== '') search.set('daily', dailyCode);
          try {
            const response = await fetch(`${ROUTE}?${search.toString()}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (cancelled) return;
            if (body === null || typeof body !== 'object' || body.ok === false) {
              const message = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : 'upstream unavailable';
              setState((prev) => ({ data: prev.data, error: message, loading: false }));
              return;
            }
            setState({ data: body, error: null, loading: false });
          } catch (error) {
            if (cancelled || controller.signal.aborted) return;
            setState((prev) => ({
              ...prev,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        };

        void run();
        // 不再轮询：只在下一个 16:06 自动刷新一次（给宿主 16:05 的拉数据留一分钟）。
        const now = new Date();
        const next = new Date(now);
        next.setHours(DAILY_HOUR, DAILY_MINUTE, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        const timer = window.setTimeout(() => {
          setNonce((value) => value + 1);
        }, next.getTime() - now.getTime());
        return () => {
          cancelled = true;
          controller.abort();
          window.clearTimeout(timer);
        };
      }, [key, dailyCode, visible, nonce]);

      const refresh = React.useCallback(() => {
        setNonce((value) => value + 1);
      }, []);

      return { data: state.data, error: state.error, loading: state.loading, refresh };
    }

    /* ------------------------------------------------------------------ */
    /*                               pieces                                */
    /* ------------------------------------------------------------------ */

    function IndexCard({ quote, preference, t }) {
      const change = quote?.change;
      const tone = toneClass(change, preference);
      return h(
        'article',
        { className: 'fnd-card fnd-index-card' },
        h(
          'header',
          { className: 'fnd-card-head' },
          h('span', { className: 'fnd-card-name', title: quote?.name ?? '' }, quote?.name ?? '—'),
          h('span', { className: 'fnd-card-code' }, quote?.code ?? ''),
        ),
        h('div', { className: `fnd-card-price ${tone}` }, formatPrice(quote?.price)),
        h(
          'div',
          { className: `fnd-card-delta ${tone}` },
          `${formatSigned(change)} ${formatPercent(quote?.changePct)}`,
        ),
        h(
          'div',
          { className: 'fnd-card-meta' },
          h('span', null, `${t('metric.amount')} ${formatAmount(quote?.amount)}`),
          h('span', null, `${t('state.updated')} ${formatFeedTime(quote?.time)}`),
        ),
      );
    }

    function WatchRow({ quote, selected, preference, onSelect }) {
      const tone = toneClass(quote?.change, preference);
      const details = [
        `${quote?.name ?? ''} ${quote?.code ?? ''}`,
        `成交额 ${formatAmount(quote?.amount)}`,
        `换手 ${finite(quote?.turnover) ? `${quote.turnover.toFixed(2)}%` : '—'}`,
        `市盈率 ${formatPrice(quote?.pe)}`,
        `总市值 ${formatCap(quote?.totalCap)}`,
      ].join('\n');
      return h(
        'button',
        {
          type: 'button',
          className: `fnd-row${selected ? ' is-selected' : ''}`,
          'aria-pressed': selected ? 'true' : 'false',
          title: details,
          onClick: () => onSelect(quote?.code),
        },
        h(
          'span',
          { className: 'fnd-row-ident' },
          h('span', { className: 'fnd-row-name' }, quote?.name ?? '—'),
          h('span', { className: 'fnd-row-code' }, quote?.code ?? ''),
        ),
        h('span', { className: 'fnd-row-price' }, formatPrice(quote?.price)),
        h('span', { className: `fnd-row-delta ${tone}` }, formatPercent(quote?.changePct)),
      );
    }

    /** ECharts candlestick host: owns one chart instance for the component lifetime. */
    function DailyChart({ bars, preference, themeRevision, t, tall }) {
      const hostRef = React.useRef(null);
      const chartRef = React.useRef(null);

      React.useEffect(() => {
        const element = hostRef.current;
        if (element === null) return undefined;
        const chart = echarts.init(element, null, { renderer: 'canvas' });
        chartRef.current = chart;
        let observer;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(() => {
            chart.resize();
          });
          observer.observe(element);
        }
        return () => {
          observer?.disconnect();
          chart.dispose();
          chartRef.current = null;
        };
      }, []);

      React.useEffect(() => {
        const chart = chartRef.current;
        const element = hostRef.current;
        if (chart === null || element === null) return;
        chart.setOption(buildChartOption(element, bars, preference, t), true);
      }, [bars, preference, themeRevision, t]);

      return h(
        'div',
        { className: tall ? 'fnd-chart is-tall' : 'fnd-chart', ref: hostRef, role: 'img', 'aria-label': t('chart.title') },
        bars.length === 0 ? h('span', { className: 'fnd-chart-empty' }, t('chart.empty')) : null,
      );
    }

    function buildChartOption(element, bars, preference, t) {
      const red = readToken(element, '--dsw-alias-state-error-primary', '#d9544f');
      const green = readToken(element, '--dsw-alias-state-success-primary', '#2f9e63');
      const label = readToken(element, '--dsw-alias-label-secondary', '#6b7280');
      const primary = readToken(element, '--dsw-alias-label-primary', '#111827');
      const line = readToken(element, '--dsw-alias-border-l1', '#e5e7eb');
      const surface = readToken(element, '--dsw-alias-bg-overlay', '#ffffff');
      const redIsUp = preference !== 'greenUp';
      const up = redIsUp ? red : green;
      const down = redIsUp ? green : red;

      return {
        animation: false,
        grid: { left: 2, right: 6, top: 8, bottom: 2, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: line, color: primary } },
          backgroundColor: surface,
          borderColor: line,
          borderWidth: 0.5,
          padding: [6, 8],
          textStyle: { color: primary, fontSize: 11 },
          formatter: (params) => {
            const first = Array.isArray(params) ? params[0] : params;
            const bar = bars[first?.dataIndex ?? -1];
            if (bar === undefined) return '';
            return [
              `<div style="font-size:11px;color:${label};margin-bottom:2px">${bar[0]}</div>`,
              `<div>开 ${bar[1].toFixed(2)}　收 ${bar[2].toFixed(2)}</div>`,
              `<div>高 ${bar[3].toFixed(2)}　低 ${bar[4].toFixed(2)}</div>`,
            ].join('');
          },
        },
        xAxis: {
          type: 'category',
          data: bars.map((bar) => bar[0]),
          boundaryGap: true,
          axisLine: { lineStyle: { color: line } },
          axisTick: { show: false },
          axisLabel: { color: label, fontSize: 10, hideOverlap: true, formatter: (value) => String(value).slice(5) },
        },
        yAxis: {
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: line, opacity: 0.6 } },
          axisLabel: { color: label, fontSize: 10 },
        },
        series: [
          {
            name: t('chart.title'),
            type: 'candlestick',
            data: bars.map((bar) => [bar[1], bar[2], bar[4], bar[3]]),
            itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
            barMaxWidth: 7,
          },
        ],
      };
    }

    function EmptyState({ t, onRetry, loading }) {
      return h(
        'div',
        { className: 'fnd-empty' },
        h(CandleGlyph, { size: 40, className: 'fnd-empty-glyph' }),
        h('div', { className: 'fnd-empty-title' }, loading ? t('state.loading') : t('state.emptyTitle')),
        loading ? null : h('div', { className: 'fnd-empty-hint' }, t('state.emptyHint')),
        loading
          ? null
          : h(
              'button',
              { type: 'button', className: 'fnd-button', onClick: onRetry },
              h(RefreshGlyph, { size: 12 }),
              h('span', null, t('state.retry')),
            ),
      );
    }

    function RefreshGlyph({ size = 12 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 3.2V6h-2.8',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** One sub-tab strip shared by the compact tab body and the full-width page. */
    function SubTabs({ tabs, active, onSelect, variant, label }) {
      const isPage = variant === 'page';
      return h(
        'div',
        { className: isPage ? 'fnd-page-tabs' : 'fnd-subtabs', role: 'tablist', 'aria-label': label },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              'aria-selected': tab.id === active ? 'true' : 'false',
              className: `${isPage ? 'fnd-page-tab' : 'fnd-subtab'}${tab.id === active ? ' is-active' : ''}`,
              onClick: () => onSelect(tab.id),
            },
            tab.label,
          ),
        ),
      );
    }

    /** One request for today's picks (or one historical date). */
    function usePicks(visible, date) {
      const [state, setState] = React.useState({ data: null, error: null, loading: true });
      const [nonce, setNonce] = React.useState(0);
      React.useEffect(() => {
        if (!visible) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState((prev) => ({ ...prev, loading: true }));
        const load = async () => {
          const search = new URLSearchParams();
          if (typeof date === 'string' && date !== '') search.set('date', date);
          else if (nonce > 0) search.set('refresh', '1');
          const query = search.toString();
          try {
            const response = await fetch(query === '' ? PICKS_ROUTE : `${PICKS_ROUTE}?${query}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            const body = await response.json().catch(() => null);
            if (cancelled) return;
            if (!response.ok || body === null || body.ok === false) {
              throw new Error(body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
            }
            setState({ data: body, error: null, loading: false });
          } catch (error) {
            if (cancelled || error.name === 'AbortError') return;
            setState((prev) => ({ data: prev.data, error: error.message, loading: false }));
          }
        };
        load();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [visible, date, nonce]);
      return { ...state, refresh: () => setNonce((value) => value + 1) };
    }

    /** The history list, fetched only while the sheet is open. */
    function usePickHistory(open) {
      const [state, setState] = React.useState({ days: null, loading: false, error: null });
      React.useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState((prev) => ({ ...prev, loading: true }));
        fetch(`${PICKS_ROUTE}?history=1`, { signal: controller.signal, headers: { accept: 'application/json' }, cache: 'no-store' })
          .then((response) => response.json().then((body) => ({ response, body })))
          .then(({ response, body }) => {
            if (cancelled) return;
            if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`);
            setState({ days: Array.isArray(body.days) ? body.days : [], loading: false, error: null });
          })
          .catch((error) => {
            if (!cancelled) setState({ days: null, loading: false, error: error.message });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [open]);
      return state;
    }

    /** One stock in the daily list. */
    function PickRow({ pick, t }) {
      const payout = typeof pick.payoutRatio === 'number' ? `${Math.round(pick.payoutRatio * 100)}%` : '—';
      const score = typeof pick.score === 'number' ? pick.score : null;
      return h(
        'li',
        { className: 'fnd-pick' },
        h('span', { className: 'fnd-pick-rank' }, String(pick.rank ?? '')),
        h(
          'div',
          { className: 'fnd-pick-main' },
          h(
            'div',
            { className: 'fnd-pick-name-row' },
            h('span', { className: 'fnd-pick-name' }, pick.name ?? pick.code),
            h('span', { className: 'fnd-pick-code' }, pick.code),
            h('span', { className: 'fnd-pick-sector' }, pick.sector ?? ''),
          ),
          h(
            'div',
            { className: 'fnd-pick-metrics' },
            h('span', null, `${t('picks.yield')} ${pick.dividendYieldPct ?? '—'}%`),
            h('span', null, `PE ${pick.pe ?? '—'}`),
            h('span', null, `PB ${pick.pb ?? '—'}`),
            h('span', null, `${t('picks.payout')} ${payout}`),
            h('span', null, `${t('picks.debt')} ${pick.debtRatio ?? '—'}%`),
          ),
        ),
        h(
          'div',
          { className: 'fnd-pick-score', title: t('picks.score') },
          h('span', { className: 'fnd-pick-score-value' }, score === null ? '—' : score.toFixed(1)),
          h(
            'span',
            { className: 'fnd-pick-score-bar' },
            h('span', { className: 'fnd-pick-score-fill', style: { width: `${Math.max(0, Math.min(100, score ?? 0))}%` } }),
          ),
        ),
      );
    }

    /** 龟龟选股：今日榜单 + 历史选股。 */
    function PicksView({ t, visible, variant }) {
      const isPage = variant === 'page';
      const [date, setDate] = React.useState(null);
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const { data, error, loading, refresh } = usePicks(visible, date);
      const history = usePickHistory(historyOpen);

      const picks = Array.isArray(data?.picks) ? data.picks : [];
      const avgYield =
        picks.length === 0
          ? null
          : picks.reduce((sum, pick) => sum + (typeof pick.dividendYieldPct === 'number' ? pick.dividendYieldPct : 0), 0) / picks.length;
      const generated = data?.generatedAt ? new Date(data.generatedAt) : null;
      const generatedLabel =
        generated !== null && !Number.isNaN(generated.getTime())
          ? `${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`
          : '—';

      const header = h(
        'div',
        { className: 'fnd-picks-head' },
        h(
          'div',
          { className: 'fnd-picks-head-text' },
          h('h2', { className: 'fnd-picks-title' }, t('subtab.picks')),
          h('p', { className: 'fnd-picks-sub' }, t('picks.subtitle')),
          h('p', { className: 'fnd-picks-rule' }, t('picks.rule')),
        ),
        h(
          'div',
          { className: 'fnd-toolbar-actions' },
          date === null
            ? h(
                'button',
                { type: 'button', className: 'fnd-button', onClick: refresh, disabled: loading },
                h(RefreshGlyph, { size: 12 }),
                h('span', null, t('picks.refresh')),
              )
            : h('button', { type: 'button', className: 'fnd-button', onClick: () => setDate(null) }, h('span', null, t('picks.back'))),
          h(
            'button',
            { type: 'button', className: 'fnd-button', onClick: () => setHistoryOpen((value) => !value) },
            h('span', null, t('picks.history')),
          ),
        ),
      );

      const meta =
        data === null
          ? null
          : h(
              'div',
              { className: 'fnd-picks-meta' },
              data.carriedOver === true
                ? h('span', null, t('picks.carried', { date: data.date ?? '' }))
                : h('span', null, `${data.date ?? ''}${data.historical === true ? ` · ${t('picks.historical')}` : ''}`),
              h('span', { className: 'fnd-sep' }, '·'),
              h('span', { className: 'fnd-muted' }, t('picks.generated', { time: generatedLabel })),
              h('span', { className: 'fnd-sep' }, '·'),
              h('span', { className: 'fnd-muted' }, t('picks.count', { n: picks.length })),
              avgYield === null
                ? null
                : h(
                    React.Fragment,
                    null,
                    h('span', { className: 'fnd-sep' }, '·'),
                    h('span', { className: 'fnd-muted' }, t('picks.avgYield', { n: avgYield.toFixed(2) })),
                  ),
            );

      const body =
        loading && data === null
          ? h('div', { className: 'fnd-picks-empty' }, t('picks.loading'))
          : error !== null && data === null
            ? h('div', { className: 'fnd-picks-empty' }, `${t('picks.error')}：${error}`)
            : picks.length === 0
              ? h('div', { className: 'fnd-picks-empty' }, t('picks.empty'))
              : h('ol', { className: 'fnd-picks-list' }, picks.map((pick) => h(PickRow, { key: pick.code, pick, t })));

      const overlay = !historyOpen
        ? null
        : h(
            'div',
            {
              className: 'fnd-picks-overlay',
              role: 'dialog',
              'aria-label': t('picks.historyTitle'),
              onClick: (event) => {
                if (event.target === event.currentTarget) setHistoryOpen(false);
              },
            },
            h(
              'div',
              { className: 'fnd-picks-sheet' },
              h(
                'header',
                { className: 'fnd-picks-sheet-head' },
                h('span', { className: 'fnd-section-title' }, t('picks.historyTitle')),
                h('button', { type: 'button', className: 'fnd-button', onClick: () => setHistoryOpen(false) }, t('picks.close')),
              ),
              history.loading
                ? h('div', { className: 'fnd-picks-empty' }, t('picks.historyLoading'))
                : history.error !== null
                  ? h('div', { className: 'fnd-picks-empty' }, history.error)
                  : (history.days ?? []).length === 0
                    ? h('div', { className: 'fnd-picks-empty' }, t('picks.historyEmpty'))
                    : h(
                        'ul',
                        { className: 'fnd-picks-history' },
                        (history.days ?? []).map((day) =>
                          h(
                            'li',
                            { key: day.date },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: `fnd-pick-history-item${day.date === data?.date ? ' is-active' : ''}`,
                                onClick: () => {
                                  setDate(day.date);
                                  setHistoryOpen(false);
                                },
                              },
                              h('span', { className: 'fnd-pick-history-date' }, day.date),
                              h(
                                'span',
                                { className: 'fnd-pick-history-meta' },
                                `${t('picks.count', { n: day.count })}${day.avgYield === null ? '' : ` · ${t('picks.avgYield', { n: day.avgYield })}`}`,
                              ),
                              h('span', { className: 'fnd-pick-history-top' }, (day.top ?? []).join(' / ')),
                            ),
                          ),
                        ),
                      ),
            ),
          );

      return h(
        'div',
        { className: isPage ? 'fnd-picks fnd-picks-page' : 'fnd-picks' },
        header,
        meta,
        body,
        h('p', { className: 'fnd-picks-note' }, t('picks.note')),
        overlay,
      );
    }

    /** The shared dashboard view behind the right-sidebar tab and the left-sidebar panel. */
    function DashboardView({ visible, useTheme, t, variant }) {
      const isPage = variant === 'page';
      const themeRevision = useTheme((snapshot) => snapshot.revision);
      const [preference, setPreference] = React.useState(readUpDownPreference);
      const [selected, setSelected] = React.useState(WATCH_CODES[0]);
      const [view, setView] = React.useState(SUBTAB_QUOTES);
      const { data, error, loading, refresh } = useQuotes(selected, visible && view === SUBTAB_QUOTES);

      const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
      const byCode = new Map(quotes.map((quote) => [quote.code, quote]));
      const selectedQuote = byCode.get(selected);
      const bars = data?.daily !== undefined && data.daily?.code === selected && Array.isArray(data.daily.bars) ? data.daily.bars : [];
      const offline = error !== null;
      const stale = data?.stale === true;
      const banner = offline && data !== null ? t('state.offline') : stale ? t('state.stale') : null;
      const isEmpty = data === null;

      const togglePreference = () => {
        const next = preference === 'redUp' ? 'greenUp' : 'redUp';
        setPreference(next);
        writeUpDownPreference(next);
      };

      const head = h(
        'div',
        { className: 'fnd-toolbar' },
        h(
          'div',
          { className: 'fnd-toolbar-state' },
          h('span', { className: 'fnd-dot' }),
          h('span', null, data === null ? t('state.loading') : t('state.updated', { time: formatTime(data.fetchedAt) })),
          h('span', { className: 'fnd-sep' }, '·'),
          h('span', { className: 'fnd-muted' }, t('state.auto')),
        ),
        h(
          'div',
          { className: 'fnd-toolbar-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'fnd-button',
              onClick: togglePreference,
              title: preference === 'redUp' ? t('action.colors.redUp') : t('action.colors.greenUp'),
            },
            h(CandleGlyph, { size: 12 }),
            h('span', null, preference === 'redUp' ? t('action.colors.redUp') : t('action.colors.greenUp')),
          ),
          h(
            'button',
            { type: 'button', className: 'fnd-button', onClick: refresh, disabled: loading },
            h(RefreshGlyph, { size: 12 }),
            h('span', null, t('action.refresh')),
          ),
        ),
      );

      const cardCodes = isPage ? ALL_CODES : INDEX_CODES;
      const subTabs = [
        { id: SUBTAB_QUOTES, label: t('subtab.quotes') },
        { id: SUBTAB_PICKS, label: t('subtab.picks') },
      ];

      const pane = isEmpty
        ? h(EmptyState, { t, loading, onRetry: refresh })
        : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'fnd-index-grid' },
              cardCodes.map((code) => h(IndexCard, { key: code, quote: byCode.get(code), preference, t })),
            ),
            h(
              'section',
              { className: 'fnd-section' },
              h(
                'header',
                { className: 'fnd-section-head' },
                h('span', { className: 'fnd-section-title' }, t('chart.title')),
                h('span', { className: 'fnd-section-meta' }, selectedQuote?.name ?? ''),
              ),
              h(DailyChart, { bars, preference, themeRevision, t, tall: isPage }),
            ),
            h(
              'section',
              { className: 'fnd-section' },
              h(
                'header',
                { className: 'fnd-section-head' },
                h('span', { className: 'fnd-section-title' }, t('watchlist.title')),
                h('span', { className: 'fnd-section-meta' }, t('watchlist.hint')),
              ),
              h(
                'div',
                { className: 'fnd-list' },
                WATCH_CODES.map((code) =>
                  h(WatchRow, {
                    key: code,
                    quote: byCode.get(code),
                    selected: code === selected,
                    preference,
                    onSelect: (next) => setSelected(typeof next === 'string' && next !== '' ? next : code),
                  }),
                ),
              ),
            ),
          );

      const tabs = h(SubTabs, {
        tabs: subTabs,
        active: view,
        onSelect: setView,
        variant: isPage ? 'page' : 'tab',
        label: t('tab.title'),
      });

      return h(
        'div',
        { className: isPage ? 'fnd-panel' : 'fnd-root' },
        isPage ? null : tabs,
        h(
          'div',
          { className: isPage ? 'fnd-panel-inner' : 'fnd-scroll' },
          isPage
            ? h(
                'header',
                { className: 'fnd-page-head' },
                h(
                  'div',
                  null,
                  h('h1', { className: 'fnd-page-title' }, t('tab.title')),
                  h('p', { className: 'fnd-page-sub' }, t('page.subtitle')),
                ),
              )
            : null,
          isPage ? tabs : null,
          view === SUBTAB_QUOTES ? head : null,
          view === SUBTAB_QUOTES && banner !== null
            ? h('div', { className: 'fnd-banner' }, h(CandleGlyph, { size: 12 }), h('span', null, banner))
            : null,
          view === SUBTAB_QUOTES ? pane : h(PicksView, { t, visible, variant: isPage ? 'page' : 'tab' }),
        ),
      );
    }

    /** The right-sidebar tab body: binds the view to its tab occurrence. */
    function DashboardBody({ useTabInfo, useTheme, t }) {
      const { tab } = useTabInfo();
      return h(DashboardView, { visible: tab.visible !== false, useTheme, t, variant: 'tab' });
    }

    /** The left-sidebar panel page: the same view at full width with its own heading. */
    function DashboardPanelPage({ useTheme, t }) {
      return h(DashboardView, { visible: true, useTheme, t, variant: 'page' });
    }

    /** The left-sidebar panel glyph. */
    function DashboardPanelIcon({ size }) {
      return h(CandleGlyph, { size });
    }

    /** The chip title: the tab's own glyph followed by its captured title. */
    function DashboardTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return h(React.Fragment, null, h(CandleGlyph, { size: 14, className: 'fnd-title-icon' }), h('span', { className: 'fnd-title-text' }, tab.title));
    }

    /** The start-page card: one click opens this tab type over the guide. */
    function DashboardGuide({ title, description, kind, useTabInfo, openTab }) {
      const { tab } = useTabInfo();
      return h(
        'button',
        {
          type: 'button',
          className: 'fnd-guide-card',
          'data-sidebar-right-guide-entry': kind,
          onClick: () => openTab({ replaceTab: tab.id }),
        },
        h(
          'span',
          { className: 'fnd-guide-icon', 'aria-hidden': 'true' },
          h(CandleGlyph, { size: description === undefined ? 22 : 26 }),
        ),
        h(
          'span',
          { className: 'fnd-guide-text' },
          h('span', { className: 'fnd-guide-title' }, title),
          description === undefined ? null : h('span', { className: 'fnd-guide-desc' }, description),
        ),
      );
    }

    const CSS = `
.fnd-root { display: flex; flex-direction: column; height: 100%; min-height: 100%; color: var(--dsw-alias-label-primary); font-size: 12px; }
.fnd-subtabs { display: flex; align-items: center; gap: 4px; padding: 4px 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
.fnd-subtab { appearance: none; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1.4; padding: 5px 8px 4px; cursor: pointer; border-radius: 6px 6px 0 0; }
.fnd-subtab:hover { color: var(--dsw-alias-label-primary); }
.fnd-subtab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.fnd-scroll { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.fnd-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.fnd-toolbar-state { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.fnd-toolbar-actions { display: flex; align-items: center; gap: 6px; }
.fnd-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
.fnd-sep, .fnd-muted { color: var(--dsw-alias-label-secondary); opacity: .8; }
.fnd-button { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px; border: 0.5px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1; cursor: pointer; }
.fnd-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.fnd-button:disabled { opacity: .55; cursor: default; }
.fnd-banner { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-warn-primary); font-size: 11px; line-height: 1.4; }
.fnd-index-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; }
.fnd-card { display: flex; flex-direction: column; gap: 3px; padding: 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l1); min-width: 0; }
.fnd-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; min-width: 0; }
.fnd-card-name { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-card-code { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .7; flex: none; }
.fnd-card-price { font-size: 20px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.fnd-card-delta { font-size: 11px; font-variant-numeric: tabular-nums; }
.fnd-card-meta { display: flex; flex-direction: column; gap: 1px; font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.fnd-up { color: var(--dsw-alias-state-error-primary); }
.fnd-down { color: var(--dsw-alias-state-success-primary); }
.fnd-flat { color: var(--dsw-alias-label-secondary); }
.fnd-section { display: flex; flex-direction: column; gap: 6px; }
.fnd-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.fnd-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.fnd-section-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-chart { position: relative; width: 100%; height: 190px; }
.fnd-chart-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); font-size: 11px; pointer-events: none; }
.fnd-list { display: flex; flex-direction: column; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l1); overflow: hidden; }
.fnd-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 62px; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.fnd-row:last-child { border-bottom: 0; }
.fnd-row:hover { background: var(--dsw-alias-bg-layer-2); }
.fnd-row.is-selected { background: var(--dsw-alias-bg-layer-2); }
.fnd-row-ident { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.fnd-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-row-code { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .75; }
.fnd-row-price { font-size: 13px; font-variant-numeric: tabular-nums; }
.fnd-row-delta { font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.fnd-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 12px; text-align: center; color: var(--dsw-alias-label-secondary); }
.fnd-empty-glyph { color: var(--dsw-alias-label-secondary); opacity: .55; }
.fnd-empty-title { font-size: 13px; color: var(--dsw-alias-label-primary); margin-top: 4px; }
.fnd-empty-hint { font-size: 11px; max-width: 240px; line-height: 1.5; }
.fnd-empty .fnd-button { margin-top: 6px; }
.fnd-title-icon { color: var(--dsw-alias-label-tertiary); flex: none; }
.fnd-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-guide-card { box-sizing: border-box; width: 380px; max-width: 100%; min-height: 56px; display: flex; align-items: center; gap: 14px; padding: 14px 20px; text-align: left; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: 12px; cursor: pointer; }
.fnd-guide-card:hover { background: var(--dsw-alias-bg-layer-2); }
.fnd-guide-icon { width: 26px; height: 26px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); }
.fnd-guide-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.fnd-guide-title { font-size: 14px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-guide-desc { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-panel { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 12px; }
.fnd-panel-inner { box-sizing: border-box; max-width: 1040px; margin: 0 auto; padding: 24px 28px 40px; display: flex; flex-direction: column; gap: 14px; }
.fnd-page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.fnd-page-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.fnd-page-sub { margin: 2px 0 0; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.fnd-page-tabs { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.fnd-page-tab { appearance: none; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 1.4; padding: 6px 10px; margin-bottom: -1px; cursor: pointer; border-radius: 6px 6px 0 0; }
.fnd-page-tab:hover { color: var(--dsw-alias-label-primary); }
.fnd-page-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.fnd-panel .fnd-index-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.fnd-panel .fnd-card { padding: 14px; border-radius: 12px; }
.fnd-panel .fnd-card-price { font-size: 26px; }
.fnd-panel .fnd-card-meta { flex-direction: row; flex-wrap: wrap; gap: 12px; font-size: 11px; }
.fnd-panel .fnd-row { padding: 11px 14px; }
.fnd-chart.is-tall { height: 340px; }
.fnd-picks { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 14px; min-height: 100%; }
.fnd-picks-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.fnd-picks-head-text { min-width: 0; }
.fnd-picks-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.fnd-picks-sub { margin: 2px 0 0; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.fnd-picks-rule { margin: 4px 0 0; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
.fnd-picks-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.fnd-picks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.fnd-pick { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.fnd-pick-rank { width: 20px; flex: none; text-align: center; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.fnd-pick-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fnd-pick-name-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.fnd-pick-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-pick-code { font-size: 10px; color: var(--dsw-alias-label-tertiary); flex: none; }
.fnd-pick-sector { font-size: 10px; color: var(--dsw-alias-label-secondary); padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); flex: none; }
.fnd-pick-metrics { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.fnd-pick-score { width: 74px; flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.fnd-pick-score-value { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.fnd-pick-score-bar { width: 64px; height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.fnd-pick-score-fill { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.fnd-picks-note { margin: 0; font-size: 10px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
.fnd-picks-empty { padding: 26px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.fnd-picks-overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .28); }
.fnd-picks-sheet { width: min(420px, 100%); max-height: 70vh; display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 18px 48px rgba(0, 0, 0, .25); }
.fnd-picks-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fnd-picks-history { list-style: none; margin: 0; padding: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.fnd-pick-history-item { width: 100%; display: grid; grid-template-columns: 92px 1fr; gap: 2px 8px; padding: 8px 10px; text-align: left; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.fnd-pick-history-item:hover { background: var(--dsw-alias-bg-layer-2); }
.fnd-pick-history-item.is-active { background: var(--dsw-alias-bg-layer-2); }
.fnd-pick-history-date { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.fnd-pick-history-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.fnd-pick-history-top { grid-column: 1 / -1; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnd-root .fnd-picks { padding: 8px 10px 12px; }
.fnd-root .fnd-picks-rule { display: none; }
`;

    /* ------------------------------------------------------------------ */
    /*                              plugin body                            */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'theme', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'financial-dashboard: dictionaries',
        );

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = TYPE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        }, 'financial-dashboard: styles');

        /** Theme snapshot store consumed through the injected useTheme hook. */
        const theme = {
          getSnapshot: () => ctx.theme.getTheme(),
          subscribe: (listener) => ctx.on('theme/change', listener),
        };

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TYPE_ID,
              kind: KIND,
              title: () => t('tab.title'),
              guide: [
                {
                  id: 'quotes',
                  order: 40,
                  title: () => t('guide.title'),
                  description: () => t('guide.description'),
                  icon: CandleGlyph,
                },
              ],
            }),
          'financial-dashboard: tab type',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.tab.guide.entry',
                  key: TYPE_ID,
                  locale: NS,
                  inject: () => ({
                    openTab: (options) => ctx.sidebarRight.openTab(KIND, options),
                  }),
                },
                DashboardGuide,
              ),
            ),
          'financial-dashboard: start-page entry',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TYPE_ID,
                  locale: NS,
                  inject: () => ({ hooks: { theme } }),
                },
                DashboardBody,
              ),
            ),
          'financial-dashboard: tab body',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: TYPE_ID,
                  locale: NS,
                },
                DashboardTitle,
              ),
            ),
          'financial-dashboard: tab title',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 20,
                  locale: NS,
                  label: () => t('panel.label'),
                },
                DashboardPanelIcon,
              ),
            ),
          'financial-dashboard: sidebar panel entry',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,
                  inject: () => ({ hooks: { theme } }),
                },
                DashboardPanelPage,
              ),
            ),
          'financial-dashboard: main panel page',
        );
      },
    };
  },
});
