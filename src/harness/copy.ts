// Every user-facing string the multi-harness design defines, by group and key. English is canonical;
// the Chinese from the design sits in the trailing comment. Placeholders are {name}; fill them with fmt().
// `why` is the capability reason table: keys are `<layer>.<code>` exactly as caps.ts emits them
// (see whyText in caps.ts); a code with no line of its own falls back to its layer's line.
import { ownTable } from '../../shared/ownTable.mjs';
import { FAST_BLOCKED_TEXT } from './types';
import { DIVIDER_BACK } from '../../shared/handoff.mjs';
import { computerPermissionRecovery } from '../../shared/computerPermissionRecovery.mjs';

const ADMISSION_FAILURE = "Installed · Can't run in MoPilot";

/** Reasons a control is greyed out: one sentence of reason · one action. */
export const WHY: Record<string, string> = ownTable({
  'harness.undeclared': "{label} doesn't support {feature}",
  'harness.noRemoteControl': 'Not available for this chat',
  'account.remoteControlNeedsClaudeAi': 'Remote Control needs a claude.ai Pro, Max, Team or Enterprise login. Choose one in Accounts.',
  'harness.noArtifacts': "This chat's harness can't publish artifacts or designs.",
  'harness.feedbackTerminalOnly': "Claude Code only takes feedback in its own terminal. Your message wasn't sent.", // Claude Code 的反馈只能在它自己的终端里提交。你的输入没有发送。
  'version.probeFailed': '{label} {version} changed how {feature} works · Update MoPilot', // Claude Code {version} 改了{功能}的接口 · 更新 MoPilot
  'version.incompatible': "{label} {version} doesn't work with this version of MoPilot. Update it.", // Claude Code {version} 与这个版本的 MoPilot 不兼容。请更新它。
  'provider.noFast': "{provider} doesn't support Fast", // DeepSeek 不支持 Fast
  'provider.noFast.mopilot': "Fast isn't available on MoPilot yet · Use your {account}", // MoPilot 还不支持 Fast · 用 Claude 订阅 ({account}: the harness's own plan)
  'provider.unsupported': "{provider} doesn't support {feature}",
  'model.noFast': "This model doesn't support Fast · Switch model",
  'model.noMultiAgent': "This model can't run multiple agents · Switch model",
  'model.noEffort': 'This model has no reasoning effort settings · Switch model',
  'model.noAutoApprove': "This model can't auto-approve · Switch model", // 这个模型不支持自动审批 · 换模型
  ...Object.fromEntries(Object.entries(FAST_BLOCKED_TEXT).map(([k, v]) => [`account.noFast.${k}`, v])),
  'account.noFast.unavailable': "Fast isn't available on this account",
  'harness.noAudioInput': 'This agent has not declared support for audio messages. Use Dictate to send text.',
  'harness.noVoiceConversation': 'Native voice conversation is not connected for this chat. Use Dictate to speak your message.',
  'account.remoteControlNeedsChatGPT': 'Remote Control needs a signed-in ChatGPT account. Choose one in Accounts.',
  'account.dictationNeeds.chatgpt': "Dictation with this chat's account needs a signed-in ChatGPT account. Dictation uses another service.",
  'account.dictationNeeds.login': "Dictation with this chat's account needs a signed-in account. Dictation uses another service.",
  'harness.noNativeDictation': "This chat's harness has no dictation of its own. Dictation uses another service.",
  'account.voiceChatRequiresChatGPT': 'Voice chat needs a signed-in ChatGPT account. Choose one in Accounts.',
  'account.artifactsNeedClaudeAi': 'Artifacts and designs need a claude.ai Pro, Max, Team or Enterprise login. Choose one in Accounts.',
  'flag.off.goal': 'Goals are off in {label} · Turn on goals', // Codex 里的目标功能已关闭 · 开启目标
  'flag.off.memory': 'Memories are off in {label} · Turn on memories',
  'flag.killed': '{feature} is turned off for now',
  'flag.killed.harness': '{label} is turned off for now',
  'flag.artifactsUserOff': 'Artifacts and designs are off in {label} · Turn them on in Settings',
  'flag.killed.channel': "{label} can't be given {feature} right now",
  'session.temporaryGoal': "Temporary chats can't have goals · Start a regular chat", // 临时对话不能设目标 · 新建普通对话
  'session.runningElsewhere': 'This chat is running in another app', // 这个对话正在其他应用里运行
  'session.turnRunning': 'Wait for this turn to finish', // 等当前回合结束
  'session.artifactsStarted': 'This chat started before artifacts and designs were turned on · Start a new chat',
  'session.artifactsOff': '{label} has no Artifact tool in this chat · Check CLAUDE_CODE_ARTIFACT and enableArtifact in its settings',
  'session.noCheckpoints': 'Created before checkpoints · Fork from here instead', // 这个对话创建于开启检查点之前 · 改为从这里分叉
});

/** One line per layer for a code that has none of its own. */
export const WHY_FALLBACK: Record<string, string> = ownTable({
  harness: "{label} doesn't support {feature}",
  version: '{label} {version} changed how {feature} works · Update MoPilot',
  provider: "{provider} doesn't support {feature}",
  model: "This model doesn't support {feature} · Switch model",
  account: "Your account doesn't include {feature}",
  flag: '{feature} is turned off',
  session: 'Not available right now',
});

export const COPY = {
  label: {
    /** Capability label: Sage polyfill (/ menu descriptions, GoalBar, plan card) */
    polyfill: 'by MoPilot', // 由 MoPilot 提供
  },
  commands: {
    /** Init menu item (Codex) */
    initCodex: 'Create AGENTS.md for Codex · by MoPilot', // 为 Codex 创建 AGENTS.md · 由 MoPilot 提供
    /** Init option (the other instructions file already exists) */
    initOtherFileExists: 'AGENTS.md exists · Let Claude Code read it instead (recommended)', // 已有 AGENTS.md · 让 Claude Code 改读它（推荐）
    /** Basic tier: typing a command that is not in the command catalog */
    notInCatalog: "{label} doesn't list /{name} · Send as plain text", // {label} 的命令列表里没有 /{name} · 作为普通文字发送
    /** Typing an unknown command in a Codex thread */
    unknownCodex: "Codex doesn't have this command · Send as plain text", // Codex 没有这个命令 · 作为普通文字发送
    /** Bottom of the / menu (when some items are hidden) */
    someHidden: "Some commands are only on other harnesses · See what's different", // 有些命令只在其他 harness 上有 · 查看差异
    /** Description of Claude's /schedule in the / menu */
    claudeSchedule: 'Cloud routine on claude.ai (not in MoPilot Scheduled)', // claude.ai 上的云端例程（不在 MoPilot 的定时任务里）
  },
  fast: {
    /** Tier list (a Codex model with more than one service tier): its label, and the Standard row */
    speed: 'Speed', // 速度
    standard: 'Standard', // 标准
    standardNote: 'Default speed and rate', // 默认速度和费率
    /** Fast control · a Codex API key pays the priority rate for every Fast turn */
    apiKeyBilling: 'On an API key, Fast is billed at the higher priority rate', // 用 API key 时，Fast 按更高的优先级费率计费
  },
  goalBar: {
    /** GoalBar · Codex (native) */
    codex: 'Goal: {condition} · {n} rounds · {b} token budget (soft, checked between turns)  [Pause] [Edit] [Clear]', // 目标：{条件} · 已用 {n} 轮 · 预算 {b} tokens（软上限，按回合结算）  [暂停] [编辑] [清除]
    /** GoalBar · Claude running */
    claudeRunning: 'Goal: {condition} · round {n}  [Pause] [Clear]', // 目标：{条件} · 第 {n} 轮  [暂停] [清除]
    /** GoalBar · Claude paused (held by Sage) */
    claudePaused: 'Goal paused (kept by MoPilot) · Round count restarts when resumed  [Resume] [Clear]', // 目标已暂停（由 MoPilot 记住）· 恢复后轮数重新计  [恢复] [清除]
    /** GoalBar · reached the limit set by Sage */
    limitReached: 'Reached the limit (30 rounds). Goal paused · Limit set by MoPilot  [10 more rounds] [Clear]', // 已达到上限（30 轮），目标已暂停 · 上限由 MoPilot 设置  [再给 10 轮] [清除]
    /** Claude goal-check note (collapsed Stop hook feedback) */
    claudeCheckNote: 'Goal check #{n}: {reason}', // 目标检查 #{n}：{原因}
    /** Goal changed externally */
    changedExternally: 'Goal changed in another app', // 目标在其他应用里被改了
  },
  stop: {
    /** Stop button tooltip (first-class harness) */
    tooltip: 'Stop this turn and pause the goal · Background tasks keep running (press Esc again to stop all)', // 停止本轮并暂停目标 · 后台任务继续运行（再按一次 Esc 可全部停止）
    /** Confirmation on the second Esc */
    confirmAll: 'Stop all {n} background tasks?', // 停止全部 {n} 个后台任务？
  },
  routing: {
    voiceInput: 'Voice input',
    voiceConversation: 'Voice conversation',
    /** Routing chip · new chat (Cloud) */
    chipCloud: 'This new chat uses Codex Cloud (ChatGPT · {account}) · Undo', // 这条新对话会用 Codex Cloud（ChatGPT · {账号}）· 撤销
    /** Routing chip · the default harness for ⇧⌘N is a basic-tier harness */
    chipTemporary: "This temporary chat uses {harness} ({account}) · {label} can't keep chats off disk · Undo", // 这条临时对话会用 {harness}（{账号}）· {label} 不支持不落盘的对话 · 撤销
    /** Routing confirmation · first cross-vendor use (voice) */
  },
  harness: {
    /** Harness exited midway */
    exitedMidway: '{label} quit while working. Pending approvals were cancelled · Your queued messages are kept', // {label} 在工作中退出了。挂着的审批已取消 · 排队的消息还在
    /** Basic-tier badge and hover */
    basicBadge:
      "Limited · Chat, approvals, computer and browser control work. Goal, plan and review work only if {label} has them. See what's different", // 部分功能 · 聊天、审批、电脑和浏览器控制都能用；目标、计划和审查只在 {label} 自己有时才能用。查看差异
    /** Basic-tier admission failure (Other harnesses page) */
    admissionFailed: `${ADMISSION_FAILURE} · {reason}`,
    /** Admission failure reason · tool injection */
    admissionToolInjection: "MoPilot can't give it computer and browser control", // MoPilot 无法为它提供电脑和浏览器控制
    /** Admission failure reason · dsh privacy gate */
    admissionDshPrivacy: "This dsh version can't turn off session log upload", // 这个 dsh 版本无法关闭会话日志上传
    /** Permissions menu for a basic-tier harness with no command catalog */
    permissionsSetByHarness: 'Set by {label}', // 由 {label} 决定
    /** Its hover: the harness declares no permission modes over ACP (it may still have modes of its own) */
    permissionsNoModes: '{label} runs under its own permission settings', // {label} 按它自己的权限设置运行
    /** Its hover while one of the agent's own modes is current */
    permissionsSetByMode: '{mode} runs under {label}’s own permission settings', // {mode} 按 {label} 自己的权限设置运行
    /** The agent-mode chip while no agent mode is current */
    agentModeNone: 'Mode', // 模式
    /** The agent-mode menu's title */
    agentModesTitle: '{label} modes', // {label} 的模式
    /** Its hover: nothing known yet (no session has opened on it) */
    permissionsModesUnknown: '{label} lists its modes once a chat on it opens; until then it runs under its own permission settings', // {label} 在打开聊天后才列出它的模式；在此之前按它自己的权限设置运行
  },
  switchSheet: {
    /** SwitchSheet three-column headings */
    columns: 'Comes along / Stays behind / Changes', // 会带过去 / 不会带过去 / 会变化
    /** SwitchSheet row · goal (across harnesses) */
    goal: 'Goal "{condition}" pauses on {from}  ☐ Continue this goal on {to}', // 目标“{条件}”会在 {from} 上暂停  ☐ 在 {to} 上继续这个目标
    /** SwitchSheet row · account and where data goes */
    account: 'Account: {account} · Your next messages and the handoff summary go to {vendor}', // 账号：{账号}· 之后的消息和交接摘要发给 {厂商}
    /** SwitchSheet row · effort mapping */
    effort: 'Effort: {from} → {to}', // 推理强度：{原档} → {新档}
    /** SwitchSheet row · multi-agent */
    multiAgent: '☐ Keep multiple agents on (uses noticeably more tokens)', // ☐ 保持多 agent 开启（token 消耗会明显增加）
    /** SwitchSheet row · permissions become stricter */
    permissionsStricter: "Approve for me → Ask for approval (this model can't auto-approve)", // 自动批准 → 询问批准（这个模型不支持自动审批）
    /** SwitchSheet row · queued messages */
    queued: '{n} queued messages · ○ Send after switching  ○ Leave them here', // {n} 条排队消息 · ○ 切换后发出  ○ 留在这里
    /** SwitchSheet · goal for a basic-tier harness */
    goalBasic: '{label} may still have a goal running', // {label} 里可能还有进行中的目标
    /** Divider when switching back to a harness used before */
    dividerBack: DIVIDER_BACK,
    /** The only option when switching to a basic-tier harness */
    newChatWithSummary: 'New chat with summary', // 新对话加摘要
  },
  accounts: {
    /** Chat note after an automatic account switch */
    autoSwitchNote: 'Max limit reached. Continued on {account} · Goal and plan mode carried over', // Max 额度已用完，已换到 {账号} 继续 · 目标和计划模式已带过来

    /** Account row · the CLI's own login whose account another app renamed */
    unverified: 'Account unverified', // 账号未确认
    /** Account name · that login, while its account is not confirmed */
    unverifiedName: 'Claude Code login', // Claude Code 登录
    /** Button that signs that login in again to confirm its account */
    verify: 'Sign in again to confirm', // 重新登录以确认
    /** Account row · an added login whose config folder moved, so the CLI can't find its sign-in */
    reconfirm: 'Needs to be confirmed again',
    /** Account row · an added login whose sign-in is another account than the one it was added as */
    otherAccount: 'Signed in as another account',
    /** Note under that row: which account it was added as, and what to do */
    otherAccountWhy: 'Added as {addedAs}. Sign in again as {addedAs} to use that account here.',
    /** Toast when a login's sign-in turns out to be another account: {email} is the one it is, {addedAs} the one added */
    otherAccountNotice: '{addedAs} is signed in as {email}. Sign in again as {addedAs} in Accounts & billing.',
    /** The same, for a login whose added account has no email */
    otherAccountNoticeUnnamed: 'An added Claude login is signed in as {email}. Sign in again in Accounts & billing.',
    /** Note under that row: why, and what Sign in again does */
    reconfirmWhy: 'Its data folder moved. Sign in again to confirm it.',
  },
  models: {
    /** Bottom of the permissions menu */
    permissionsFootnote: 'This chat only', // 只改这个对话
    /** Model picker · text-only model badge */
    textOnlyBadge: 'Text only', // 纯文本
  },
  settings: {
    /** Codex settings page · the two config.toml items */
    codexConfigTomlOnly: 'Only affects Codex outside MoPilot', // 只影响 MoPilot 外的 Codex
    /** Renamed Settings sidebar group */
    builtInToolsGroup: 'Built-in tools', // 内置工具
    /** Settings basic-tier page */
    otherHarnessesPage: 'Other agents', // 其他 agent
  },
  onboarding: {
    /** onboarding · payment method */
    payment:
      'How do you want to pay for AI?  MoPilot credits (no other account needed) / My Claude subscription / My ChatGPT account / An API key', // 你想怎么为 AI 付费？  MoPilot credits（不需要其他账号）/ 我的 Claude 订阅 / 我的 ChatGPT 账号 / API key
    /** onboarding · one-click install */
    install: "MoPilot will run this official install command in the terminal below: {cmd}  [Install] [I'll do it myself]", // MoPilot 会在下面的终端里运行这条官方安装命令：{cmd}  [安装] [我自己装]
    /** onboarding · choose the default harness */
    defaultHarness: 'Which one should new chats use?', // 新对话默认用哪个？
  },
  computerUse: {
    /** CU · activity bar */
    activityBar: 'Using {App} · Esc to stop', // 正在使用 {App} · Esc 停止
    /** CU · after the user takes over */
    tookOver: 'You took over. The agent is paused · Resume', // 你接管了，agent 已暂停 · 继续
    /** CU · desktop lock queue */
    lockQueue: 'Another chat is using your Mac · View', // 另一个对话正在使用你的 Mac · 查看
    /** CU · fixed items in the tray menu */
    trayStop: 'Stop controlling your Mac', // 停止操控电脑
    /** Activity bar when a text-only model takes a screenshot */
    visionModelReads: '{vision model} reads the screen · Screenshots go to {vendor}', // 由 {视觉模型} 识别屏幕 · 截图发往 {厂商}
    /** Card · first time screenshots go to a vision model of another vendor */
    visionConsent: '{vision model} will read screenshots of {App} for {Harness}. Screenshots go to {vendor}.', // 由 {视觉模型} 为 {Harness} 识别 {App} 的截图。截图发往 {厂商}。
    /** CU · in-chat guide when a tool fails for a missing permission */
    permissionAccessibility: 'Allow Accessibility so {Harness} can click and type.', // 允许辅助功能，{Harness} 才能点击和输入。
    permissionScreenRecording: 'Allow Screen Recording so {Harness} can see the screen.',
    permissionInputMonitoring: 'Allow Input Monitoring so moving the mouse takes over.', // 允许输入监控，动鼠标即可接管。
    /** CU · Request or Try again finished and macOS still reports effective access unavailable. */
    permissionStillOff: computerPermissionRecovery('{Permission}'),
    openSystemSettings: 'Open System Settings', // 打开系统设置
    recheckPermission: 'Check again', // 再检查一次
    /** CU · tray tooltip while a chat controls the Mac */
    trayControlling: '{App} is controlling your Mac · {chat}', // {App} 正在操控你的 Mac · {对话名}
    /** Activity bar when there is no vision backend */
    readsAsText: 'Reading the screen as text on this Mac', // 在本机把屏幕读成文字
  },
  notifications: {
    /** CU · unattended notification */
    computerUseUnattended: '"{chat}" needs your OK to control {App}. Goal paused.', // “{对话名}”需要你授权控制 {App}，目标已暂停
    /** Notification coalescing */
    coalesced: '{n} chats need you', // {n} 个对话需要你处理
    /** Notification settings preset */
    preset: "Only when I'm needed", // 只在需要我处理时通知
  },
  browser: {
    /** Browser · Claude in Chrome migration note (shown once to users who had it on before the upgrade), where MoPilot's extension serves Claude */
    claudeInChromeMigration: "Claude in Chrome is off. Claude uses your Chrome through MoPilot's extension. [Set up]", // Claude in Chrome 已关闭。Claude 通过 MoPilot 的扩展使用你的 Chrome。[设置]
    /** Browser · the same note while Your Chrome is the browser channel */
    claudeInChromeYourChrome: 'Claude in Chrome is off. Claude uses your Chrome through Your Chrome (the Playwright Extension). [Set up]', // Claude in Chrome 已关闭。Claude 通过“你的 Chrome”（Playwright 扩展）使用你的 Chrome。[设置]
    /** Browser · the same note where MoPilot's extension doesn't serve Claude */
    claudeInChromeNoRoute: "Claude in Chrome is off, and MoPilot's extension isn't available here. [Use Your Chrome]", // Claude in Chrome 已关闭，这里也没有 MoPilot 的 Chrome 扩展，所以 Claude 无法使用你的 Chrome。[使用“你的 Chrome”]
  },
  scheduled: {
    /** Scheduled page subtitle */
    subtitle: 'Runs on this Mac', // 在这台 Mac 上运行
    /** Scheduled task · when approval is needed */
    whenApprovalNeeded: 'When approval is needed: Wait and notify / Skip this run', // 需要审批时：等待并通知 / 跳过这一次
    /** Scheduled task · timed out without being handled */
    needsAttention: 'Needs attention', // 需要处理
  },
  misc: {
    /** Mini window title bar */
    miniWindowTitle: '{label} · {account}', // {label} · {账号}
    /** Migration failure banner */
    migrationFailed: "Couldn't move archived chats · Restored from backup · Retry", // 归档对话迁移失败 · 已从备份恢复 · 重试
    /** Info panel for a basic-tier harness without loadSession */
    historyKeptBySage: 'History is kept by MoPilot', // 历史由 MoPilot 保存
    /** Update banner (a turn is running) */
    updateBanner: '{n} turns and {g} goal are running · Restart when idle / Restart now', // {n} 个回合和 {g} 个目标正在运行 · 空闲后重启 / 立即重启
    /** Quit confirmation dialog */
    quitConfirm: '{n} turn, {w} background workflows and {g} goal will stop. Goals are paused, not lost.', // {n} 个回合、{w} 个后台 Workflow 和 {g} 个目标会停止。目标会暂停，不会丢失。
    /** Release notes · what the upgrade does not change */
    releaseNotesUnchanged: 'Your billing method and dictation engine stay as they were.', // 你的计费方式和听写引擎保持不变。
    /** Init polyfill (Codex): the file already exists */
    initOverwrite: '{file} already exists · Replace it / Keep it', // {file} 已存在 · 替换 / 保留
    /** Init polyfill: offer to let the other tool read the existing file */
    initOfferRead: '{other} exists · Let {label} read it too (adds one line to {file})', // {other} 已存在 · 让 {label} 也读取它（在 {file} 里加一行）
    /** Note on the built-in shell polyfill (Claude's !cmd) */
    shellPolyfillNote: "Ran on this Mac, outside Claude Code's sandbox", // 在本机运行，不在 Claude Code 的沙箱里
  },
} as const;

export type CopyGroup = keyof typeof COPY;
type Vars = Record<string, string | number | undefined>;

/** Admission establishes availability and a reason; it does not establish that an update will fix it. */
export const admissionFailure = (reason: string | null) => `${ADMISSION_FAILURE}${reason ? ` · ${reason}` : ''}`;

/** Fill {name} placeholders. A name with no value is left out and the spacing around it closed up. */
export function fmt(template: string, vars: Vars = {}): string {
  let dropped = false;
  const out = template.replace(/\{([\w/ ]+)\}/g, (_, k) => (vars[k] === undefined ? ((dropped = true), '') : String(vars[k])));
  return dropped ? out.replace(/ {2,}/g, ' ') : out;
}

/** The English line for a group and key, with its placeholders filled. */
export function copy<G extends CopyGroup>(group: G, key: keyof (typeof COPY)[G] & string, vars?: Vars): string {
  return fmt((COPY[group] as Record<string, string>)[key], vars);
}
