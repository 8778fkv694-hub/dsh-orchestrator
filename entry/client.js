/**
 * Browser half of the pipeline entry plugin.
 *
 * Registers one persistent global panel icon in the left sidebar (directly
 * below the built-in Plugins icon) and the page it addresses: a manager for
 * one or more local pipeline dashboards. Each dashboard can be opened in the
 * system browser, entered as a working session, added, or removed; the Host
 * half owns the list, the loopback ports and the access tokens, and serves the
 * page through the Host web server.
 *
 * Plain-JS dynamic client bundle: it only uses the documented client services
 * (slots, locale, uiWorkspace, workspaces) and its own inline markup/styles
 * with host theme tokens. It does not import Harness client packages.
 */
window.__ModuleLoader__.load({
  id: '@local/orch-entry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'orch-entry';
    const PANEL_ID = 'orch-entry';
    const ROUTE = '/orch-entry/api/dashboards';

    const DICT = {
      zh: {
        panel: '管线',
        title: '管线',
        intro: '从左侧栏直接进入管线：打开任一本机看板，或进入会话让 Agent 按工作单继续推进。看板地址、端口可自定义，也可以添加多个。',
        refresh: '刷新',
        dashboards: '看板',
        empty: '还没有看板。用下面的表单添加一个：填工作区目录（插件自动启动看板），或填一个已有的看板地址。',
        loading: '正在读取看板列表…',
        loadFailed: '读取看板列表失败',
        openBoard: '打开看板',
        enterWork: '进入会话',
        remove: '移除',
        addTitle: '添加看板',
        fieldLabel: '名称',
        fieldLabelPlaceholder: '例如：新闻简报',
        fieldWorkspace: '工作区目录',
        fieldWorkspacePlaceholder: '/Users/you/开发/项目目录',
        fieldPort: '端口（可选）',
        fieldPortPlaceholder: '留空自动分配',
        fieldUrl: '看板地址（可选）',
        fieldUrlPlaceholder: 'http://127.0.0.1:8891/?token=…',
        add: '添加看板',
        adding: '添加中…',
        addHint: '工作区与看板地址二选一：填工作区由插件启动只读看板；填地址则只做一个外链入口（适合手工启动的看板）。',
        added: '已添加',
        removed: '已移除',
        external: '外链',
        stateStarting: '启动中',
        stateRunning: '运行中',
        stateExternal: '外链',
        stateFailed: '启动失败',
        enterHint: '进入会在该工作区打开会话，并把下一步提示词预填进输入框，不会自动发送。',
        boardHint: '看板由插件启用时在 127.0.0.1 启动，仅本机可访问；页面里的动作只发出工作单，执行仍在会话里。',
        guideTitle: '操作说明',
        guide1: '每个看板是一个独立入口：可由插件自动启动（填工作区），也可以是手工启动看板的外链（填地址）。',
        guide2: '「进入会话」：在对应工作区打开会话并预填下一步提示词，按发送后才开始；「打开看板」：在系统浏览器打开该看板。',
        guide3: '可以添加多个看板：不同项目、不同管线，甚至同一工作区的不同端口，都各自独立。',
        guide4: '端口留空自动分配；填了自定义端口就固定使用（被占用时会提示启动失败）。',
        guide5: '看板里能看运行状态、当前工作单、每步证据与交付物；「下一步/继续/暂停/取消」只登记工作单，不执行任务。',
        guide6: '执行在会话里，人工门卡片必须你本人点，模型不能代选。移除看板只关闭该看板服务，不动项目数据与管线记录。',
        guideNote: '看板列表保存在插件本机的状态文件里；卸载插件会关闭所有由它启动的看板。项目规则看各工作区的 AGENT.md / STATUS.md。',
        flowTitle: '推荐流程',
        flow1: '添加或确认看板：工作区 + 端口（留空自动），需要时也可以加外链看板。',
        flow2: '点「打开看板」看进度，点「进入会话」让 Agent 按 orch_status 取工作单执行、提交证据。',
        flow3: '人工门由你本人点；在看板里核对进度、证据与交付物，推进到核验通过。',
        actionFailed: '操作失败',
        workspaceCreateFailed: '无法登记该项目工作区',
      },
      en: {
        panel: 'Pipeline',
        title: 'Pipeline',
        intro: 'Enter the pipeline straight from the sidebar: open any local dashboard, or open a session that continues the work order. Addresses and ports are configurable, and you can add several dashboards.',
        refresh: 'Refresh',
        dashboards: 'Dashboards',
        empty: 'No dashboards yet. Add one below: fill a workspace directory (the plugin starts the dashboard), or fill an existing dashboard address.',
        loading: 'Loading dashboards…',
        loadFailed: 'Could not load dashboards',
        openBoard: 'Open dashboard',
        enterWork: 'Open session',
        remove: 'Remove',
        addTitle: 'Add a dashboard',
        fieldLabel: 'Name',
        fieldLabelPlaceholder: 'e.g. News briefing',
        fieldWorkspace: 'Workspace directory',
        fieldWorkspacePlaceholder: '/Users/you/dev/project',
        fieldPort: 'Port (optional)',
        fieldPortPlaceholder: 'empty = auto',
        fieldUrl: 'Dashboard address (optional)',
        fieldUrlPlaceholder: 'http://127.0.0.1:8891/?token=…',
        add: 'Add dashboard',
        adding: 'Adding…',
        addHint: 'Use either a workspace or an address: a workspace makes the plugin start a read-only dashboard; an address only adds an external link (for manually started dashboards).',
        added: 'Added',
        removed: 'Removed',
        external: 'External',
        stateStarting: 'Starting',
        stateRunning: 'Running',
        stateExternal: 'External',
        stateFailed: 'Failed to start',
        enterHint: 'Opening a session starts it in that workspace and prefills the next-step prompt; nothing is sent automatically.',
        boardHint: 'Dashboards start on 127.0.0.1 while the plugin is enabled and are reachable from this machine only; their actions only persist work orders, execution stays in the session.',
        guideTitle: 'How it works',
        guide1: 'Each dashboard is an independent entry: the plugin can start it (when you give a workspace), or it can link an externally started dashboard (when you give an address).',
        guide2: '"Open session" opens a session in that workspace with the next-step prompt prefilled and sends nothing until you press send; "Open dashboard" opens that dashboard in the system browser.',
        guide3: 'Add several dashboards for different projects, different pipelines, or even the same workspace on different ports.',
        guide4: 'Leave the port empty to auto-assign one; a custom port is used as-is (a busy port reports a start failure).',
        guide5: 'Each dashboard shows run status, the current work order, per-step evidence and deliverables; next/continue/pause/cancel only persist work orders and never execute.',
        guide6: 'Execution stays in the session and every human gate must be answered by you. Removing a dashboard only stops that dashboard service; project data and pipeline records stay intact.',
        guideNote: 'The list is kept in a local state file owned by the plugin; uninstalling the plugin closes every dashboard it started. Project rules live in each workspace AGENT.md / STATUS.md.',
        flowTitle: 'Suggested flow',
        flow1: 'Add or confirm a dashboard: workspace + port (empty = auto); link external dashboards when needed.',
        flow2: 'Use "Open dashboard" to watch progress, and "Open session" so the agent reads orch_status, executes the work order and submits evidence.',
        flow3: 'Answer the human gates yourself; check progress, evidence and deliverables in the dashboard until delivery is verified.',
        actionFailed: 'Action failed',
        workspaceCreateFailed: 'Could not register the project workspace',
      },
    };

    const COLOR = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      raised: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    function pipelineMark(size) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M6.2 12h4.1M13.6 7.6l-3.3 3.1M13.6 16.4l-3.3-3.1' }),
        h('circle', { cx: 5, cy: 12, r: 2.1 }),
        h('rect', { x: 13.6, y: 4.6, width: 5.6, height: 5.6, rx: 1.6 }),
        h('rect', { x: 13.6, y: 13.8, width: 5.6, height: 5.6, rx: 1.6 }),
      );
    }

    function PipelineIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return pipelineMark(size);
    }

    const pageStyle = {
      height: '100%',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '40px 28px 56px',
      color: COLOR.text,
      background: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
    };
    const shellStyle = { maxWidth: '880px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' };
    const headerStyle = { display: 'flex', gap: '14px', alignItems: 'flex-start' };
    const markStyle = {
      display: 'grid',
      placeItems: 'center',
      width: '36px',
      height: '36px',
      flex: '0 0 auto',
      borderRadius: '10px',
      border: '1px solid ' + COLOR.border,
      background: COLOR.nested,
      color: COLOR.brand,
    };
    const titleStyle = { fontSize: '20px', lineHeight: '28px', fontWeight: 600, margin: '2px 0 4px' };
    const subtitleStyle = { fontSize: '13px', lineHeight: '20px', color: COLOR.muted, maxWidth: '660px' };
    const contentStyle = { display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'flex-start' };
    const cardStyle = {
      flex: '1 1 380px',
      minWidth: '300px',
      border: '1px solid ' + COLOR.border,
      background: COLOR.raised,
      borderRadius: '14px',
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      boxSizing: 'border-box',
    };
    const cardHeadStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' };
    const cardTitleStyle = { fontSize: '14px', lineHeight: '20px', fontWeight: 600 };
    const listStyle = { display: 'flex', flexDirection: 'column', gap: '10px' };
    const dashStyle = {
      border: '1px solid ' + COLOR.border,
      background: COLOR.nested,
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    };
    const dashHeadStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', lineHeight: '20px', fontWeight: 600 };
    const dotStyle = { width: '8px', height: '8px', borderRadius: '999px', flex: '0 0 auto' };
    const dashMetaStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.muted, wordBreak: 'break-all' };
    const dashErrorStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.error, wordBreak: 'break-all' };
    const dashActionsStyle = { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' };
    const buttonBase = {
      font: 'inherit',
      fontSize: '12.5px',
      lineHeight: '18px',
      padding: '6px 11px',
      borderRadius: '8px',
      border: '1px solid transparent',
      cursor: 'pointer',
    };
    const primarySmallStyle = Object.assign({}, buttonBase, {
      background: COLOR.brand,
      borderColor: COLOR.brand,
      color: 'var(--dsw-alias-bg-base)',
      fontWeight: 600,
    });
    const secondarySmallStyle = Object.assign({}, buttonBase, {
      background: COLOR.raised,
      borderColor: COLOR.border,
      color: COLOR.text,
    });
    const ghostSmallStyle = Object.assign({}, buttonBase, {
      background: 'transparent',
      borderColor: 'transparent',
      color: COLOR.muted,
    });
    const hintStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.muted };
    const noticeStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.error };
    const okStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.success };
    const fieldRowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px' };
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 180px', minWidth: '160px' };
    const fieldLabelStyle = { fontSize: '11.5px', lineHeight: '16px', color: COLOR.muted };
    const inputStyle = {
      font: 'inherit',
      fontSize: '12.5px',
      lineHeight: '18px',
      padding: '6px 9px',
      borderRadius: '8px',
      border: '1px solid ' + COLOR.border,
      background: COLOR.raised,
      color: COLOR.text,
      width: '100%',
      boxSizing: 'border-box',
      outline: 'none',
    };
    const guideStyle = {
      flex: '1 1 300px',
      minWidth: '280px',
      border: '1px solid ' + COLOR.border,
      background: COLOR.raised,
      borderRadius: '14px',
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      boxSizing: 'border-box',
    };
    const guideTitleStyle = { fontSize: '14px', lineHeight: '20px', fontWeight: 600 };
    const stepStyle = { display: 'flex', gap: '10px', fontSize: '12.5px', lineHeight: '19px', color: COLOR.text };
    const stepIndexStyle = {
      flex: '0 0 auto',
      width: '18px',
      height: '18px',
      borderRadius: '999px',
      background: COLOR.nested,
      border: '1px solid ' + COLOR.border,
      color: COLOR.muted,
      fontSize: '11px',
      lineHeight: '16px',
      textAlign: 'center',
    };
    const noteStyle = { fontSize: '12px', lineHeight: '18px', color: COLOR.muted, borderTop: '1px solid ' + COLOR.border, paddingTop: '10px' };
    const flowStyle = {
      border: '1px solid ' + COLOR.border,
      background: COLOR.raised,
      borderRadius: '14px',
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    };
    const flowTitleStyle = { fontSize: '14px', lineHeight: '20px', fontWeight: 600 };
    const flowGridStyle = { display: 'flex', flexWrap: 'wrap', gap: '12px' };
    const flowStepStyle = {
      flex: '1 1 220px',
      minWidth: '200px',
      background: COLOR.nested,
      border: '1px solid ' + COLOR.border,
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
    };
    const flowIndexStyle = {
      flex: '0 0 auto',
      width: '22px',
      height: '22px',
      borderRadius: '999px',
      background: COLOR.raised,
      border: '1px solid ' + COLOR.border,
      color: COLOR.muted,
      fontSize: '11px',
      lineHeight: '20px',
      textAlign: 'center',
    };
    const flowTextStyle = { fontSize: '12.5px', lineHeight: '19px', color: COLOR.text };

    const stateColor = (state) => {
      if (state === 'running') return COLOR.success;
      if (state === 'failed') return COLOR.error;
      if (state === 'external') return COLOR.idle;
      return COLOR.warn;
    };

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'orch-entry: dictionaries');
        const t = ctx.locale.bind(NS);

        const normalized = (value) => String(value === undefined ? '' : value).replace(/[\\/]+$/, '');

        async function requestJson(init) {
          const response = await fetch(ROUTE, Object.assign({ credentials: 'same-origin', headers: { accept: 'application/json' } }, init));
          let payload;
          try {
            payload = await response.json();
          } catch {
            payload = undefined;
          }
          if (!response.ok) {
            const detail = payload !== undefined && payload.error !== undefined ? payload.error.message : `HTTP ${response.status}`;
            throw new Error(detail);
          }
          return payload;
        }

        async function findOrCreateWorkspace(workspacePath) {
          const snapshot = ctx.workspaces.list.getSnapshot();
          const items = Array.isArray(snapshot.items) ? snapshot.items : [];
          const target = normalized(workspacePath);
          const existing = items.find((item) => normalized(item.path) === target);
          if (existing !== undefined) return existing;
          return ctx.workspaces.create({ path: workspacePath });
        }

        function enterWork(entry, translate) {
          if (typeof entry.workspace !== 'string' || entry.workspace === '') return Promise.reject(new Error(translate('enterWork')));
          const label = entry.label === undefined ? '' : entry.label;
          const prompt = `继续「${label}」管线：先用 orch_status 查看当前运行与下一步工作单，再按该项目 AGENT.md 与 dsh-orchestrator 技能执行；所有人工门必须由我本人确认，不要代选。`;
          return findOrCreateWorkspace(entry.workspace).then(
            (workspace) => ctx.uiWorkspace.startSession(workspace.workspaceId, { prompt }),
            (error) => {
              throw new Error(`${translate('workspaceCreateFailed')}: ${error instanceof Error ? error.message : String(error)}`);
            },
          );
        }

        function DashboardCard(props) {
          const { entry, translate, onOpen, onEnter, onRemove } = props;
          const external = entry.external === true;
          const meta = external
            ? entry.url
            : `${entry.workspace === null ? '' : entry.workspace}${entry.port === null ? '' : ' · 127.0.0.1:' + entry.port}`;
          const stateText = external
            ? translate('stateExternal')
            : entry.state === 'running'
              ? translate('stateRunning')
              : entry.state === 'failed'
                ? translate('stateFailed')
                : translate('stateStarting');
          return h('div', { style: dashStyle },
            h('div', { style: dashHeadStyle },
              h('span', { style: Object.assign({}, dotStyle, { background: stateColor(entry.state) }), 'aria-hidden': true }),
              h('span', null, entry.label),
              h('span', { style: Object.assign({}, hintStyle, { marginLeft: 'auto' }) }, stateText)),
            h('div', { style: dashMetaStyle }, meta),
            entry.state === 'failed' && entry.error !== null ? h('div', { style: dashErrorStyle }, entry.error) : null,
            h('div', { style: dashActionsStyle },
              h('button', { type: 'button', style: secondarySmallStyle, disabled: typeof entry.url !== 'string', onClick: () => onOpen(entry) }, translate('openBoard')),
              external ? null : h('button', { type: 'button', style: secondarySmallStyle, onClick: () => onEnter(entry) }, translate('enterWork')),
              h('button', { type: 'button', style: ghostSmallStyle, onClick: () => onRemove(entry) }, translate('remove'))));
        }

        function PipelinePage(props) {
          const translate = typeof props.t === 'function' ? props.t : t;
          const [snapshot, setSnapshot] = React.useState({ phase: 'loading', dashboards: [], error: '' });
          const [notice, setNotice] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [form, setForm] = React.useState({ label: '', workspace: '', port: '', url: '' });

          const load = () =>
            requestJson().then(
              (payload) => {
                setSnapshot({ phase: 'ready', dashboards: Array.isArray(payload.dashboards) ? payload.dashboards : [], error: '' });
              },
              (error) => {
                setSnapshot({ phase: 'error', dashboards: [], error: `${translate('loadFailed')}: ${error instanceof Error ? error.message : String(error)}` });
              },
            );

          React.useEffect(() => {
            void load();
          }, []);

          const fail = (error) => setNotice(`${translate('actionFailed')}: ${error instanceof Error ? error.message : String(error)}`);

          const openBoard = (entry) => {
            if (typeof entry.url !== 'string' || entry.url === '') return;
            window.open(entry.url, '_blank', 'noopener,noreferrer');
          };
          const onEnter = (entry) => {
            setNotice('');
            void enterWork(entry, translate).catch(fail);
          };
          const onRemove = (entry) => {
            setBusy(true);
            setNotice('');
            void requestJson({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: entry.id }) })
              .then(() => {
                setNotice(translate('removed'));
                return load();
              })
              .catch(fail)
              .then(() => setBusy(false));
          };
          const addDashboard = () => {
            const workspace = form.workspace.trim();
            const url = form.url.trim();
            if (workspace === '' && url === '') {
              setNotice(translate('addHint'));
              return;
            }
            setBusy(true);
            setNotice('');
            const body = { action: 'add', label: form.label.trim() };
            if (workspace !== '') body.workspace = workspace;
            if (url !== '') body.url = url;
            if (form.port.trim() !== '') body.port = form.port.trim();
            void requestJson({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
              .then(() => {
                setForm({ label: '', workspace: '', port: '', url: '' });
                setNotice(translate('added'));
                return load();
              })
              .catch(fail)
              .then(() => setBusy(false));
          };
          const setField = (key, value) => setForm((current) => Object.assign({}, current, { [key]: value }));

          const field = (key, labelKey, placeholderKey) =>
            h('label', { style: fieldStyle, key },
              h('span', { style: fieldLabelStyle }, translate(labelKey)),
              h('input', {
                style: inputStyle,
                type: 'text',
                value: form[key],
                placeholder: translate(placeholderKey),
                spellCheck: false,
                onChange: (event) => setField(key, event.currentTarget.value),
              }));

          const guideKeys = ['guide1', 'guide2', 'guide3', 'guide4', 'guide5', 'guide6'];
          const flowKeys = ['flow1', 'flow2', 'flow3'];

          return h('div', { style: pageStyle },
            h('div', { style: shellStyle },
              h('div', { style: headerStyle },
                h('div', { style: markStyle }, pipelineMark(20)),
                h('div', null,
                  h('div', { style: titleStyle }, translate('title')),
                  h('div', { style: subtitleStyle }, translate('intro')))),
              h('div', { style: contentStyle },
                h('div', { style: cardStyle },
                  h('div', { style: cardHeadStyle },
                    h('div', { style: cardTitleStyle }, `${translate('dashboards')}${snapshot.dashboards.length > 0 ? ' · ' + snapshot.dashboards.length : ''}`),
                    h('button', { type: 'button', style: ghostSmallStyle, disabled: busy, onClick: () => void load() }, translate('refresh'))),
                  snapshot.phase === 'loading' ? h('div', { style: hintStyle }, translate('loading')) : null,
                  snapshot.phase === 'error' ? h('div', { style: noticeStyle }, snapshot.error) : null,
                  snapshot.phase === 'ready' && snapshot.dashboards.length === 0 ? h('div', { style: hintStyle }, translate('empty')) : null,
                  h('div', { style: listStyle },
                    snapshot.dashboards.map((entry) =>
                      h(DashboardCard, {
                        key: entry.id,
                        entry,
                        translate,
                        onOpen: openBoard,
                        onEnter,
                        onRemove,
                      }))),
                  h('div', { style: noteStyle }, translate('addTitle')),
                  h('div', { style: fieldRowStyle }, field('label', 'fieldLabel', 'fieldLabelPlaceholder'), field('workspace', 'fieldWorkspace', 'fieldWorkspacePlaceholder')),
                  h('div', { style: fieldRowStyle }, field('port', 'fieldPort', 'fieldPortPlaceholder'), field('url', 'fieldUrl', 'fieldUrlPlaceholder')),
                  h('div', { style: dashActionsStyle },
                    h('button', { type: 'button', style: primarySmallStyle, disabled: busy, onClick: addDashboard }, busy ? translate('adding') : translate('add'))),
                  h('div', { style: hintStyle }, translate('addHint')),
                  notice === '' ? null : h('div', { role: 'status', style: notice === translate('added') || notice === translate('removed') ? okStyle : noticeStyle }, notice)),
                h('div', { style: guideStyle },
                  h('div', { style: guideTitleStyle }, translate('guideTitle')),
                  guideKeys.map((key, index) =>
                    h('div', { style: stepStyle, key: 'guide-' + key },
                      h('span', { style: stepIndexStyle }, String(index + 1)),
                      h('span', null, translate(key)))),
                  h('div', { style: noteStyle }, translate('guideNote')))),
              h('div', { style: flowStyle },
                h('div', { style: flowTitleStyle }, translate('flowTitle')),
                h('div', { style: flowGridStyle },
                  flowKeys.map((key, index) =>
                    h('div', { style: flowStepStyle, key: 'flow-' + key },
                      h('span', { style: flowIndexStyle }, String(index + 1)),
                      h('span', { style: flowTextStyle }, translate(key))))))),
          );
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, PipelinePage));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          locale: NS,
          label: () => t('panel'),
        }, PipelineIcon));
      },
    };
  },
});
