#!/usr/bin/env node
/** Shared note-context bridge used by reader annotation/figure actions. */
import assert from 'node:assert/strict'
import { clearNoteContext, getNoteContext, setNoteContext, subscribeNoteContext } from '../client/src/core/note-context.js'

let calls = 0
const off = subscribeNoteContext(() => { calls += 1 })
const ctx = { noteId: 'note-a', title: 'A', paperIds: [], insertQuote: () => {}, insertFigure: () => {}, linkPaper: () => {} }
setNoteContext(ctx)
assert.equal(getNoteContext(), ctx)
assert.equal(calls, 1)
clearNoteContext('note-b')
assert.equal(getNoteContext(), ctx)
clearNoteContext('note-a')
assert.equal(getNoteContext(), null)
assert.equal(calls, 2)
off()
setNoteContext({ ...ctx, noteId: 'note-c' })
assert.equal(calls, 2)
clearNoteContext('note-c')
console.log('PASS — 6 note-context checks')
