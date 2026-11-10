window.__ModuleLoader__.load({
  id: 'dsh-wecom-ai-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = React;

    const NAMESPACE = 'wecom-ai-bot';
    const PACKAGE = 'dsh-wecom-ai-bot';
    const STATE_URL = 'api/wecom-ai-bot/state';
    const STORE_URL = 'api/wecom-ai-bot/store';
    const DEFAULT_SECRET_REF = 'WECOM_BOT_SECRET';

    // ---- API helpers -----------------------------------------------------
    async function fetchState(refresh) {
      const res = await fetch(`${STATE_URL}${refresh ? '?refresh=1' : ''}`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) throw new Error('DSH 登录已失效，请刷新页面。');
      if (res.status === 404) throw new Error('插件后台尚未加载新版本，请重启 DSH 后再试。');
      if (!res.ok) throw new Error(`插件状态读取失败（HTTP ${res.status}）。`);
      return await res.json();
    }
    async function postStore(ops) {
      let res;
      try {
        res = await fetch(STORE_URL, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops }),
        });
      } catch {
        throw new Error('无法连接插件后台，请确认 DSH 仍在运行。');
      }
      if (res.status === 401 || res.status === 403) throw new Error('DSH 登录已失效，请刷新页面。');
      if (res.status === 404) throw new Error('插件后台尚未加载新版本，请重启 DSH 后再试。');
      let body;
      try { body = await res.json(); } catch { throw new Error(`修改失败（HTTP ${res.status}）。`); }
      if (!body.ok) throw new Error(body.error ?? `修改失败（HTTP ${res.status}）。`);
      return body;
    }
    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result && typeof result.ok === 'boolean') {
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 拒绝了请求');
        return result.value;
      }
      return result;
    }

    // ---- ops -------------------------------------------------------------
    const opSetSettings = patch => ({ op: 'settings.set', patch });
    const opAddBinding = (kind, id, workspaceId, name) => ({ op: 'binding.add', kind, id, workspaceId, name });
    const opUpdateBinding = (key, patch) => ({ op: 'binding.update', key, patch });
    const opRemoveBinding = key => ({ op: 'binding.remove', key });
    const opSetName = (key, name) => ({ op: 'name.set', key, name });

    // ---- tiny primitives -------------------------------------------------
    function Section({ id, title, description, count, children }) {
      return h('section', { className: 'wfb-section', 'data-section': id },
        h('div', { className: 'wfb-section-head' },
          h('h4', { className: 'wfb-section-title' }, title),
          count != null && count !== '' ? h('span', { className: 'wfb-section-count' }, count) : null),
        description ? h('p', { className: 'wfb-section-desc' }, description) : null,
        children);
    }
    function Notice({ tone, children }) {
      return h('p', { className: 'wfb-notice', 'data-tone': tone ?? 'warning', role: 'status' }, children);
    }
    function Empty({ children }) {
      return h('p', { className: 'wfb-empty' }, children);
    }
    function Toggle({ checked, disabled, label, hint, onChange }) {
      return h('button', {
        type: 'button', className: 'wfb-switch', role: 'switch', 'aria-checked': !!checked,
        'aria-label': label, title: hint ?? label, disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'wfb-switch-track' }, h('span', { className: 'wfb-switch-thumb' })));
    }
    function SwitchRow({ checked, disabled, title, hint, onChange }) {
      return h('div', { className: 'wfb-switch-row' },
        h('div', { className: 'wfb-switch-text' },
          h('span', { className: 'wfb-row-title' }, title),
          hint ? h('span', { className: 'wfb-hint' }, hint) : null),
        h(Toggle, { checked, disabled, label: title, onChange }));
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'wfb-field' },
        h('span', { className: 'wfb-field-label' }, label),
        children,
        hint ? h('span', { className: 'wfb-hint' }, hint) : null);
    }
    function Btn({ variant, size, disabled, busy, onClick, children, title }) {
      return h('button', {
        type: 'button', className: ['wfb-btn', variant === 'primary' ? 'wfb-btn-primary' : 'wfb-btn-outline', size === 'sm' ? 'wfb-btn-sm' : ''].filter(Boolean).join(' '),
        disabled: disabled || busy, title,
        onClick,
      }, busy ? '处理中…' : children);
    }
    function TextInput(props) {
      return h('input', { type: 'text', className: 'wfb-input', ...props });
    }
    function WorkspaceSelect({ value, workspaces, onChange, ariaLabel, placeholder }) {
      const items = Array.isArray(workspaces) ? workspaces : [];
      return h('select', { className: 'wfb-select', value: value ?? '', 'aria-label': ariaLabel, onChange: e => onChange(e.target.value) },
        h('option', { value: '' }, placeholder ?? '默认工作空间'),
        items.map(ws => h('option', { key: ws.workspaceId, value: ws.workspaceId }, ws.title || ws.path || ws.workspaceId)));
    }

    const PHASE_LABEL = {
      unconfigured: '未配置', disabled: '已关闭', online: '在线', connecting: '连接中',
      reconnecting: '重连中', offline: '离线', error: '错误', displaced: '被顶下线', invalid: '无效',
    };
    function phaseLabel(connection) {
      const phase = connection?.phase ?? 'unconfigured';
      return PHASE_LABEL[phase] ?? phase;
    }

    // ---- state hooks -----------------------------------------------------
    function useBridgeState() {
      const [data, setData] = useState();
      const [error, setError] = useState();
      const [loading, setLoading] = useState(true);
      const tick = useRef(() => {});
      useEffect(() => {
        let active = true;
        const controller = new AbortController();
        let inflight = false;
        async function load(force) {
          if (inflight) return;
          inflight = true;
          try {
            const next = await fetchState(force);
            if (!active) return;
            setData(next);
            setError(undefined);
          } catch (cause) {
            if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            inflight = false;
            if (active) setLoading(false);
          }
        }
        tick.current = force => { void load(force); };
        void load(true);
        const timer = setInterval(() => { void load(false); }, 5000);
        return () => { active = false; controller.abort(); clearInterval(timer); };
      }, []);
      const refresh = useCallback((force = true) => tick.current(force), []);
      return { data, error, loading, refresh };
    }

    function useApply(onChanged) {
      const [busy, setBusy] = useState('');
      const [error, setError] = useState();
      const apply = useCallback(async (key, ops) => {
        setBusy(key);
        setError(undefined);
        try {
          await postStore(ops);
          onChanged();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy('');
        }
      }, [onChanged]);
      return { busy, error, apply, dismiss: () => setError(undefined) };
    }

    function useConfigSnapshot(scope) {
      return useSyncExternalStore(
        listener => scope.subscribe(listener),
        () => scope.getSnapshot(),
      );
    }

    // ---- sections --------------------------------------------------------
    function ConnectionSection({ state, scope, remote, onChanged }) {
      const configSnap = useConfigSnapshot(scope);
      const configValue = configSnap?.value ?? {};
      const storedBotId = typeof configValue.botId === 'string' ? configValue.botId : '';
      const secretRef = (typeof configValue.secretEnv === 'string' && configValue.secretEnv.trim()) ? configValue.secretEnv.trim() : DEFAULT_SECRET_REF;
      const [botId, setBotId] = useState(storedBotId);
      const [secret, setSecret] = useState('');
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(false);
      const [err, setErr] = useState();
      const [secretConfigured, setSecretConfigured] = useState(Boolean(state?.config?.secretConfigured));
      const timer = useRef();
      useEffect(() => { setBotId(storedBotId); }, [storedBotId]);
      useEffect(() => { setSecretConfigured(Boolean(state?.config?.secretConfigured)); }, [state?.config?.secretConfigured]);
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const credentials = remote?.credentials;
      useEffect(() => {
        let active = true;
        if (!credentials?.describe) return;
        credentials.describe([secretRef]).then(raw => {
          if (!active) return;
          const info = unwrap(raw)?.[secretRef];
          setSecretConfigured(Boolean(info?.configured));
        }).catch(() => { if (active) setSecretConfigured(false); });
        return () => { active = false; };
      }, [credentials, secretRef]);
      useEffect(() => remote?.$on?.('credentials/reference-updated', updated => {
        if (updated === secretRef) { setSecretConfigured(true); }
      }), [remote, secretRef]);

      const save = async () => {
        setSaving(true);
        setErr(undefined);
        try {
          if (botId.trim() !== storedBotId) {
            let applied = false;
            for (let attempt = 0; attempt < 3 && !applied; attempt++) {
              const latest = scope.getSnapshot();
              const value = latest?.value ?? {};
              const current = typeof value.botId === 'string' ? value.botId : '';
              if (current === botId.trim()) { applied = true; break; }
              if (await scope.mutate([{ op: 'set', path: ['botId'], value: botId.trim() }], latest.revision)) applied = true;
              if (attempt === 2 && !applied) throw new Error('配置已在别处被修改，请刷新页面后重试。');
            }
          }
          if (secret.trim()) {
            if (!credentials?.set) throw new Error('DSH 凭据服务未连接。');
            const result = await credentials.set(secretRef, secret.trim());
            if (result !== undefined) unwrap(result);
            setSecret('');
            setSecretConfigured(true);
          }
          setSaved(true);
          timer.current = setTimeout(() => setSaved(false), 2000);
          onChanged();
        } catch (cause) {
          setErr(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      };

      const connection = state?.connection ?? {};
      const traffic = state?.traffic ?? {};
      const phase = connection.phase ?? 'unconfigured';
      return h(Section, { id: 'connection', title: '连接', description: '在企业微信管理后台 → 智能机器人 → API 模式里拿到 Bot ID 与 Secret；Secret 存入 DSH 凭据库，不写入配置、不回显。' },
        h('div', { className: 'wfb-status-line' },
          h('span', { className: 'wfb-dot', 'data-phase': phase }),
          h('span', { className: 'wfb-status-text' }, phaseLabel(connection)),
          connection.detail ? h('span', { className: 'wfb-muted', title: connection.detail }, `· ${connection.detail}`) : null),
        h('div', { className: 'wfb-card' },
          h(Field, { label: 'Bot ID' },
            h(TextInput, { value: botId, placeholder: '必填', 'aria-label': 'Bot ID', onChange: e => setBotId(e.target.value) })),
          h(Field, { label: 'Bot Secret', hint: secretConfigured ? '已保存（不会回显）；留空表示不修改。' : '首次配置必填。' },
            h(TextInput, { value: secret, type: 'password', placeholder: secretConfigured ? '••••••••' : '必填', 'aria-label': 'Bot Secret', onChange: e => setSecret(e.target.value) })),
          h('div', { className: 'wfb-footer' },
            saved ? h('span', { className: 'wfb-ok', role: 'status' }, '已保存') : null,
            h(Btn, { variant: 'primary', size: 'sm', busy: saving, onClick: () => { void save(); } }, '保存并连接')),
          err ? h(Notice, { tone: 'error' }, err) : null,
          h('p', { className: 'wfb-muted' }, `本次启动：收到 ${traffic.received ?? 0} · 拒绝 ${traffic.rejected ?? 0} · 提交 ${traffic.prompts ?? 0} · 通知 ${traffic.notifications ?? 0} · 失败 ${traffic.failures ?? 0}`)));
    }

    function RulesSection({ state, apply, busy }) {
      const settings = state?.settings ?? {};
      return h(Section, { id: 'rules', title: '开关', description: '全局开关关闭后机器人不会连接、也不响应任何消息；其它开关即时生效，不会断开连接。' },
        h('div', { className: 'wfb-card' },
          h(SwitchRow, {
            checked: settings.enabled !== false, disabled: busy,
            title: '全局开关', hint: settings.enabled === false ? '当前已关闭：机器人不连接、不响应。' : '当前已开启。',
            onChange: v => { void apply('global', [opSetSettings({ enabled: v })]); },
          }),
          h(SwitchRow, {
            checked: settings.adminGroupAutoAuthorize === true, disabled: busy,
            title: '管理员入群自动授权', hint: '开启后，管理员在某个群聊里发消息，就会自动授权整个群的人与机器人互动。',
            onChange: v => { void apply('autogroup', [opSetSettings({ adminGroupAutoAuthorize: v })]); },
          })));
    }

    function PendingSection({ state, apply, busy }) {
      const rows = state?.rejected ?? [];
      const [workspaceId, setWorkspaceId] = useState('');
      const workspaces = state?.workspaces ?? [];
      const adminIds = state?.settings?.adminUserIds ?? [];
      return h(Section, {
        id: 'pending', title: '待授权 / 首次接触', count: rows.length ? `${rows.length} 个` : undefined,
        description: '给机器人发过消息、但尚未被授权的人或群会出现在这里。可以「授权」（按下方工作空间）或直接「设为管理员」。',
      },
        rows.length === 0
          ? h(Empty, null, '没有待授权的人或群。')
          : h('div', { className: 'wfb-card' },
            h(Field, { label: '授权工作空间', hint: '留空表示使用默认工作空间；给下面的人/群授权时会用这个工作空间。' },
              h(WorkspaceSelect, { value: workspaceId, workspaces, onChange: setWorkspaceId, ariaLabel: '授权工作空间' })),
            h('ul', { className: 'wfb-list' },
              rows.map(row => {
                const isAdmin = row.kind === 'user' && adminIds.includes(row.id);
                return h('li', { className: 'wfb-row', key: row.key },
                  h('span', { className: 'wfb-avatar', 'data-kind': row.kind }, row.kind === 'group' ? '群' : '人'),
                  h('div', { className: 'wfb-row-main' },
                    h('span', { className: 'wfb-row-title' }, row.displayName),
                    h('span', { className: 'wfb-row-meta wfb-mono' }, `${row.kind === 'group' ? '群' : '用户'} · ${row.id}`),
                    row.text ? h('span', { className: 'wfb-row-quote' }, `“${row.text}”`) : null),
                  h('div', { className: 'wfb-row-actions' },
                    isAdmin ? h('span', { className: 'wfb-tag' }, '已是管理员')
                      : h(Btn, { size: 'sm', busy: busy === row.key, onClick: () => { void apply(row.key, [opSetSettings({ adminUserIds: [...adminIds, row.id] })]); } }, '设为管理员'),
                    h(Btn, { size: 'sm', variant: 'primary', busy: busy === `a-${row.key}`, onClick: () => { void apply(`a-${row.key}`, [opAddBinding(row.kind, row.id, workspaceId, undefined)]); } }, '授权')));
              }))));
    }

    function BindingsSection({ state, apply, busy }) {
      const rows = state?.bindings ?? [];
      const workspaces = state?.workspaces ?? [];
      const [kind, setKind] = useState('user');
      const [id, setId] = useState('');
      const [workspaceId, setWorkspaceId] = useState('');
      const add = () => {
        const clean = id.trim();
        if (!clean) return;
        void apply('add', [opAddBinding(kind, clean, workspaceId, undefined)]);
        setId('');
        setWorkspaceId('');
      };
      return h(Section, { id: 'bindings', title: '授权（人 / 群 → 工作空间）', count: rows.length ? `${rows.length} 个` : undefined, description: '每个被授权的人或群都有一个专属工作空间，会话在该工作空间内运行。昵称与工作空间都可以直接编辑保存。' },
        h('div', { className: 'wfb-card' },
          h('div', { className: 'wfb-add-row' },
            h('select', { className: 'wfb-select', value: kind, 'aria-label': '类型', onChange: e => setKind(e.target.value) },
              h('option', { value: 'user' }, '个人'),
              h('option', { value: 'group' }, '群聊')),
            h(TextInput, { value: id, placeholder: kind === 'group' ? '群 chatid' : '用户 userid', 'aria-label': 'ID', onChange: e => setId(e.target.value) }),
            h(WorkspaceSelect, { value: workspaceId, workspaces, onChange: setWorkspaceId, ariaLabel: '工作空间' }),
            h(Btn, { variant: 'primary', size: 'sm', busy: busy === 'add', disabled: !id.trim(), onClick: add }, '授权')),
          rows.length === 0
            ? h(Empty, null, '还没有任何授权。')
            : h('ul', { className: 'wfb-list' },
              rows.map(row => h(BindingRow, {
                key: row.key, row, busy, workspaces,
                onName: name => { void apply(`n-${row.key}`, [opSetName(row.key, name)]); },
                onWorkspace: workspaceId => { void apply(`f-${row.key}`, [opUpdateBinding(row.key, { workspaceId })]); },
                onRemove: () => { void apply(`r-${row.key}`, [opRemoveBinding(row.key)]); },
              })))));
    }

    function BindingRow({ row, busy, workspaces, onName, onWorkspace, onRemove }) {
      return h('li', { className: 'wfb-row wfb-row-stacked' },
        h('div', { className: 'wfb-row-main' },
          h('span', { className: 'wfb-avatar', 'data-kind': row.kind }, row.kind === 'group' ? '群' : '人'),
          h('div', { className: 'wfb-row-main-col' },
            h('span', { className: 'wfb-row-title' },
              h(TextInput, { className: 'wfb-input-inline', defaultValue: row.name, placeholder: row.id, 'aria-label': '昵称', onBlur: e => { const v = e.target.value.trim(); if (v !== row.name) onName(v); }, onKeyDown: e => { if (e.key === 'Enter') e.currentTarget.blur(); } }),
              h('span', { className: 'wfb-row-meta wfb-mono', title: row.id }, `· ${row.id}`)),
            h('span', { className: 'wfb-hint' }, row.sessionId ? `会话 ${row.sessionId}` : '尚未创建会话'))),
        h('div', { className: 'wfb-row-actions' },
          h(WorkspaceSelect, { value: row.workspaceId ?? '', workspaces, onChange: onWorkspace, ariaLabel: '工作空间' }),
          h(Btn, { size: 'sm', disabled: busy, onClick: onRemove, title: '移除授权' }, '移除')));
    }

    function AdminsSection({ state, apply, busy }) {
      const admins = state?.admins ?? [];
      const adminIds = state?.settings?.adminUserIds ?? [];
      const [query, setQuery] = useState('');
      const candidates = useMemo(() => {
        const map = new Map();
        for (const row of state?.rejected ?? []) {
          if (row.kind !== 'user') continue;
          map.set(row.id, { id: row.id, name: row.displayName });
        }
        for (const row of state?.bindings ?? []) {
          if (row.kind !== 'user') continue;
          map.set(row.id, { id: row.id, name: row.displayName });
        }
        for (const id of adminIds) map.delete(id);
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
      }, [state, adminIds]);
      const needle = query.trim().toLowerCase();
      const matches = needle ? candidates.filter(c => c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)) : candidates;
      return h(Section, { id: 'admins', title: '管理员', count: admins.length ? `${admins.length} 人` : undefined, description: '管理员可以在单聊中直接与机器人互动；开启「管理员入群自动授权」后，管理员在群里的发言会自动授权整个群。' },
        h('div', { className: 'wfb-card' },
          admins.length === 0
            ? h(Empty, null, '还没有管理员。')
            : h('ul', { className: 'wfb-list' },
              admins.map(admin => h('li', { className: 'wfb-row', key: admin.id },
                h('span', { className: 'wfb-avatar', 'data-kind': 'user' }, '人'),
                h('div', { className: 'wfb-row-main' },
                  h('span', { className: 'wfb-row-title' }, admin.displayName),
                  h('span', { className: 'wfb-row-meta wfb-mono' }, admin.id)),
                h('div', { className: 'wfb-row-actions' },
                  h(Btn, { size: 'sm', busy: busy === admin.id, onClick: () => { void apply(admin.id, [opSetSettings({ adminUserIds: adminIds.filter(x => x !== admin.id) })]); } }, '移除'))))),
          h('div', { className: 'wfb-add-row' },
            h(TextInput, { value: query, placeholder: '搜索昵称或 userid，或直接输入 userid', 'aria-label': '添加管理员', onChange: e => setQuery(e.target.value) }),
            h(Btn, { variant: 'primary', size: 'sm', disabled: !query.trim(), busy: busy === 'admin-add', onClick: () => { void apply('admin-add', [opSetSettings({ adminUserIds: [...adminIds, query.trim()] })]); setQuery(''); } }, '添加')),
          matches.length ? h('ul', { className: 'wfb-list' },
            matches.slice(0, 20).map(c => h('li', { className: 'wfb-row', key: c.id },
              h('div', { className: 'wfb-row-main' },
                h('span', { className: 'wfb-row-title' }, c.name),
                h('span', { className: 'wfb-row-meta wfb-mono' }, c.id)),
              h('div', { className: 'wfb-row-actions' },
                h(Btn, { size: 'sm', onClick: () => { void apply(c.id, [opSetSettings({ adminUserIds: [...adminIds, c.id] })]); } }, '设为管理员'))))) : null));
    }

    function SettingsPage({ scope, remote }) {
      const { data, error, loading, refresh } = useBridgeState();
      const { busy, error: applyError, apply } = useApply(refresh);
      if (loading && !data) return h('p', { className: 'wfb-empty' }, '正在读取插件状态…');
      if (error && !data) return h(Notice, { tone: 'error' }, error);
      return h('div', { className: 'wfb-page' },
        applyError ? h(Notice, { tone: 'error' }, applyError) : null,
        h(ConnectionSection, { state: data, scope, remote, onChanged: refresh }),
        h(RulesSection, { state: data, apply, busy: busy === 'global' || busy === 'autogroup' }),
        h(PendingSection, { state: data, apply, busy }),
        h(BindingsSection, { state: data, apply, busy }),
        h(AdminsSection, { state: data, apply, busy }));
    }

    const STYLES = `
      .wfb-page { display: flex; flex-direction: column; gap: 20px; }
      .wfb-section { display: flex; flex-direction: column; gap: 8px; }
      .wfb-section-head { display: flex; align-items: center; gap: 8px; }
      .wfb-section-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .wfb-section-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wfb-section-desc { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
      .wfb-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .wfb-field { display: flex; flex-direction: column; gap: 4px; }
      .wfb-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wfb-input, .wfb-select { width: 100%; box-sizing: border-box; padding: 7px 9px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; }
      .wfb-input-inline { width: 140px; padding: 3px 6px; font-size: 13px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid transparent; border-radius: 6px; }
      .wfb-input-inline:hover, .wfb-input-inline:focus { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
      .wfb-row-actions .wfb-select { width: 200px; font-size: 12px; }
      .wfb-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .wfb-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wfb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .wfb-empty { margin: 4px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wfb-notice { margin: 0; padding: 8px 10px; font-size: 12px; border-radius: 8px; line-height: 1.5; }
      .wfb-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .wfb-notice[data-tone="warning"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .wfb-status-line { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); }
      .wfb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .wfb-dot[data-phase="online"] { background: var(--dsw-alias-state-success-primary); }
      .wfb-dot[data-phase="error"], .wfb-dot[data-phase="displaced"], .wfb-dot[data-phase="invalid"] { background: var(--dsw-alias-state-error-primary); }
      .wfb-dot[data-phase="connecting"], .wfb-dot[data-phase="reconnecting"] { background: var(--dsw-alias-state-warn-primary); }
      .wfb-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
      .wfb-switch-text { display: flex; flex-direction: column; gap: 2px; }
      .wfb-row-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
      .wfb-switch { padding: 0; border: none; background: transparent; cursor: pointer; }
      .wfb-switch:disabled { opacity: 0.5; cursor: not-allowed; }
      .wfb-switch-track { display: inline-block; width: 36px; height: 20px; border-radius: 10px; background: var(--dsw-alias-border-l2); position: relative; transition: background 0.15s ease; }
      .wfb-switch-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s ease; }
      .wfb-switch[aria-checked="true"] .wfb-switch-track { background: var(--dsw-alias-brand-primary); }
      .wfb-switch[aria-checked="true"] .wfb-switch-thumb { transform: translateX(16px); }
      .wfb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; font-size: 13px; border-radius: 7px; border: 1px solid transparent; cursor: pointer; }
      .wfb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .wfb-btn-sm { padding: 4px 9px; font-size: 12px; }
      .wfb-btn-primary { background: var(--dsw-alias-brand-primary); color: #fff; }
      .wfb-btn-outline { background: transparent; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
      .wfb-footer { display: flex; align-items: center; gap: 10px; }
      .wfb-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
      .wfb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .wfb-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .wfb-row:first-child { border-top: none; }
      .wfb-row-stacked { align-items: flex-start; flex-direction: column; }
      .wfb-row-stacked .wfb-row-actions { width: 100%; }
      .wfb-avatar { flex: none; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
      .wfb-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
      .wfb-row-main-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .wfb-row-quote { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wfb-row-meta { display: inline-flex; align-items: center; gap: 4px; }
      .wfb-row-actions { display: flex; align-items: center; gap: 6px; }
      .wfb-add-row { display: flex; gap: 8px; align-items: center; }
      .wfb-add-row .wfb-select { width: auto; }
      .wfb-add-row .wfb-input { flex: 1; min-width: 120px; }
      .wfb-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
    `;

    function insertStyles(doc = document) {
      const element = doc.createElement('style');
      element.setAttribute('data-dsh-plugin', PACKAGE);
      element.textContent = STYLES;
      doc.head.appendChild(element);
      return () => element.remove();
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        const slots = ctx.get('slots');
        const forms = ctx.get('configForms');
        const remote = ctx.get('remote');
        if (!slots || !forms) return;
        ctx.effect(() => insertStyles());
        ctx.effect(() => forms.whileServed([NAMESPACE], () => slots.inject('plugins.bundle.config', () => slots.register(
          { name: 'plugins.bundle.config', key: PACKAGE },
          ({ view }) => view === 'page' ? h(SettingsPage, { scope: forms.get(NAMESPACE), remote }) : null,
        ))));
      },
    };
  },
});
