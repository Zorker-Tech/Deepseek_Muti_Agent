/**
 * The plugin's copy: two complete dictionaries plus the translator every surface
 * renders through. `zh` is the source of truth for the key set and `en` is typed
 * against it, so a missing or extra key is a compile error (ADR-0005 §7).
 *
 * The dictionary is registered with the harness locale service when the composition
 * installed one, and served from the local dictionary otherwise; either way `t()`
 * answers with the active language, and `subscribeLocale` lets React re-render when
 * the user switches language.
 *
 * @module @zorker/muti-agent-plugin/client/locales
 */

/** The locale namespace this plugin owns. */
export const LOCALE_NS = 'mutiagent'

/** Chinese dictionary — the source of truth for the key set. */
export const zh = {
  'common.loading': '加载中…',
  'common.errorLabel': '错误',
  'caps.panel': '能力',
  'caps.agent': '智能体',
  'caps.tools': '工具',
  'caps.skills': '技能',
  'caps.mcp': 'MCP 服务',
  'caps.commands': '指令',
  'caps.context': '上下文文件',
  'caps.none': '该智能体未声明此项。',
  'caps.modelOnly': '仅模型可用',
  'caps.disabled': '已禁用',
  'caps.readFrom': '读取自 {list}',
  'composer.model.defaultModel': '配置文件选择的模型：{name}',
  'composer.model.label': '模型',
  'composer.model.current': '模型，当前：{name}',
  'composer.model.hint': '该智能体配置文件中可用的模型。',
  'composer.model.default': '默认',
  'composer.model.fromConfig': '来自配置',
  'composer.model.fromCatalog': '来自模型目录',
  'composer.model.fromEnv': '来自环境变量',
  'composer.model.builtIn': '内置',
  'composer.model.none': '该智能体的配置文件中没有声明任何模型。',
  'composer.model.keyPresent': '密钥变量 {name} 已设置',
  'composer.model.keyMissing': '缺少密钥变量 {name}',
  'composer.model.sources': '读取自 {list}',
  'composer.agent.harness': 'Harness 自带',
  'composer.agent.label': '智能体',
  'composer.agent.locked': '本次对话已绑定 {name}，开始新对话才能更换。',
  'composer.agent.lockedLabel': '已绑定 {name}',
  'composer.agent.current': '委派目标，当前：{name}',
  'composer.agent.hint': '本次对话使用的智能体。选择后即为绑定，不可更改；按发送键始终由 Harness 自己的智能体回答。',
  'composer.agent.signedIn': '已登录',
  'composer.agent.signedOut': '未登录',
  'composer.agent.expired': '凭据已过期',
  'composer.agent.notInstalled': '未安装',
  'composer.agent.unknown': '状态未知',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.cancel': '取消',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.none': '无',
  'common.unknown': '未知',
  'common.errorCode': '错误码 {code}',
  'common.remediation': '下一步：{text}',
  'common.yes': '是',
  'common.no': '否',
  'common.copyFailed': '复制失败',

  'sessions.panel': '智能体',
  'sessions.title': '智能体会话',
  'sessions.tracked': '已纳入 {count} 个',
  'sessions.lastScan': '上次扫描 {time}',
  'sessions.filter': '按标题、路径或 ID 过滤',
  'sessions.sort': '排序',
  'sessions.sortLabel': '会话排序方式',
  'sessions.sort.updated': '更新时间',
  'sessions.sort.created': '创建时间',
  'sessions.sort.title': '标题',
  'sessions.empty': '未找到会话',
  'sessions.notScanned': '尚未扫描 — 请点击刷新',
  'sessions.untracked': '{count} 个未纳入的会话 — 显示它们',
  'sessions.hideUntracked': '隐藏未纳入的会话',
  'sessions.showingUntracked': '当前包含未纳入的会话',
  'sessions.cap': '仅显示最近 300 条；请用过滤器缩小范围。',
  'sessions.count': '{count} 个会话',
  'sessions.notInstalled': '未安装：{reason}',
  'sessions.actions': '会话操作',
  'sessions.openTranscript': '查看转录',
  'sessions.resume': '在智能体中继续',
  'sessions.track': '纳入跟踪',
  'sessions.untrack': '停止跟踪',
  'sessions.dispatch': '派发任务',
  'sessions.launchTitle': '启动命令',
  'sessions.cwdTitle': '工作目录：{path}',
  'sessions.messages': '{count} 条消息',
  'sessions.updated': '更新于 {time}',
  'sessions.refreshing': '正在刷新…',
  'sessions.installed': '已安装',
  'sessions.notInstalledBadge': '未安装',
  'sessions.modelTitle': '模型：{model}',
  'sessions.branchTitle': '分支：{branch}',

  'transcript.back': '返回会话列表',
  'transcript.window': '{shown} / {total} 条消息',
  'transcript.windowUnknown': '{shown} 条消息',
  'transcript.empty': '该会话没有可读取的消息',
  'transcript.truncated': '已截断',
  'transcript.project': '投影说明',
  'transcript.more': '读取更多',
  'transcript.paths': '文件',
  'transcript.input': '输入',
  'transcript.output': '输出',
  'transcript.failed': '失败',

  'message.user': '用户',
  'message.assistant': '助手',
  'message.reasoning': '推理',
  'message.toolCall': '工具调用',
  'message.toolResult': '工具结果',
  'message.fileChange': '文件变更',
  'message.plan': '计划',
  'message.error': '错误',
  'message.system': '系统',

  'mesh.panel': '协同',
  'mesh.title': '编排',
  'mesh.stream.open': '实时',
  'mesh.stream.down': '轮询中',
  'mesh.stream.connecting': '连接中…',
  'mesh.active': '进行中的运行',
  'mesh.active.empty': '当前没有运行中的任务',
  'mesh.runs': '最近的运行',
  'mesh.runs.empty': '尚无运行记录',
  'mesh.runs.recent': '最近 {count} 次运行',
  'mesh.cancel': '取消运行',
  'mesh.cancelConfirm': '取消运行 {id}？该智能体的进程组将被终止。',
  'mesh.cancelRequested': '已请求取消运行 {id}',
  'mesh.column.agent': '智能体',
  'mesh.column.status': '状态',
  'mesh.column.elapsed': '已用时',
  'mesh.column.worktree': '工作树',
  'mesh.column.path': '路径',
  'mesh.column.started': '开始时间',
  'mesh.column.totals': '变更',
  'mesh.column.ahead': '领先提交',
  'mesh.column.actions': '操作',
  'mesh.column.counters': '文件 / 工具调用',
  'mesh.worktrees': '工作树',
  'mesh.worktrees.empty': '尚未分配工作树',
  'mesh.repository': '仓库',
  'mesh.ahead': '领先 {count} 个提交',
  'mesh.dirty': '有未提交改动',
  'mesh.clean': '干净',
  'mesh.conflicts': '检查冲突',
  'mesh.conflicts.empty': '未发现冲突',
  'mesh.conflicts.notes': '说明',
  'mesh.conflicts.order': '建议集成顺序',
  'mesh.board': '协作看板',
  'mesh.board.none': '暂无协作',
  'mesh.board.select': '协作',
  'mesh.plan': '计划',
  'mesh.plan.objective': '目标',
  'mesh.plan.phases': '阶段',
  'mesh.plan.decisions': '决策记录',
  'mesh.plan.noPhases': '该计划还没有阶段',
  'mesh.plan.exitCriteria': '完成条件',
  'mesh.todos': '共享任务板',
  'mesh.todos.empty': '共享任务板为空',
  'mesh.todo.owner': '负责人',
  'mesh.todo.status': '状态',
  'mesh.noRepo': '请先选择一个仓库',

  'settings.panel': '智能体',
  'settings.credentials': '凭据',
  'settings.credentials.empty': '尚未注册任何智能体',
  'settings.column.agent': '智能体',
  'settings.column.state': '状态',
  'settings.column.account': '账号',
  'settings.column.credential': '凭据',
  'settings.column.actions': '操作',
  'settings.signOut': '退出登录',
  'settings.flow.oauth-loopback': '用浏览器登录',
  'settings.flow.device-code': '用设备码登录',
  'settings.flow.api-key': '输入 API 密钥',
  'settings.flow.interactive': '无法自动化',
  'settings.flow.interactiveHint': '该智能体只能在自己的终端里完成登录；请在终端中运行它的登录命令。',
  'settings.apiKey': 'API 密钥',
  'settings.apiKeySubmit': '提交密钥',
  'settings.logoutConfirm': '退出 {agent} 的登录？凭据将通过其自身的 CLI 撤销。',
  'settings.login.link': '打开登录页面',
  'settings.login.code': '验证码',
  'settings.login.instructions': '说明',
  'settings.observed': '实测状态：{status}',
  'settings.diagnostics': '诊断',
  'settings.stateDir': '状态目录',
  'settings.isolation': '隔离方式',
  'settings.isolation.worktree': '每次运行使用独立工作树',
  'settings.isolation.shared-disabled': '共享目录（隔离已禁用）',
  'settings.pluginVersion': '插件版本',
  'settings.harnessSeams': '可用的宿主服务',
  'settings.missingSeams': '缺失的宿主接缝',
  'settings.warnings': '警告',
  'settings.column.installed': '安装',
  'settings.column.version': '版本',
  'settings.column.path': '路径',
  'settings.column.transports': '通道',

  'auth.authenticated': '已登录',
  'auth.unauthenticated': '未登录',
  'auth.expired': '已过期',
  'auth.misconfigured': '需要修复',
  'auth.unknown': '未知',
  'auth.source.file': '文件',
  'auth.source.env': '环境变量',
  'auth.source.keyring': '系统钥匙串',
  'auth.source.cli-probe': 'CLI 探测',
  'auth.source.none': '无',

  'session.idle': '空闲',
  'session.running': '运行中',
  'session.missing': '已丢失',
  'session.unreadable': '无法读取',

  'run.preparing': '准备中',
  'run.running': '运行中',
  'run.succeeded': '成功',
  'run.failed': '失败',
  'run.cancelled': '已取消',
  'run.timeout': '超时',

  'task.queued': '排队中',
  'task.running': '运行中',
  'task.succeeded': '成功',
  'task.failed': '失败',
  'task.cancelled': '已取消',
  'task.blocked': '受阻',

  'phase.todo': '待办',
  'phase.active': '进行中',
  'phase.done': '已完成',

  'todo.pending': '待办',
  'todo.in_progress': '进行中',
  'todo.completed': '已完成',
  'todo.blocked': '受阻',
  'todo.cancelled': '已取消',

  'worktree.active': '活跃',
  'worktree.idle': '空闲',
  'worktree.merged': '已合并',
  'worktree.removed': '已移除',
  'worktree.orphan': '孤儿',

  'severity.info': '提示',
  'severity.warning': '警告',
  'severity.blocking': '阻塞',

  'dispatch.title': '派发任务',
  'dispatch.agent': '智能体',
  'dispatch.noAgents': '没有已安装的智能体',
  'dispatch.prompt': '任务',
  'dispatch.promptPlaceholder': '希望这个智能体做什么？',
  'dispatch.cwd': '工作目录',
  'dispatch.resume': '继续原生会话',
  'dispatch.resumePlaceholder': '新建会话',
  'dispatch.isolation': '隔离方式',
  'dispatch.isolation.worktree': '独立工作树',
  'dispatch.isolation.shared': '共享目录',
  'dispatch.model': '模型',
  'dispatch.modelPlaceholder': '适配器默认值',
  'dispatch.timeout': '超时（秒）',
  'dispatch.submit': '派发',
  'dispatch.required': '请先填写任务内容',
  'dispatch.dispatched': '已派发运行 {id}',

  'time.justNow': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',
  'time.unknown': '未知',

  'toast.region': '通知',
  'toast.dismiss': '关闭通知',

  'capabilities.tab': '能力',
  'capabilities.title': '能力清单',
  'capabilities.subtitle': '本会话绑定的智能体，以及它自己声明的工具、技能、MCP 服务器、命令与上下文文件。',
  'capabilities.binding': '绑定',
  'capabilities.binding.session': '本会话已绑定',
  'capabilities.binding.preferred': '按默认设置绑定',
  'capabilities.binding.harness': '由 Harness 自带智能体回答',
  'capabilities.binding.harnessNote': 'Harness 自己的能力界面已经描述了它：Trajectory 的“工具”页签渲染的是代理循环写入会话日志的工具目录，“/”菜单从会话自身的组合解析技能。',
  'capabilities.signIn': '登录状态',
  'capabilities.refresh': '刷新',
  'capabilities.openAgents': '打开智能体面板',
  'capabilities.observed': '读取于 {time}',
  'capabilities.sources': '读取自 {count} 个文件/目录',
  'capabilities.sourcesTitle': '读取来源',
  'capabilities.notes': '投影说明',
  'capabilities.tools': '工具',
  'capabilities.skills': '技能',
  'capabilities.mcp': 'MCP 服务器',
  'capabilities.commands': '命令',
  'capabilities.contextFiles': '上下文文件',
  'capabilities.count.tools': '{count} 个工具',
  'capabilities.count.skills': '{count} 个技能',
  'capabilities.count.mcp': '{count} 个服务器',
  'capabilities.count.commands': '{count} 个命令',
  'capabilities.count.contextFiles': '{count} 个文件',
  'capabilities.empty': '该智能体没有声明这一项。',
  'capabilities.capped': '仅显示前 {shown} 项，共 {total} 项。',
  'capabilities.column.name': '名称',
  'capabilities.column.description': '说明',
  'capabilities.column.source': '来源',
  'capabilities.column.approval': '审批',
  'capabilities.column.transport': '传输',
  'capabilities.column.endpoint': '端点',
  'capabilities.column.enabled': '启用',
  'capabilities.column.userInvocable': '用户可调用',
  'capabilities.source.builtin': '内置',
  'capabilities.source.config': '配置',
  'capabilities.source.project': '项目',
  'capabilities.source.user': '用户',
  'capabilities.source.extension': '扩展',
  'capabilities.source.mcp': 'MCP',
  'capabilities.source.plugin': '插件',
  'capabilities.source.bundled': '随附',
  'capabilities.source.other': '其他',
  'capabilities.approval.none': '—',
  'capabilities.discoverable': '按需加载',
} as const

/** Message key union, derived from the Chinese dictionary. */
export type MessageKey = keyof typeof zh

/** English dictionary; typed against {@link zh} so both key sets stay identical. */
export const en: Readonly<Record<MessageKey, string>> = {
  'common.loading': 'Loading…',
  'common.errorLabel': 'Error',
  'caps.panel': 'Capabilities',
  'caps.agent': 'Agent',
  'caps.tools': 'Tools',
  'caps.skills': 'Skills',
  'caps.mcp': 'MCP servers',
  'caps.commands': 'Commands',
  'caps.context': 'Context files',
  'caps.none': 'This agent declares none.',
  'caps.modelOnly': 'model only',
  'caps.disabled': 'disabled',
  'caps.readFrom': 'read from {list}',
  'composer.model.defaultModel': 'model selected by its configuration: {name}',
  'composer.model.label': 'Model',
  'composer.model.current': 'Model, current: {name}',
  'composer.model.hint': 'Models the selected agent can run, as its configuration file declares them.',
  'composer.model.default': 'default',
  'composer.model.fromConfig': 'from config',
  'composer.model.fromCatalog': 'from catalog',
  'composer.model.fromEnv': 'from environment',
  'composer.model.builtIn': 'built in',
  'composer.model.none': 'This agent\'s configuration declares no models.',
  'composer.model.keyPresent': 'key variable {name} is set',
  'composer.model.keyMissing': 'key variable {name} is missing',
  'composer.model.sources': 'read from {list}',
  'composer.agent.harness': 'Harness (built-in)',
  'composer.agent.label': 'Agent',
  'composer.agent.locked': 'This conversation is bound to {name}; start a new one to use another agent.',
  'composer.agent.lockedLabel': 'Bound to {name}',
  'composer.agent.current': 'Delegation target, current: {name}',
  'composer.agent.hint': 'The agent this conversation delegates to. The choice binds on first use and does not change; pressing send still reaches the harness agent.',
  'composer.agent.signedIn': 'signed in',
  'composer.agent.signedOut': 'not signed in',
  'composer.agent.expired': 'credential expired',
  'composer.agent.notInstalled': 'not installed',
  'composer.agent.unknown': 'state unknown',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.none': 'None',
  'common.unknown': 'Unknown',
  'common.errorCode': 'Error {code}',
  'common.remediation': 'Next: {text}',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.copyFailed': 'Copy failed',

  'sessions.panel': 'Agents',
  'sessions.title': 'Agent sessions',
  'sessions.tracked': '{count} tracked',
  'sessions.lastScan': 'Last scan {time}',
  'sessions.filter': 'Filter by title, path or id',
  'sessions.sort': 'Sort',
  'sessions.sortLabel': 'Session sort order',
  'sessions.sort.updated': 'Updated',
  'sessions.sort.created': 'Created',
  'sessions.sort.title': 'Title',
  'sessions.empty': 'No sessions found',
  'sessions.notScanned': 'Not scanned yet — press Refresh',
  'sessions.untracked': '{count} untracked sessions — show them',
  'sessions.hideUntracked': 'Hide untracked sessions',
  'sessions.showingUntracked': 'Including untracked sessions',
  'sessions.cap': 'Showing the 300 most recent; use the filter to narrow.',
  'sessions.count': '{count} sessions',
  'sessions.notInstalled': 'not installed: {reason}',
  'sessions.actions': 'Session actions',
  'sessions.openTranscript': 'Open transcript',
  'sessions.resume': 'Resume in agent',
  'sessions.track': 'Track',
  'sessions.untrack': 'Untrack',
  'sessions.dispatch': 'Dispatch task',
  'sessions.launchTitle': 'Launch command',
  'sessions.cwdTitle': 'Working directory: {path}',
  'sessions.messages': '{count} messages',
  'sessions.updated': 'Updated {time}',
  'sessions.refreshing': 'Refreshing…',
  'sessions.installed': 'installed',
  'sessions.notInstalledBadge': 'Not installed',
  'sessions.modelTitle': 'Model: {model}',
  'sessions.branchTitle': 'Branch: {branch}',

  'transcript.back': 'Back to sessions',
  'transcript.window': '{shown} of {total} messages',
  'transcript.windowUnknown': '{shown} messages',
  'transcript.empty': 'This session has no readable messages',
  'transcript.truncated': 'truncated',
  'transcript.project': 'Projection notes',
  'transcript.more': 'Read more',
  'transcript.paths': 'Files',
  'transcript.input': 'Input',
  'transcript.output': 'Output',
  'transcript.failed': 'failed',

  'message.user': 'User',
  'message.assistant': 'Assistant',
  'message.reasoning': 'Reasoning',
  'message.toolCall': 'Tool call',
  'message.toolResult': 'Tool result',
  'message.fileChange': 'File change',
  'message.plan': 'Plan',
  'message.error': 'Error',
  'message.system': 'System',

  'mesh.panel': 'Mesh',
  'mesh.title': 'Orchestration',
  'mesh.stream.open': 'Live',
  'mesh.stream.down': 'Polling',
  'mesh.stream.connecting': 'Connecting…',
  'mesh.active': 'Active runs',
  'mesh.active.empty': 'No runs in flight',
  'mesh.runs': 'Recent runs',
  'mesh.runs.empty': 'No runs recorded yet',
  'mesh.runs.recent': 'The last {count} runs',
  'mesh.cancel': 'Cancel run',
  'mesh.cancelConfirm': 'Cancel run {id}? The agent process group is terminated.',
  'mesh.cancelRequested': 'Cancellation requested for run {id}',
  'mesh.column.agent': 'Agent',
  'mesh.column.status': 'Status',
  'mesh.column.elapsed': 'Elapsed',
  'mesh.column.worktree': 'Worktree',
  'mesh.column.path': 'Path',
  'mesh.column.started': 'Started',
  'mesh.column.totals': 'Changes',
  'mesh.column.ahead': 'Ahead',
  'mesh.column.actions': 'Actions',
  'mesh.column.counters': 'Files / calls',
  'mesh.worktrees': 'Worktrees',
  'mesh.worktrees.empty': 'No worktrees allocated',
  'mesh.repository': 'Repository',
  'mesh.ahead': 'ahead {count}',
  'mesh.dirty': 'uncommitted changes',
  'mesh.clean': 'clean',
  'mesh.conflicts': 'Check conflicts',
  'mesh.conflicts.empty': 'No conflicts found',
  'mesh.conflicts.notes': 'Notes',
  'mesh.conflicts.order': 'Suggested order',
  'mesh.board': 'Collaboration board',
  'mesh.board.none': 'No collaborations yet',
  'mesh.board.select': 'Collaboration',
  'mesh.plan': 'Plan',
  'mesh.plan.objective': 'Objective',
  'mesh.plan.phases': 'Phases',
  'mesh.plan.decisions': 'Decisions',
  'mesh.plan.noPhases': 'This plan has no phases yet',
  'mesh.plan.exitCriteria': 'Exit criteria',
  'mesh.todos': 'Shared board',
  'mesh.todos.empty': 'The shared board is empty',
  'mesh.todo.owner': 'Owner',
  'mesh.todo.status': 'Status',
  'mesh.noRepo': 'Select a repository first',

  'settings.panel': 'Agents',
  'settings.credentials': 'Credentials',
  'settings.credentials.empty': 'No agents are registered',
  'settings.column.agent': 'Agent',
  'settings.column.state': 'Status',
  'settings.column.account': 'Account',
  'settings.column.credential': 'Credential',
  'settings.column.actions': 'Actions',
  'settings.signOut': 'Sign out',
  'settings.flow.oauth-loopback': 'Sign in with browser',
  'settings.flow.device-code': 'Sign in with a device code',
  'settings.flow.api-key': 'Enter an API key',
  'settings.flow.interactive': 'Cannot be automated',
  'settings.flow.interactiveHint':
    'This agent can only be signed in from its own terminal; run its sign-in command there.',
  'settings.apiKey': 'API key',
  'settings.apiKeySubmit': 'Submit key',
  'settings.logoutConfirm': 'Sign out of {agent}? The credential is revoked through its own CLI.',
  'settings.login.link': 'Open sign-in page',
  'settings.login.code': 'Code',
  'settings.login.instructions': 'Instructions',
  'settings.observed': 'Observed state: {status}',
  'settings.diagnostics': 'Diagnostics',
  'settings.stateDir': 'State directory',
  'settings.isolation': 'Isolation',
  'settings.isolation.worktree': 'per-run worktree',
  'settings.isolation.shared-disabled': 'shared directory (isolation disabled)',
  'settings.pluginVersion': 'Plugin version',
  'settings.harnessSeams': 'Harness services',
  'settings.missingSeams': 'Missing seams',
  'settings.warnings': 'Warnings',
  'settings.column.installed': 'Installed',
  'settings.column.version': 'Version',
  'settings.column.path': 'Path',
  'settings.column.transports': 'Transports',

  'auth.authenticated': 'Signed in',
  'auth.unauthenticated': 'Not signed in',
  'auth.expired': 'Expired',
  'auth.misconfigured': 'Needs repair',
  'auth.unknown': 'Unknown',
  'auth.source.file': 'file',
  'auth.source.env': 'env',
  'auth.source.keyring': 'keyring',
  'auth.source.cli-probe': 'cli probe',
  'auth.source.none': 'none',

  'session.idle': 'Idle',
  'session.running': 'Running',
  'session.missing': 'Missing',
  'session.unreadable': 'Unreadable',

  'run.preparing': 'Preparing',
  'run.running': 'Running',
  'run.succeeded': 'Succeeded',
  'run.failed': 'Failed',
  'run.cancelled': 'Cancelled',
  'run.timeout': 'Timed out',

  'task.queued': 'Queued',
  'task.running': 'Running',
  'task.succeeded': 'Succeeded',
  'task.failed': 'Failed',
  'task.cancelled': 'Cancelled',
  'task.blocked': 'Blocked',

  'phase.todo': 'Todo',
  'phase.active': 'Active',
  'phase.done': 'Done',

  'todo.pending': 'Pending',
  'todo.in_progress': 'In progress',
  'todo.completed': 'Completed',
  'todo.blocked': 'Blocked',
  'todo.cancelled': 'Cancelled',

  'worktree.active': 'Active',
  'worktree.idle': 'Idle',
  'worktree.merged': 'Merged',
  'worktree.removed': 'Removed',
  'worktree.orphan': 'Orphan',

  'severity.info': 'Info',
  'severity.warning': 'Warning',
  'severity.blocking': 'Blocking',

  'dispatch.title': 'Dispatch task',
  'dispatch.agent': 'Agent',
  'dispatch.noAgents': 'No agents are installed',
  'dispatch.prompt': 'Task',
  'dispatch.promptPlaceholder': 'What should the agent do?',
  'dispatch.cwd': 'Working directory',
  'dispatch.resume': 'Resume native session',
  'dispatch.resumePlaceholder': 'new session',
  'dispatch.isolation': 'Isolation',
  'dispatch.isolation.worktree': 'Isolated worktree',
  'dispatch.isolation.shared': 'Shared directory',
  'dispatch.model': 'Model',
  'dispatch.modelPlaceholder': 'adapter default',
  'dispatch.timeout': 'Timeout (seconds)',
  'dispatch.submit': 'Dispatch',
  'dispatch.required': 'Enter a task first',
  'dispatch.dispatched': 'Run {id} dispatched',

  'time.justNow': 'just now',
  'time.minutes': '{count}m ago',
  'time.hours': '{count}h ago',
  'time.days': '{count}d ago',
  'time.unknown': 'unknown',

  'toast.region': 'Notifications',
  'toast.dismiss': 'Dismiss',

  'capabilities.tab': 'Capabilities',
  'capabilities.title': 'Capability inventory',
  'capabilities.subtitle': 'The agent this conversation is bound to, and the tools, skills, MCP servers, commands and context files it declares.',
  'capabilities.binding': 'Binding',
  'capabilities.binding.session': 'bound in this conversation',
  'capabilities.binding.preferred': 'from the operator default',
  'capabilities.binding.harness': 'answered by the harness agent',
  'capabilities.binding.harnessNote': 'The harness\'s own capability surfaces already describe it: the Trajectory "Tools" tab renders the tool catalog the agent loop logged for this session, and the "/" menu resolves skills from the session\'s own composition.',
  'capabilities.signIn': 'Sign-in',
  'capabilities.refresh': 'Refresh',
  'capabilities.openAgents': 'Open the Agents panel',
  'capabilities.observed': 'read {time}',
  'capabilities.sources': 'read from {count} file(s) or directory(ies)',
  'capabilities.sourcesTitle': 'Where this came from',
  'capabilities.notes': 'Projection notes',
  'capabilities.tools': 'Tools',
  'capabilities.skills': 'Skills',
  'capabilities.mcp': 'MCP servers',
  'capabilities.commands': 'Commands',
  'capabilities.contextFiles': 'Context files',
  'capabilities.count.tools': '{count} tools',
  'capabilities.count.skills': '{count} skills',
  'capabilities.count.mcp': '{count} servers',
  'capabilities.count.commands': '{count} commands',
  'capabilities.count.contextFiles': '{count} files',
  'capabilities.empty': 'This agent declares none of these.',
  'capabilities.capped': 'Showing the first {shown} of {total}.',
  'capabilities.column.name': 'Name',
  'capabilities.column.description': 'Description',
  'capabilities.column.source': 'Source',
  'capabilities.column.approval': 'Approval',
  'capabilities.column.transport': 'Transport',
  'capabilities.column.endpoint': 'Endpoint',
  'capabilities.column.enabled': 'Enabled',
  'capabilities.column.userInvocable': 'User-invocable',
  'capabilities.source.builtin': 'built in',
  'capabilities.source.config': 'config',
  'capabilities.source.project': 'project',
  'capabilities.source.user': 'user',
  'capabilities.source.extension': 'extension',
  'capabilities.source.mcp': 'MCP',
  'capabilities.source.plugin': 'plugin',
  'capabilities.source.bundled': 'bundled',
  'capabilities.source.other': 'other',
  'capabilities.approval.none': '—',
  'capabilities.discoverable': 'loaded on demand',
}

/** Both dictionaries, keyed by the built-in locale ids the harness knows. */
export const DICTS: Readonly<Record<'zh' | 'en', Readonly<Record<MessageKey, string>>>> = { zh, en }

/** A translate function over this plugin's key space. */
export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string

/** The subset of the harness locale service this plugin uses, structurally. */
export interface LocaleServiceLike {
  /**
   * @param ns - namespace to own.
   * @param dicts - one dictionary per built-in locale id.
   * @returns a disposer when the service supports removal.
   */
  register(
    ns: string,
    dicts: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): (() => void) | void
  /**
   * @param ns - a registered namespace.
   * @returns A translate function that reads the active locale at call time.
   */
  bind(ns: string): (key: string, params?: Readonly<Record<string, string | number>>) => string
  /** @returns the current locale snapshot, when the service exposes one. */
  getSnapshot?: () => { readonly active: string; readonly revision: number }
  /**
   * @param listener - called on every locale or dictionary change.
   * @returns unsubscribe.
   */
  subscribe?: (listener: () => void) => () => void
}

type LocalTranslate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

let service: LocaleServiceLike | undefined
let bound: LocalTranslate | undefined
let revision = 0
const listeners = new Set<() => void>()

/**
 * Read the language the plugin falls back to when the harness locale service is
 * absent: the browser's own preference, reduced to the two shipped dictionaries.
 *
 * @returns `'zh'` for a Chinese browser, `'en'` otherwise.
 */
function browserLocale(): 'zh' | 'en' {
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * The language `t()` resolves against.
 *
 * @returns The harness's active locale when it exposes one, else {@link browserLocale}.
 */
export function activeLocale(): string {
  const snapshot = service?.getSnapshot?.()
  return snapshot === undefined ? browserLocale() : snapshot.active
}

/**
 * Substitute `{name}` placeholders.
 *
 * @param template - The dictionary entry.
 * @param params - Values to substitute.
 * @returns The interpolated string; unknown placeholders stay verbatim.
 */
function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>> | undefined,
): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Translate from the local dictionary.
 *
 * @param key - Message key.
 * @param params - Interpolation values.
 * @returns The text for the active locale, or the key when it is unknown.
 */
function local(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
  const template: string | undefined = dict[key] ?? en[key]
  return interpolate(template ?? key, params)
}

/**
 * Translate one message key. Always available, whether or not the harness locale
 * service exists, because the local dictionary is the floor.
 *
 * @param key - Message key from {@link zh}.
 * @param params - Interpolation values for `{name}` placeholders.
 * @returns The user-visible text.
 */
export const t: Translate = (key, params) => {
  if (bound === undefined) return local(key, params)
  const text = bound(key, params)
  // A namespace collision or a partially registered dictionary must not leak a
  // raw key into the UI, so a miss falls back to the local dictionary.
  return text === key ? local(key, params) : text
}

/**
 * @param listener - Called whenever the active language or the dictionaries change.
 * @returns Unsubscribe.
 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * @returns A revision that changes on every locale change; safe for
 *   `useSyncExternalStore`.
 */
export function localeRevision(): number {
  return revision
}

/**
 * Adopt the harness locale service: register the dictionaries and bind to it.
 *
 * @param locale - The locale service, when the composition installed one.
 * @returns A disposer that unregisters the dictionaries and drops the binding.
 */
export function installLocale(locale: LocaleServiceLike | undefined): () => void {
  if (locale === undefined) return () => {}
  service = locale
  const disposers: (() => void)[] = []
  try {
    const dispose = locale.register(LOCALE_NS, DICTS)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch {
    // A duplicate (ns, locale) pair means an earlier load already owns it; the
    // dictionaries are still readable through the service, so binding succeeds.
  }
  try {
    const harness = locale.bind(LOCALE_NS)
    bound = (key, params) => harness(key, params)
  } catch {
    bound = undefined
  }
  const unsubscribe = locale.subscribe?.(() => {
    revision += 1
    for (const listener of listeners) listener()
  })
  if (unsubscribe !== undefined) disposers.push(unsubscribe)
  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
    if (service === locale) {
      service = undefined
      bound = undefined
    }
  }
}
