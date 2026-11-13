#!/usr/bin/env node
/** Unit checks for the dedicated note Agent's pure boundaries. */
import assert from 'node:assert/strict'
import { extractDirectives, normalizeAgentBlock, sectionizeMarkdown } from '../host/note-agent.js'
import { extractDirectives as clientExtract, sectionizeMarkdown as clientSectionize } from '../client/src/core/notes-model.js'

let pass = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name) } catch (error) { console.error('  ✗ ' + name + ': ' + (error?.stack ?? error)); process.exitCode = 1 }
}
const markdown = '# 测试章节\n\nReAct 的关键数字是 HumanEval 91% pass@1。\n\n{{figure: Figure 1}}\n\n{{table: 指标 | 数值}}\n'
check('Host and Client derive identical section ids/hashes', () => {
  const host = sectionizeMarkdown(markdown)
  const client = clientSectionize(markdown)
  assert.equal(host.length, client.length)
  assert.deepEqual(host.map((s) => [s.id, s.hash, s.heading]), client.map((s) => [s.id, s.hash, s.heading]))
})
check('section text excludes the heading while hash includes it', () => {
  const [section] = sectionizeMarkdown(markdown)
  assert.ok(!section.text.startsWith('# 测试章节'))
  assert.notEqual(section.hash, sectionizeMarkdown('ReAct 的关键数字是 HumanEval 91% pass@1。')[0].hash)
})
check('directives parse with section assignment', () => {
  const sections = sectionizeMarkdown(markdown)
  const host = extractDirectives(markdown, sections)
  const client = clientExtract(markdown, sections)
  assert.equal(host.length, 2)
  assert.deepEqual(host.map((d) => [d.kind, d.argument, d.sectionId]), client.map((d) => [d.kind, d.argument, d.sectionId]))
})
check('unknown directives are ignored', () => {
  assert.equal(extractDirectives('{{unknown: nope}}').length, 0)
})
check('paragraph normalization trims and caps', () => {
  const block = normalizeAgentBlock({ type: 'paragraph', text: '  hello  ' })
  assert.deepEqual(block, { type: 'paragraph', text: 'hello' })
})
check('table normalization computes width', () => {
  const block = normalizeAgentBlock({ type: 'table', headers: ['A'], rows: [['1', '2']] })
  assert.equal(block.width, 2)
})
check('empty table is rejected', () => assert.equal(normalizeAgentBlock({ type: 'table', rows: [] }), null))
check('web image accepts local note assets', () => {
  const block = normalizeAgentBlock({ type: 'web-image', src: '/pappers-hall/note-asset/abcdef0123456789.jpg', caption: 'x' })
  assert.equal(block.type, 'web-image')
  assert.equal(block.src, '/pappers-hall/note-asset/abcdef0123456789.jpg')
})
check('web image rejects javascript/data URLs', () => {
  assert.equal(normalizeAgentBlock({ type: 'web-image', src: 'javascript:alert(1)' }), null)
  assert.equal(normalizeAgentBlock({ type: 'web-image', src: 'data:image/png;base64,xx' }), null)
})
check('sources block filters non-http URLs', () => {
  const block = normalizeAgentBlock({ type: 'sources', items: [{ title: 'ok', url: 'https://example.com' }, { title: 'bad', url: 'javascript:x' }] })
  assert.equal(block.items.length, 1)
})
check('timeline keeps bounded items', () => {
  const block = normalizeAgentBlock({ type: 'timeline', items: [{ when: '2020', title: 'A' }, { when: '2021', text: 'B' }] })
  assert.equal(block.items.length, 2)
})
check('compare requires at least one side', () => assert.equal(normalizeAgentBlock({ type: 'compare' }), null))
check('figure must match a real candidate', () => {
  assert.equal(normalizeAgentBlock({ type: 'figure', figureId: 'fg-aaaaaaaaaaaa' }, new Map()), null)
  const block = normalizeAgentBlock({ type: 'figure', figureId: 'fg-aaaaaaaaaaaa' }, new Map([['fg-aaaaaaaaaaaa', { paperId: 'ph-aaaaaaaaaaaa', page: 2, imageUrl: '/pappers-hall/figure/fg-aaaaaaaaaaaa.png' }]]))
  assert.equal(block.type, 'figure')
})
check('stats caps at four items', () => {
  const block = normalizeAgentBlock({ type: 'stats', items: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: 'l' })) })
  assert.equal(block.items.length, 4)
})
console.log(`${process.exitCode ? 'FAIL' : 'PASS'} — ${pass} note-agent checks`)
