#!/usr/bin/env node
/** Unit checks for the P0/P1 note block vocabulary and diagram directives. */
import assert from 'node:assert/strict'
import { extractDirectives, getDataPath, normalizeBlock, normalizeContentJson, sectionizeMarkdown, setDataPath } from '../client/src/core/notes-model.js'
import { normalizeAgentBlock } from '../host/note-agent.js'

let pass = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name) } catch (error) { console.error('  ✗ ' + name + ': ' + (error?.stack ?? error)); process.exitCode = 1 }
}
const both = (raw, candidates = new Map()) => [normalizeBlock(raw), normalizeAgentBlock(raw, candidates)]

check('cards normalise on both sides', () => {
  for (const block of both({ type: 'cards', items: [{ title: 'A', text: 'x' }, { title: 'B', text: 'y' }] })) {
    assert.equal(block.type, 'cards')
    assert.equal(block.items.length, 2)
  }
})
check('chart keeps only finite numeric data', () => {
  for (const block of both({ type: 'chart', variant: 'line', data: [{ label: 'A', value: 3 }, { label: 'B', value: 'x' }, { label: 'C', value: 5 }] })) {
    assert.equal(block.type, 'chart')
    assert.equal(block.variant, 'line')
    assert.equal(block.data.length, 2)
  }
})
check('chart rejects empty data', () => assert.equal(normalizeBlock({ type: 'chart', data: [] }), null))
check('markdown is capped and preserved', () => {
  for (const block of both({ type: 'markdown', text: '## T\n\n**x**' })) {
    assert.equal(block.type, 'markdown')
    assert.ok(block.text.includes('## T'))
  }
})
check('tabs keep nested blocks and reject a single tab', () => {
  for (const block of both({ type: 'tabs', tabs: [{ id: 'a', label: 'A', blocks: [{ type: 'paragraph', text: 'one' }] }, { id: 'b', label: 'B', blocks: [{ type: 'paragraph', text: 'two' }] }] })) {
    assert.equal(block.type, 'tabs')
    assert.equal(block.tabs.length, 2)
    assert.equal(block.tabs[0].blocks[0].text, 'one')
  }
  assert.equal(normalizeBlock({ type: 'tabs', tabs: [{ id: 'a', blocks: [{ type: 'paragraph', text: 'x' }] }] }), null)
})
check('disclosure keeps nested blocks', () => {
  for (const block of both({ type: 'disclosure', title: 'More', blocks: [{ type: 'paragraph', text: 'x' }] })) assert.equal(block.type, 'disclosure')
})
check('tasks and status normalise', () => {
  for (const block of both({ type: 'tasks', items: [{ text: 'read', done: true }, { text: 'run' }] })) assert.equal(block.items.length, 2)
  for (const block of both({ type: 'status', items: [{ label: 'State', value: 'ok', tone: 'success' }] })) assert.equal(block.items[0].tone, 'success')
})
check('progress clamps values to max', () => {
  for (const block of both({ type: 'progress', items: [{ label: 'P', value: 30, max: 10 }] })) {
    assert.equal(block.items[0].value, 10)
    assert.equal(block.items[0].max, 10)
  }
})
check('quotes, actions and empty state', () => {
  for (const block of both({ type: 'quotes', items: [{ text: 'q', source: 's' }] })) assert.equal(block.type, 'quotes')
  for (const block of both({ type: 'actions', items: [{ label: 'Open', url: 'https://example.com' }] })) assert.ok(block.items[0].url.startsWith('https://example.com'))
  for (const block of both({ type: 'empty', title: 'None', text: 'n/a' })) assert.equal(block.type, 'empty')
})
check('actions reject non-http URLs', () => assert.equal(normalizeBlock({ type: 'actions', items: [{ label: 'x', url: 'javascript:alert(1)' }] }), null))
check('timeline preserves horizontal orientation', () => {
  for (const block of both({ type: 'timeline', orientation: 'horizontal', items: [{ when: '2020', title: 'A' }] })) assert.equal(block.orientation, 'horizontal')
})
check('architecture diagram keeps nodes and edges', () => {
  for (const block of both({ type: 'diagram', layout: 'architecture', nodes: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API' }], edges: [{ from: 'ui', to: 'api' }] })) {
    assert.equal(block.type, 'diagram')
    assert.equal(block.layout, 'architecture')
    assert.equal(block.nodes.length, 2)
    assert.equal(block.edges.length, 1)
  }
})
check('mindmap derives parent edges on both sides', () => {
  for (const block of both({ type: 'mindmap', nodes: [{ id: 'root', label: 'Root' }, { id: 'a', label: 'A', parent: 'root' }] })) {
    assert.equal(block.layout, 'mindmap')
    assert.equal(block.edges.length, 1)
  }
})
check('diagram rejects unknown edges and one node', () => {
  assert.equal(normalizeBlock({ type: 'diagram', nodes: [{ id: 'a', label: 'A' }], edges: [] }), null)
  assert.equal(normalizeBlock({ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'zzz' }] }).edges.length, 0)
})
check('architecture and mindmap directives parse', () => {
  const content = '# A\n\n{{architecture: 客户端 -> Host -> Agent}}\n\n{{mindmap: 研究问题}}\n'
  const sections = sectionizeMarkdown(content)
  const directives = extractDirectives(content, sections)
  assert.deepEqual(directives.map((item) => item.kind), ['architecture', 'mindmap'])
  assert.equal(directives[0].sectionId, 's0')
})
check('all new directive kinds parse', () => {
  const names = ['markdown', 'cards', 'chart', 'gallery', 'tabs', 'disclosure', 'tasks', 'status', 'progress', 'alert', 'divider', 'empty', 'quotes', 'actions']
  const content = '# A\n\n' + names.map((name) => '{{' + name + ': x}}').join('\n')
  assert.deepEqual(extractDirectives(content).map((item) => item.kind), names)
})
check('gallery accepts a real figure candidate', () => {
  const candidate = new Map([['fg-aaaaaaaaaaaa', { figureId: 'fg-aaaaaaaaaaaa', paperId: 'ph-aaaaaaaaaaaa', page: 2, imageUrl: '/pappers-hall/figure/fg-aaaaaaaaaaaa.png', label: 'Figure 1', caption: 'cap' }]])
  const [clientBlock, hostBlock] = both({ type: 'gallery', items: [{ figureId: 'fg-aaaaaaaaaaaa', paperId: 'ph-aaaaaaaaaaaa' }] }, candidate)
  assert.equal(clientBlock.type, 'gallery')
  assert.equal(hostBlock.type, 'gallery')
})
check('contentJson survives a full rich section', () => {
  const content = '# Rich\n\nBody\n'
  const [section] = sectionizeMarkdown(content)
  const document = { version: 2, sections: [{ id: section.id, sourceHash: section.hash, heading: section.heading, style: 'plain', blocks: [
    { type: 'markdown', text: '**x**' },
    { type: 'chart', data: [{ label: 'A', value: 1 }] },
    { type: 'diagram', layout: 'architecture', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
    { type: 'tabs', tabs: [{ id: 'x', label: 'X', blocks: [{ type: 'paragraph', text: 'one' }] }, { id: 'y', label: 'Y', blocks: [{ type: 'paragraph', text: 'two' }] }] },
  ] }] }
  const parsed = normalizeContentJson(document)
  assert.equal(parsed.sections[0].blocks.length, 4)
  assert.equal(parsed.sections[0].blocks[2].layout, 'architecture')
})
check('form fields bind to a data path', () => {
  for (const block of both({ type: 'form', fields: [{ id: 'status', kind: 'select', label: 'Status', bind: '/review/status', options: ['draft', 'done'], value: 'draft' }] })) {
    assert.equal(block.type, 'form')
    assert.equal(block.fields[0].bind, '/review/status')
    assert.equal(block.fields[0].options.length, 2)
  }
})
check('data path get/set is immutable', () => {
  const before = { review: { status: 'draft' } }
  const after = setDataPath(before, '/review/status', 'done')
  assert.equal(getDataPath(after, '/review/status'), 'done')
  assert.equal(before.review.status, 'draft')
  assert.deepEqual(getDataPath(after, '/missing/key'), undefined)
})
check('grid nests blocks with 1–4 columns', () => {
  for (const block of both({ type: 'grid', columns: 3, blocks: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'b' }] })) {
    assert.equal(block.columns, 3)
    assert.equal(block.blocks.length, 2)
  }
})
check('data-table keeps column definitions and rows', () => {
  for (const block of both({ type: 'data-table', sortable: true, columns: [{ key: 'name', label: 'Name' }, { key: 'score', label: 'Score', align: 'right' }], rows: [{ name: 'A', score: 1 }, { name: 'B', score: 2 }] })) {
    assert.equal(block.type, 'data-table')
    assert.equal(block.columns.length, 2)
    assert.equal(block.rows[1][1], '2')
    assert.equal(block.sortable, true)
  }
})
check('comparison-table keeps 2+ columns', () => {
  for (const block of both({ type: 'comparison-table', columns: [{ title: 'A', items: ['x'] }, { title: 'B', items: ['y'] }] })) assert.equal(block.columns.length, 2)
})
check('media rejects unsafe/plain URLs', () => {
  assert.equal(normalizeBlock({ type: 'video', src: 'javascript:alert(1)' }), null)
  for (const block of both({ type: 'video', src: 'https://example.com/demo.mp4', title: 'Demo' })) assert.equal(block.kind, 'video')
})
check('chart keeps multi-series', () => {
  for (const block of both({ type: 'chart', variant: 'line', labels: ['A', 'B'], series: [{ name: 'P', values: [1, 2] }, { name: 'R', values: [3, 4] }] })) {
    assert.equal(block.series.length, 2)
    assert.equal(block.series[0].values[1], 2)
  }
})
check('actions support figure and copy callbacks', () => {
  for (const block of both({ type: 'actions', items: [{ label: 'Open', figureId: 'fg-aaaaaaaaaaaa', paperId: 'ph-aaaaaaaaaaaa', page: 2 }, { label: 'Copy', kind: 'copy', value: 'abc' }] })) {
    assert.equal(block.items[0].kind, 'figure')
    assert.equal(block.items[1].kind, 'copy')
  }
})
check('forms auto-bind fields when the model omits bind', () => {
  for (const block of both({ type: 'form', title: 'Review', fields: [{ id: 'score', kind: 'stepper', label: 'Score', min: 0, max: 5, step: 1 }] })) {
    assert.match(block.fields[0].bind, /^\/form\/[a-f0-9]{8}\/score$/)
  }
})
check('computed aggregates validate operations and paths', () => {
  for (const block of both({ type: 'computed', items: [{ label: 'Total', op: 'sum', paths: ['/form/a'] }, { label: 'Count', op: 'count', paths: ['/form/a', '/form/b'], unit: '项' }] })) {
    assert.equal(block.items.length, 2)
    assert.equal(block.items[0].op, 'sum')
    assert.equal(block.items[1].unit, '项')
  }
  assert.equal(normalizeBlock({ type: 'computed', items: [{ label: 'X', op: 'eval', paths: ['/x'] }] }), null)
})
check('data-table can bind its rows path', () => {
  for (const block of both({ type: 'data-table', rowsPath: '/rows', columns: [{ key: 'name', label: 'Name' }], rows: [['A']] })) assert.equal(block.rowsPath, '/rows')
})
check('avatar and calendar are safe P2 blocks', () => {
  for (const block of both({ type: 'avatar', name: 'Ada', role: 'Reviewer' })) assert.equal(block.type, 'avatar')
  for (const block of both({ type: 'calendar', events: [{ date: '2026-11-13', title: 'Review', text: 'Submit comments' }] })) assert.equal(block.events.length, 1)
  assert.equal(normalizeBlock({ type: 'avatar' }), null)
})
console.log(`${process.exitCode ? 'FAIL' : 'PASS'} — ${pass} rich-note checks`)
