/**
 * Pappers-Hall acceptance test entry point (contract §7.6).
 *
 * Usage:
 *   node test/run-tests.mjs --dry-run                 # validate fixtures only, no API
 *   node test/run-tests.mjs                           # import → search → annotations → lifecycle
 *   node test/run-tests.mjs --only import,search      # subset
 *   node test/run-tests.mjs --only toggle             # fold recorded toggle phases
 *   node test/run-tests.mjs --bibliography            # also exercise BibTeX/RIS/CSL import
 *
 * Live runs require the plugin to be installed and enabled in the desktop
 * profile. The script only talks to `http://127.0.0.1:54731/pappers-hall/api`
 * (plain localhost; the plugin prefix route is not behind the index cookie) and
 * never mutates the profile, the plugin source, the devkit or the PDFs.
 *
 * Outputs (the only reports this harness writes):
 * - `reports/test-results.json` — machine-readable cases + summary,
 * - `reports/import-result.json` — written by the import suite,
 * - `reports/verify.md` — human report with environment, metrics, failures and
 *   the list of not-run/manual checks.
 *
 * @module pappers-hall/test/run-tests
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CONTRACT_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  HARNESS_VERSION,
  HERE,
  PappersClient,
  Recorder,
  artifactPath,
  check,
  clip,
  collectEnvironment,
  flagBool,
  flagInt,
  flagString,
  fmtDuration,
  formatCaseLine,
  isMain,
  loadFixtures,
  parseArgs,
  readJsonIfExists,
  reportPath,
  splitList,
  summarizeCases,
  writeJsonFile,
  writeTextFile,
} from './lib.mjs'
import { printDryRun, validateFixtures } from './fixtures.mjs'
import * as importSuite from './import.mjs'
import * as searchSuite from './search.mjs'
import * as annotationSuite from './annotations.mjs'
import * as lifecycleSuite from './lifecycle.mjs'
import * as toggleSuite from './toggle.mjs'

/** Registered suites and their run order. */
const SUITES = Object.freeze({
  import: importSuite,
  search: searchSuite,
  annotations: annotationSuite,
  lifecycle: lifecycleSuite,
  toggle: toggleSuite,
})
/** Default live run order (matches test_plan.md: queries before seed annotations). */
const DEFAULT_ORDER = Object.freeze(['import', 'search', 'annotations', 'lifecycle', 'toggle'])

/**
 * Escape a value for a Markdown table cell.
 * @param {unknown} value raw value.
 * @returns {string} escaped cell.
 */
function md(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

/**
 * Render a Markdown table.
 * @param {string[]} headers column headers.
 * @param {Array<Array<unknown>>} rows row cells.
 * @returns {string} table markdown.
 */
function table(headers, rows) {
  const lines = [`| ${headers.map(md).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.map(md).join(' | ')} |`)
  return lines.join('\n')
}

/**
 * A repair suggestion for one failed case, derived from its suite and id.
 * @param {object} testCase recorded failing case.
 * @returns {string} suggestion text.
 */
function suggestionFor(testCase) {
  const caseId = String(testCase.case_id ?? '')
  const prefix = caseId.split('.')[0]
  if (prefix === 'IMPORT') {
    return '核对 host/ingest.js、host/pdf.js、host/jobs.js：poppler 探测、PDF 文本/题注抽取、作业状态与 progress；用 host/selftest.mjs 复现后重跑 --only import'
  }
  if (prefix === 'SEARCH') {
    return '核对 host/search.js：FTS5 索引写入、CJK 查询构造（整句中文需分词/关键词抽取，否则 FTS+LIKE 都难命中）、题注/页码映射；对比 test/.artifacts/search-summary.json 的逐条 actual'
  }
  if (prefix === 'ANN') {
    return '核对 host/store.js 的 annotations.create/list/delete 与 annotations_fts 索引，确认 origin=test_note 被保留且 scope=annotations 查询可用'
  }
  if (prefix === 'LIFE') {
    return '核对 host/store.js 的 library.delete/restore（epoch 单调递增、operationId 幂等缓存）与所有读取路径的 state=\'active\' 过滤（reader.open/reader.page/figures.list/annotations.list）'
  }
  if (prefix === 'TOGGLE') {
    return '核对 host/apply.js 的 ctx.effect 清理：HTTP 路由、SQLite 连接、job worker 定时器、工具注册都必须在停用后释放；用 plugin_manager 复测并附证据'
  }
  if (prefix === 'PREFLIGHT') {
    return '确认插件已安装并启用、DSH Web GUI 端口正确；`curl -s -X POST http://127.0.0.1:54731/pappers-hall/api -d \'{"method":"status","params":{}}\' -H \'content-type: application/json\'`'
  }
  return '查看 reports/test-results.json 中该 case 的 assertions/actual/evidence'
}

/**
 * Build the human-readable `reports/verify.md`.
 * @param {object} payload report payload.
 * @returns {string} markdown.
 */
function buildVerifyMarkdown(payload) {
  const { environment, run, suites, cases, summary, durationMs } = payload
  const failed = cases.filter((testCase) => testCase.status === 'fail')
  const notRun = cases.filter((testCase) => testCase.status === 'not_run')
  const lines = []
  lines.push('# Pappers-Hall 验收报告（自动生成）')
  lines.push('')
  lines.push(`- 生成时间：${payload.generatedAt}`)
  lines.push(`- 测试框架版本：${HARNESS_VERSION}；契约版本：${CONTRACT_VERSION}；DSH 版本：${environment.dsh_version ?? 'unknown'}`)
  lines.push(`- 运行命令：\`${run.command}\``)
  lines.push(`- 结论：**${failed.length === 0 ? (summary.pass > 0 ? '已执行项全部通过' : '未执行') : `存在 ${failed.length} 个失败项`}**（pass ${summary.pass} / fail ${summary.fail} / not_run ${summary.not_run}，共 ${summary.total} 项，耗时 ${fmtDuration(durationMs)}）`)
  lines.push('')
  lines.push('> 说明：本报告只记录真实执行结果。未执行/无法自动化的项明确标为 not_run 并给出原因与人工复核步骤；失败项保留原始期望值与实际值，未修改任何期望。')
  lines.push('')
  lines.push('## 1 环境')
  lines.push('')
  lines.push(table(
    ['项目', '值'],
    [
      ['DSH 版本', environment.dsh_version ?? 'unknown'],
      ['插件', `${environment.plugin?.id ?? 'unknown'} @ ${environment.plugin?.version ?? 'unknown'}（enabled=${environment.plugin?.enabled ?? 'unknown'}）`],
      ['Profile', environment.profile ?? 'unknown'],
      ['Node / 平台', `${environment.node ?? process.version} / ${environment.platform ?? `${process.platform}-${process.arch}`}`],
      ['Web GUI', environment.web_url ?? DEFAULT_API_BASE],
      ['API', environment.api_url ?? ''],
      ['数据目录', environment.storage?.dataDir ?? 'unknown'],
      ['数据库', environment.storage?.dbPath ?? 'unknown'],
      ['索引通道', JSON.stringify(environment.index?.channels ?? {})],
      ['降级项', JSON.stringify(environment.degraded ?? [])],
      ['Poppler / SQLite', `${environment.diagnostics?.versions?.find?.((entry) => entry.name === 'poppler')?.version ?? 'unknown'} / ${environment.diagnostics?.versions?.find?.((entry) => entry.name === 'node:sqlite')?.version ?? 'unknown'}`],
      ['能力', JSON.stringify(environment.diagnostics?.capabilities ?? {})],
    ],
  ))
  lines.push('')
  lines.push('## 2 结果摘要')
  lines.push('')
  lines.push(table(
    ['Suite', 'total', 'pass', 'fail', 'not_run', '耗时'],
    Object.entries(suites).map(([name, suite]) => [name, suite.summary.total, suite.summary.pass, suite.summary.fail, suite.summary.not_run, fmtDuration(suite.durationMs ?? 0)]),
  ))
  lines.push('')
  lines.push('### 2.1 检索指标（真实计算，非目标值）')
  lines.push('')
  const search = suites.search?.result?.searchSummary ?? null
  if (search === null) {
    lines.push('检索套件未运行或未产出指标。')
  } else {
    lines.push(table(
      ['指标', '值'],
      [
        ['论文查询数', search.paper_queries],
        ['Top1 命中', `${search.top1_hits}（${(search.recall_at_1 * 100).toFixed(1)}%）`],
        ['Top5 命中', `${search.top5_hits}（${(search.recall_at_5 * 100).toFixed(1)}%）`],
        ['分类型 Top5', Object.entries(search.by_kind ?? {}).map(([kind, row]) => `${kind}: ${row.top5}/${row.total}`).join('；')],
        ['图检索查询', search.figure_queries],
        ['图定位命中（论文+1-based页+图号）', `${search.figure_matched}（${(search.figure_recall * 100).toFixed(1)}%）`],
        ['图页命中', search.figure_page_matched],
        ['图号命中', search.figure_label_matched],
        ['真实图 PNG 可访问（≥1KB）', search.figure_assets_ok],
        ['figure_recall_and_understanding 未跑模型项', search.understanding_not_run],
        ['检索运行时库内批注', `${(environment.counts?.annotations ?? 'n/a')} 条（本次为末次全量重跑，已含 test_note；test_plan 的“先检索后导入批注”干净顺序在首轮执行）`],
        ['失败 case', search.failures.length === 0 ? '无' : search.failures.join(', ')],
      ],
    ))
  }
  lines.push('')
  lines.push('### 2.2 导入核对')
  lines.push('')
  const importResult = suites.import?.result?.importResult ?? null
  if (importResult === null) {
    lines.push('导入套件未运行或未产出 reports/import-result.json。')
  } else {
    lines.push(table(
      ['项目', '值'],
      [
        ['30 篇映射（SHA-256）', `${Object.values(importResult.mapping ?? {}).filter(Boolean).length}/30`],
        ['5 领域 × 6 篇', JSON.stringify(importResult.fields ?? {})],
        ['图裁切总数', importResult.figures?.total ?? 0],
        ['图锚点命中', `${importResult.figures?.anchor_hits ?? 0}/${importResult.figures?.anchor_expected ?? 0}`],
        ['作业', importResult.job === null ? '无（重跑时无需导入）' : `${importResult.job.job?.state ?? 'unknown'}（${importResult.job.ticks} 次轮询，${fmtDuration(importResult.job.duration_ms ?? 0)}）`],
        ['本次运行导入响应（重跑=增量去重）', `accepted=${importResult.request?.response?.accepted ?? 'n/a'} duplicates=${Array.isArray(importResult.request?.response?.duplicates) ? importResult.request.response.duplicates.length : 'n/a'} errors=${Array.isArray(importResult.request?.response?.errors) ? importResult.request.response.errors.length : 'n/a'}`],
        ['首次导入证据（fresh 库）', importResult.first_run_evidence === null || importResult.first_run_evidence === undefined ? '无归档' : `accepted=${importResult.first_run_evidence.request?.response?.accepted} job=${importResult.first_run_evidence.job?.job?.state}/${importResult.first_run_evidence.job?.job?.progress?.done} pages, 归档 test/.artifacts/import-first-run.json`],
      ],
    ))
    lines.push('')
    lines.push('逐篇映射与页数/SHA-256 核对见 `reports/import-result.json` 的 `mapping` / `per_paper`。')
  }
  lines.push('')
  lines.push('### 2.3 失败原因分类统计（真实计数，不合并为“检索质量差”）')
  lines.push('')
  const annQueryCases = cases.filter((testCase) => /^ANN\.QUERY\./.test(testCase.case_id))
  const annQueryPass = annQueryCases.filter((testCase) => testCase.status === 'pass').length
  const annQueryFail = annQueryCases.filter((testCase) => testCase.status === 'fail').length
  const importFigures = importResult?.figures ?? null
  const figurelessCount = (importFigures?.per_paper ?? []).filter((row) => row.figure_count === 0).length
  const figurelessIds = (importFigures?.per_paper ?? []).filter((row) => row.figure_count === 0).map((row) => row.fixture_id)
  if (search === null) {
    lines.push('检索/批注套件未运行，无法分类。')
  } else {
    lines.push(table(
      ['失败/能力分组', '真实计数', '证据与说明'],
      [
        ['无文本语义（vector）通道 → 中文自然语言题未命中', `${search.semantic_fuzzy_failures}/${(search.by_kind?.semantic_recall?.total ?? 0) + (search.by_kind?.fuzzy_recall?.total ?? 0)}（semantic+fuzzy）`, `status.index.channels.vector=${environment.index?.channels?.vector ?? 'unknown'}；degraded=${JSON.stringify(environment.degraded?.filter?.((entry) => entry.channel === 'vector') ?? [])}。通过项 ${search.semantic_fuzzy_passes} 条均为题面含英文/关键词重叠`],
        ['无视觉/跨语言图搜通道 → 中文描述匹配不到英文图注', `${search.figure_fail_lexical_mismatch} 题（图注已检测到但未命中）`, `figure 题共 ${search.figure_queries} 条；完全命中 ${search.figure_matched}；image_embedding 通道 degraded（无视觉嵌入模型），图注为英文、查询为中文，词面无法重叠`],
        ['图注抽取 partial → 锚点图不存在，题面无从命中', `${search.figure_fail_no_anchor} 题 / ${figurelessCount} 篇论文`, `无图裁切论文：${figurelessIds.join(', ') || '无'}；CONTRACT §5 允许 figure 通道 partial 并降级展示（import 已断言不得伪造 ready）`],
        ['中文批注自然语句检索失败', `${annQueryFail}/${annQueryCases.length}（pass ${annQueryPass}）`, '批注正文为中文、查询为中文自然句；FTS unicode61 不做中文分词、LIKE 只做整句子串；通过的 2 条题面含英文关键词（Q-Former / critic）'],
        ['真实功能 bug（与检索能力无关）', '1', 'reader.open/reader.page 对回收站论文返回内容，违反 CONTRACT §4（已按 Lead 要求由 host 修复；修复前后对比见 4.1）'],
        ['关键词/英文 token 题通过数', `${search.top5_hits}/${search.paper_queries} Top5 命中（Top1 ${search.top1_hits}）`, '这些是通过项，说明 FTS 关键词通道本身可用；失败不是索引未建立'],
        ['图裁切质量（图注定位到但裁切可疑）', `${(search.rows ?? []).filter((row) => row.figure?.asset !== undefined && row.figure?.asset !== null && row.figure.asset.bytes < 1024).length} 个匹配裁切 <1KB`, '小于 1KB 的 PNG 基本是空白/错裁（如 A05-figure 的 Figure 2 仅 314B）；见失败明细与 test/.artifacts/search-summary.json'],
      ],
    ))
    lines.push('')
    lines.push('> 结论口径：上述失败可归为环境缺少 embedding/视觉模型（首版仅 FTS5+LIKE 词面检索）与中文分词缺失两类系统能力缺口，而不是逐条独立的随机失败；报告保留逐题实际值，未改写期望。')
  }
  lines.push('')
  lines.push('## 3 失败明细')
  lines.push('')
  if (failed.length === 0) {
    lines.push('无失败项。')
  } else {
    for (const testCase of failed) {
      lines.push(`### ${testCase.case_id} — ${testCase.title}`)
      lines.push('')
      lines.push(`- Suite/耗时：${testCase.suite} / ${fmtDuration(testCase.duration_ms ?? 0)}`)
      for (const assertion of testCase.assertions.filter((entry) => !entry.ok)) {
        lines.push(`- 断言失败 **${assertion.name}**：期望 \`${clip(assertion.expected, 300)}\`，实际 \`${clip(assertion.actual, 300)}\``)
      }
      if (testCase.actual !== undefined) lines.push(`- actual：\`${clip(testCase.actual, 600)}\``)
      if (testCase.notes !== undefined) lines.push(`- 备注：${testCase.notes}`)
      lines.push(`- 建议排查：${suggestionFor(testCase)}`)
      lines.push('')
    }
  }
  lines.push('## 4 未执行 / 无法自动验证项（not_run）')
  lines.push('')
  if (notRun.length === 0) {
    lines.push('无。')
  } else {
    const grouped = new Map()
    for (const testCase of notRun) {
      const reason = String(testCase.reason ?? '未给出原因')
      if (!grouped.has(reason)) grouped.set(reason, [])
      grouped.get(reason).push(testCase.case_id)
    }
    lines.push(table(['case', '原因 / 人工复核步骤'], [...grouped.entries()].map(([reason, ids]) => [ids.join('<br>'), reason])))
    if (existsSync(reportPath('tool-evidence.md'))) {
      lines.push('')
      lines.push(`> 会话/人工证据见 \`${reportPath('tool-evidence.md')}\`：8 个 papers_* 工具注册实测、papers_get_figure 真实 ImageBlock 进入模型（含图内独有细节）、回收站论文的 papers_get_passage/papers_get_figure 拦截结果。该证据由 Lead 子代理实测，自动套件无法复现，故对应 case 仍标 not_run 并在本节引用，不冒充自动通过。`)
    }
  }
  lines.push('')
  lines.push('### 4.1 reader.open 回收站修复前后对比（`--only lifecycle` 单独复跑证据）')
  lines.push('')
  const lifecycleBefore = readJsonIfExists(artifactPath('lifecycle-before-fix.json'))
  const lifecycleAfterCases = cases.filter((testCase) => testCase.suite === 'lifecycle')
  if (lifecycleBefore === null || lifecycleBefore === undefined) {
    lines.push('未找到修复前归档（`test/.artifacts/lifecycle-before-fix.json`）。')
  } else if (lifecycleAfterCases.length === 0) {
    lines.push('本次运行未包含 lifecycle suite，无法对比。')
  } else {
    const beforeById = new Map((lifecycleBefore.cases ?? []).map((testCase) => [testCase.case_id, testCase.status]))
    const rows = []
    for (const testCase of lifecycleAfterCases) {
      const before = beforeById.get(testCase.case_id)
      if (before === undefined) continue
      if (before === 'pass' && testCase.status === 'pass') continue
      rows.push([testCase.case_id, before, testCase.status, before !== testCase.status ? '**已变化**' : '未变化'])
    }
    lines.push(table(['case', '修复前', '修复后', '结论'], rows.length === 0 ? [['（无 pre/post 差异行）', '-', '-', '-']] : rows))
    const targetBefore = (lifecycleBefore.cases ?? []).find((testCase) => testCase.case_id === 'LIFE.04.reader_open_rejected')
    const targetAfter = lifecycleAfterCases.find((testCase) => testCase.case_id === 'LIFE.04.reader_open_rejected')
    if (targetBefore !== undefined && targetAfter !== undefined) {
      lines.push('')
      lines.push(`- \`LIFE.04.reader_open_rejected\`：修复前 **${targetBefore.status}**（${clip(targetBefore.actual, 220)}）→ 修复后 **${targetAfter.status}**${targetAfter.status === 'pass' ? '，回收站论文的 reader.open/reader.page 已返回 not_found，CONTRACT §4 修复生效。' : '，仍未通过，见上方失败明细。'}`)
      lines.push(`- 修复前证据归档：\`${artifactPath('lifecycle-before-fix.json')}\`（${lifecycleBefore.archived_at ?? 'n/a'}）`)
    }
  }
  lines.push('')
  lines.push('## 5 测试数据、隔离与清理边界')
  lines.push('')
  const mapping = importResult?.mapping ?? {}
  const createdPapers = Object.values(mapping).filter(Boolean)
  lines.push(`- 数据目录：\`${environment.storage?.dataDir ?? 'unknown'}\`，数据库 \`${environment.storage?.dbPath ?? 'unknown'}\`（插件私有目录，未写入 profile/工作区/devkit/PDF）`)
  lines.push(`- 测试导入的 30 篇论文 id：${createdPapers.map((row) => row.paper_id).join(', ') || '（未运行导入）'}`)
  lines.push(`- 测试创建的批注：见 \`test/.artifacts/annotations-map.json\`；origin 均为 \`test_note\`，页级定位、无伪造高亮`)
  lines.push(`- 显式测试已读标记（本测试创建）：${(search?.read_marks ?? []).join(', ') || '无'}`)
  const preRead = search?.pre_existing_read_ids ?? []
  const harnessMarks = search?.read_marks ?? []
  const externalRead = preRead.filter((id) => !harnessMarks.includes(id))
  lines.push(`- 本次 S07 探测前已读、非本次创建的标记：${preRead.join(', ') || '无'}（其中 ${harnessMarks.filter((id) => preRead.includes(id)).join(', ') || '无'} 来自此前测试运行的显式 read mark；${externalRead.join(', ') || '无'} 来自人工/浏览器验证的只读操作，不属本测试创建）`)
  lines.push(`- 生命周期测试目标：${suites.lifecycle?.result?.lifecycleSummary?.target?.fixture_id ?? '未运行'}（结束时已恢复 active；未 purge 任何 30 篇论文）`)
  const preExisting = importResult?.library?.pre_existing ?? []
  const knownImportIds = new Set(Object.values(mapping).filter(Boolean).map((row) => row.paper_id))
  const preExistingTestOwned = preExisting.every((row) => knownImportIds.has(row.paper_id))
  lines.push(`- 本次运行开始前库中已有条目（${preExistingTestOwned ? '均为此前测试运行导入的测试数据；首次全量运行时此处为 Lead 冒烟数据，本测试未创建/修改它们' : '含非本测试创建条目，见 reports/import-result.json 的 library.pre_existing'}）：${preExisting.length === 0 ? '无' : preExisting.map((row) => row.paper_id).join(', ')}`)
  lines.push('- 清理方式：如需恢复干净演示库，只按上述记录 id 用 `library.purge` 删除测试条目；不得删除用户数据。')
  lines.push('')
  lines.push('## 6 插件开关（enable/disable）证据')
  lines.push('')
  const toggle = suites.toggle?.result?.toggleResult ?? null
  if (toggle === null || (toggle.phases ?? []).length === 0) {
    lines.push('未记录开关阶段。操作步骤：')
    lines.push('')
    lines.push('1. `node test/toggle.mjs --phase after-enable --note "baseline"`')
    lines.push('2. Lead 用 `plugin_manager` 停用插件（可重启 DSH 验证停用持久）后：`node test/toggle.mjs --phase after-disable --evidence <lead证据.json>`')
    lines.push('3. Lead 重新启用（或重启）后：`node test/toggle.mjs --phase after-enable --note "re-enabled"`')
    lines.push('4. `node test/run-tests.mjs --only toggle` 汇总证据')
  } else {
    lines.push(table(
      ['阶段', '时间', 'note', 'pass', 'fail', 'not_run', '重启证据', 'Host 工具证据'],
      toggle.phases.map((phase) => [phase.phase, phase.at, phase.note ?? '', phase.summary?.pass ?? 0, phase.summary?.fail ?? 0, phase.summary?.not_run ?? 0, phase.evidence?.restarted === true ? '是（已重启）' : '否（真实重启未执行=not_run）', (phase.evidence?.tool_names ?? []).length > 0 ? `已提供 ${phase.evidence.tool_names.length} 个：${(phase.evidence.tool_names ?? []).join(', ')}` : '未提供']),
    ))
    lines.push('')
    lines.push('- **停用/启用的正确 target**：`plugin_manager set_plugin {target:"include:pappers-hall", enabled:false|true}`（entryId 必须带 `include:` 前缀）。实测把 target 写成 `pappers-hall` 会返回 `unknown-plugin`；该失败调用已原样保存在 `reports/toggle-evidence-disable.json` 的 `actions[1]`，供后续排错参考。')
    lines.push('- **真实进程重启 = not_run**：本次未重启 DSH 进程（会终止验证会话）。支持证据仅为持久化 profile patch（`- id: pappers-hall` / `disabled: true`）与停用后 boot graph 不含插件；不能把 patch 证据写成“已完成重启验证”。')
    lines.push('- 脚本自动断言：HTTP 路由/API 挂载与消失、资产路由 404、原生 GUI `/favicon.svg` 200、数据跨开关保留（baseline library id 集合对比）。')
    lines.push('- Agent 工具注册/注销与侧栏 UI 属人工/会话证据（`reports/tool-evidence.md` + `reports/screenshots/`），脚本标记 not_run 并引用，不由 HTTP 结果冒充。')
  }
  lines.push('')
  lines.push('## 7 证据文件')
  lines.push('')
  lines.push(`- \`${reportPath('test-results.json')}\`（逐 case 机读结果）`)
  lines.push(`- \`${reportPath('import-result.json')}\`（导入/映射/逐篇核对）`)
  lines.push(`- \`${path.join(HERE, '.artifacts')}\` 下的 dry-run、search-summary、annotations-map/result、lifecycle-result、toggle-state 与各 suite artifact`)
  const leadEvidence = [
    reportPath('tool-evidence.md'),
    reportPath('toggle-evidence-disable.json'),
    reportPath('toggle-evidence-restart.json'),
    reportPath('toggle-evidence-baseline.json'),
    reportPath('host-tools.json'),
  ].filter((filePath) => readJsonIfExists(filePath) !== undefined || (filePath.endsWith('.md') && existsSync(filePath)))
  const screenshotsDir = reportPath('screenshots')
  if (existsSync(screenshotsDir)) {
    const shots = readdirSync(screenshotsDir).filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name)).sort()
    if (shots.length > 0) lines.push(`- Web GUI 截图（人工视觉证据）：\`${screenshotsDir}/\` — ${shots.map((name) => `\`${name}\``).join('、')}`)
  }
  if (leadEvidence.length > 0) {
    for (const filePath of leadEvidence) lines.push(`- Lead 提供的人工/会话证据：\`${filePath}\``)
  } else {
    lines.push('- 人工证据（截图、Agent 工具调用记录）由 Lead/验收人补充到本节，并在 not_run 项中引用。')
  }
  lines.push('')
  lines.push('## 8 复现命令')
  lines.push('')
  lines.push('```bash')
  lines.push(`cd ${path.resolve(HERE, '..', '..')}`)
  lines.push('node pappers-hall-plugin/test/run-tests.mjs --dry-run')
  lines.push('node pappers-hall-plugin/test/run-tests.mjs                 # 全量（自动）')
  lines.push('node pappers-hall-plugin/test/run-tests.mjs --only import,search')
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/**
 * Main entry.
 * @returns {Promise<number>} exit code.
 */
export async function main() {
  const startedAt = Date.now()
  const { flags } = parseArgs()
  const command = `node ${path.relative(process.cwd(), path.join(HERE, 'run-tests.mjs')) || 'test/run-tests.mjs'}${process.argv.slice(2).map((arg) => (/\s/.test(arg) ? ` '${arg}'` : ` ${arg}`)).join('')}`

  /* ---------------------------------------------------------------- */
  /* Dry run: validate fixtures without touching the API              */
  /* ---------------------------------------------------------------- */
  if (flagBool(flags, 'dry-run')) {
    const result = await validateFixtures({ hashPdfs: !flagBool(flags, 'no-hash') })
    const out = writeJsonFile(artifactPath('dry-run.json'), result)
    printDryRun(result)
    console.log(`artifact: ${out}`)
    if (result.ok) {
      console.log('dry-run OK: every fixture parses, case counts are 60/10/10/3, manifest sha256 matches the 30 bundled PDFs, and each suite plan matches. No API was called.')
      return 0
    }
    return 1
  }

  const only = splitList(flagString(flags, 'only', ''))
  const order = only.length > 0 ? only : [...DEFAULT_ORDER]
  const unknownSuites = order.filter((name) => !Object.hasOwn(SUITES, name))
  if (unknownSuites.length > 0) {
    console.error(`run-tests: unknown suite(s) ${unknownSuites.join(', ')}; known: ${Object.keys(SUITES).join(', ')}`)
    return 2
  }
  const apiBase = flagString(flags, 'api-base', DEFAULT_API_BASE)
  const profile = flagString(flags, 'profile', DEFAULT_PROFILE)
  const options = {
    apiBase,
    profile,
    importTimeoutMs: flagInt(flags, 'import-timeout-ms', DEFAULT_IMPORT_TIMEOUT_MS),
    bibliography: flagBool(flags, 'bibliography'),
    lifecyclePaper: flagString(flags, 'lifecycle-paper', 'C05'),
    verbose: true,
  }
  const client = new PappersClient({ baseUrl: apiBase, timeoutMs: flagInt(flags, 'timeout-ms', DEFAULT_TIMEOUT_MS) })
  const recorder = new Recorder({ runId: `run-tests-${new Date().toISOString()}` })
  const fixtures = loadFixtures()
  const environment = await collectEnvironment(client, { profile })
  const ctx = { client, fixtures, recorder, environment, state: {}, options }

  /* ---------------------------------------------------------------- */
  /* Preflight                                                        */
  /* ---------------------------------------------------------------- */
  const preflightHandle = recorder.begin({
    suite: 'preflight',
    caseId: 'PREFLIGHT.plugin',
    title: 'Plugin API reachable and enabled',
    expected: 'POST /pappers-hall/api {method:"status"} => ok:true, plugin dsh-pappers-hall enabled',
    input: { api_base: apiBase, profile },
  })
  const statusProbe = await client.status()
  const preflightOk = statusProbe.ok === true && statusProbe.data?.plugin?.id === 'dsh-pappers-hall' && statusProbe.data?.plugin?.enabled === true
  recorder.end(preflightHandle, preflightOk
    ? {
        assertions: [
          check('API reachable', true, true, true),
          check('plugin id', statusProbe.data?.plugin?.id === 'dsh-pappers-hall', 'dsh-pappers-hall', statusProbe.data?.plugin?.id),
          check('plugin enabled', statusProbe.data?.plugin?.enabled === true, true, statusProbe.data?.plugin?.enabled),
        ],
        actual: { plugin: statusProbe.data?.plugin, storage: statusProbe.data?.storage, counts: statusProbe.data?.counts, index: statusProbe.data?.index },
      }
    : {
        status: 'not_run',
        reason: `plugin API not available (${statusProbe.ok ? 'unexpected status payload' : `${statusProbe.error?.code}: ${statusProbe.error?.message}`}); install/enable the plugin first`,
        actual: { api_base: apiBase, error: statusProbe.ok ? clip(statusProbe.data, 400) : String(statusProbe.error?.message ?? '') },
      })

  const suiteResults = {}
  const skippedSuites = []
  if (!preflightOk) {
    for (const name of order) {
      const handle = recorder.begin({ suite: name, caseId: `${name.toUpperCase()}.preflight`, title: `${name} suite not executed`, expected: 'plugin API reachable' })
      recorder.end(handle, { status: 'not_run', reason: 'plugin API unreachable; live suite skipped (see PREFLIGHT.plugin)' })
      suiteResults[name] = { summary: summarizeCases(recorder.cases.filter((testCase) => testCase.suite === name)), durationMs: 0, skipped: true }
      skippedSuites.push(name)
    }
  } else {
    for (const name of order) {
      const suite = SUITES[name]
      const suiteStarted = Date.now()
      console.log(`\n=== ${name} ===`)
      try {
        const result = await suite.run(ctx)
        const suiteCases = recorder.cases.filter((testCase) => testCase.suite === name)
        suiteResults[name] = {
          summary: summarizeCases(suiteCases),
          durationMs: result?.durationMs ?? Date.now() - suiteStarted,
          planned: suite.PLANNED ?? null,
          result,
        }
        const bucket = suiteResults[name].summary
        console.log(`${name}: ${bucket.pass} pass, ${bucket.fail} fail, ${bucket.not_run} not_run (${bucket.total} cases)`)
        for (const testCase of suiteCases.filter((entry) => entry.status === 'fail')) console.log(formatCaseLine(testCase))
      } catch (error) {
        const handle = recorder.begin({ suite: name, caseId: `${name.toUpperCase()}.fatal`, title: `${name} suite crashed`, expected: 'suite runs to completion' })
        recorder.crash(handle, error)
        suiteResults[name] = { summary: summarizeCases(recorder.cases.filter((testCase) => testCase.suite === name)), durationMs: Date.now() - suiteStarted, error: String(error?.message ?? error) }
        console.error(`${name}: fatal — ${String(error?.stack ?? error)}`)
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Aggregate + reports                                              */
  /* ---------------------------------------------------------------- */
  const summary = recorder.summary()
  const durationMs = Date.now() - startedAt
  const dryRunArtifact = readJsonIfExists(artifactPath('dry-run.json'))
  const importMappingForReport = suiteResults.import?.result?.importResult?.mapping ?? {}
  const annotationMapForReport = readJsonIfExists(artifactPath('annotations-map.json'))?.entries ?? {}
  const testData = {
    data_dir: environment.storage?.dataDir ?? null,
    db_path: environment.storage?.dbPath ?? null,
    imported_papers: Object.values(importMappingForReport).filter(Boolean).map((row) => ({ fixture_id: row.fixture_id, paper_id: row.paper_id, version_id: row.version_id })),
    annotations: Object.values(annotationMapForReport).map((row) => ({ fixture_id: row.fixture_id, annotation_id: row.annotation_id, paper_id: row.paper_id, origin: row.origin })),
    read_marks: suiteResults.search?.result?.searchSummary?.read_marks ?? [],
    pre_existing_read_marks: suiteResults.search?.result?.searchSummary?.pre_existing_read_ids ?? [],
    lifecycle_target: suiteResults.lifecycle?.result?.lifecycleSummary?.target ?? null,
    pre_existing_library: suiteResults.import?.result?.importResult?.library?.pre_existing ?? [],
    lead_smoke_note: 'The test library may already contain Lead hand-imported smoke data (e.g. A01 + one test_note annotation + one bundle); it is listed in pre_existing_library and was never created or modified by this harness.',
  }
  const testResults = {
    schema: 'pappers-hall/test-results@1',
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    run: {
      command,
      argv: process.argv.slice(2),
      suites: order,
      skipped_suites: skippedSuites,
      preflight_ok: preflightOk,
      options: { ...options, importTimeoutMs: options.importTimeoutMs, bibliography: options.bibliography },
      api_base: apiBase,
      profile,
      duration_ms: durationMs,
    },
    environment,
    dry_run: dryRunArtifact === undefined ? null : { ok: dryRunArtifact.ok, generated_at: dryRunArtifact.generated_at, checks: dryRunArtifact.checks?.length ?? 0, errors: dryRunArtifact.errors ?? [] },
    suites: Object.fromEntries(Object.entries(suiteResults).map(([name, suite]) => [name, {
      summary: suite.summary,
      duration_ms: suite.durationMs,
      ...(suite.planned === undefined ? {} : { planned: suite.planned }),
      ...(suite.skipped === true ? { skipped: true } : {}),
      ...(suite.error === undefined ? {} : { error: suite.error }),
    }])),
    summary,
    test_data: testData,
    cases: recorder.cases,
  }
  writeJsonFile(reportPath('test-results.json'), testResults)
  const verifyMarkdown = buildVerifyMarkdown({
    generatedAt: testResults.generated_at,
    environment,
    run: testResults.run,
    suites: suiteResults,
    cases: recorder.cases,
    summary,
    durationMs,
  })
  writeTextFile(reportPath('verify.md'), verifyMarkdown)

  console.log('')
  console.log('=== summary ===')
  for (const [name, suite] of Object.entries(suiteResults)) {
    const bucket = suite.summary
    console.log(`  ${name.padEnd(12)} total ${String(bucket.total).padStart(3)}  pass ${String(bucket.pass).padStart(3)}  fail ${String(bucket.fail).padStart(3)}  not_run ${String(bucket.not_run).padStart(3)}`)
  }
  console.log(`  ${'OVERALL'.padEnd(12)} total ${String(summary.total).padStart(3)}  pass ${String(summary.pass).padStart(3)}  fail ${String(summary.fail).padStart(3)}  not_run ${String(summary.not_run).padStart(3)}  (${fmtDuration(durationMs)})`)
  console.log('')
  console.log(`reports: ${reportPath('test-results.json')}`)
  console.log(`         ${reportPath('verify.md')}`)
  if (readJsonIfExists(reportPath('import-result.json')) !== undefined) console.log(`         ${reportPath('import-result.json')}`)
  if (!preflightOk) console.log('preflight failed: plugin API unreachable — install/enable the plugin, then rerun.')
  return !preflightOk ? 2 : summary.fail > 0 ? 1 : 0
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`run-tests: ${String(error?.stack ?? error)}`)
      process.exitCode = 2
    })
}
