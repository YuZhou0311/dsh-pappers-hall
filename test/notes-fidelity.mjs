/**
 * Fidelity guard unit test: a beautified section must not drop numbers,
 * qualifiers or most of its text. Runs without a browser.
 *
 *   node test/notes-fidelity.mjs
 */
import { parseBeautifyPayload, sectionizeMarkdown } from '../client/src/core/notes-model.js'

let checks = 0
function check(condition, label) {
  checks += 1
  if (!condition) {
    console.error('FAIL ' + label)
    process.exitCode = 1
  } else {
    console.log('PASS ' + label)
  }
}

const md = '## 方法\n灌溉贡献为 34±9%，覆盖 2019-2023 年，样本 12 万条。\n\n## 结论\n策略在跨年份验证中优于基线 12%。'
const sections = sectionizeMarkdown(md)
const sent = sections.map((section) => ({ id: section.id, hash: section.hash, text: section.raw || section.text, heading: section.heading }))
const payload = (blocksFor, second) => JSON.stringify({ sections: [
  { id: sent[0].id, heading: '方法', style: 'plain', blocks: blocksFor },
  { id: sent[1].id, heading: '结论', style: 'accent', blocks: second },
] })

const good = payload(
  [{ type: 'paragraph', text: '灌溉贡献为 34±9%，覆盖 2019-2023 年，样本 12 万条。' }],
  [{ type: 'paragraph', text: '策略在跨年份验证中优于基线 12%。' }],
)
const parsed = parseBeautifyPayload(good, sent, { figureCandidates: [] })
check(parsed.length === 2, 'complete re-layout is accepted')
check(Array.isArray(parsed[0].blocks), 'accepted section keeps blocks')

let rejected = false
try {
  parseBeautifyPayload(payload(
    [{ type: 'paragraph', text: '灌溉有贡献，覆盖多年，样本很大。' }],
    [{ type: 'paragraph', text: '策略优于基线。' }],
  ), sent, { figureCandidates: [] })
} catch (error) {
  rejected = error && error.code === 'shape'
}
check(rejected, 'missing numbers/qualifiers rejects the whole unusable answer')

let shrinkRejected = false
const long = '## 方法\n' + '贝叶斯框架融合卫星遥感与统计产量数据，按国家分层抽样。'.repeat(8)
const longSections = sectionizeMarkdown(long)
const longSent = [{ id: longSections[0].id, hash: longSections[0].hash, text: longSections[0].raw || longSections[0].text, heading: '方法' }]
try {
  parseBeautifyPayload(JSON.stringify({ sections: [{ id: longSent[0].id, style: 'plain', blocks: [{ type: 'paragraph', text: '贝叶斯框架。' }] }] }), longSent, { figureCandidates: [] })
} catch (error) {
  shrinkRejected = error && error.code === 'shape'
}
check(shrinkRejected, 'severe shrinkage rejects the section')

console.log(process.exitCode ? 'FIDELITY TEST FAILED' : `PASS — ${checks} checks`)
