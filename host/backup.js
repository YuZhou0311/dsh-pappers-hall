/**
 * Portable Pappers-Hall backup format.
 *
 * The archive deliberately contains user data rather than a raw SQLite file:
 *   manifest.json          format/version/counts/checksums
 *   data.json              papers, notes, annotations, folders, links, revisions
 *   pdfs/<version-id>.pdf  original PDFs (so a new computer can re-read them)
 *   figures/<name>         extracted figure crops/thumbs
 *   note-assets/<name>     images embedded in notes
 *
 * Restore inserts rows in one transaction, copies the files into the current
 * data directory, and rebuilds the FTS index. It never imports a path from the
 * archive; every file path is generated locally.
 */
import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FORMAT = 'pappers-hall-backup'
const FORMAT_VERSION = 1
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const TABLES = [
  'papers',
  'paper_versions',
  'paper_pages',
  'figures',
  'annotations',
  'collections',
  'paper_collections',
  'tags',
  'paper_tags',
  'note_docs',
  'note_folders',
  'note_paper_links',
  'note_revisions',
  'notes',
]

/* ------------------------------------------------------------------ ZIP ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | Math.floor(date.getSeconds() / 2),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

/** Build a standard (non-Zip64) ZIP buffer. */
export function buildZip(entries, now = new Date()) {
  const local = []
  const central = []
  let offset = 0
  const { time, date } = dosTime(now)
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll('\\', '/'), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
    if (data.length >= 0xffffffff) throw new Error('archive entry is too large (4 GB limit)')
    const deflated = deflateRawSync(data, { level: 6 })
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const checksum = crc32(data)
    const flags = 0x0800
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(useDeflate ? 8 : 0, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, payload)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(useDeflate ? 8 : 0, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(0, 30)
    centralHeader.writeUInt32LE(0, 34)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += header.length + name.length + payload.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...local, ...central, end])
}

/** Read a ZIP buffer produced by `buildZip` (or a normal store/deflate ZIP). */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a ZIP archive')
  let eocd = -1
  for (let cursor = buffer.length - 22; cursor >= Math.max(0, buffer.length - 65557); cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50) { eocd = cursor; break }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff) throw new Error('ZIP64 archives are not supported')
  const files = new Map()
  let total = 0
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid ZIP central directory')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const uncompressed = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const safe = name.replaceAll('\\', '/')
    if (safe.startsWith('/') || safe.split('/').some((part) => part === '..' || part === '')) throw new Error('unsafe ZIP entry path')
    if (uncompressed > MAX_ENTRY_BYTES) throw new Error('ZIP entry is too large: ' + safe)
    total += uncompressed
    if (total > MAX_TOTAL_BYTES) throw new Error('ZIP archive expands beyond the safety limit')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header')
    const localName = buffer.readUInt16LE(localOffset + 26)
    const localExtra = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localName + localExtra
    const raw = buffer.subarray(dataStart, dataStart + compressed)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error('unsupported ZIP compression method ' + method)
    files.set(safe, data)
  }
  return files
}

/* -------------------------------------------------------------- helpers --- */
async function safeRead(filePath) {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size > MAX_ENTRY_BYTES) return null
    return await readFile(filePath)
  } catch {
    return null
  }
}

function rowJson(row) {
  const output = {}
  for (const [key, value] of Object.entries(row || {})) {
    if (Buffer.isBuffer(value)) output[key] = { __type: 'buffer', base64: value.toString('base64') }
    else output[key] = value
  }
  return output
}

function tableRows(db, table) {
  try { return db.prepare('SELECT * FROM ' + table).all().map(rowJson) } catch { return [] }
}

function archiveName(name) {
  return String(name).replaceAll('\\', '/').replace(/^\/+/, '').replace(/[^A-Za-z0-9._/-]/g, '_')
}

/* --------------------------------------------------------------- export --- */
export async function createBackup({ db, layout, version = '', schemaVersion = 0 }) {
  const data = {}
  for (const table of TABLES) data[table] = tableRows(db, table)

  const entries = []
  const pdfs = []
  for (const row of data.paper_versions) {
    if (!row || typeof row.file_path !== 'string' || row.file_path === '') continue
    const body = await safeRead(row.file_path)
    if (body === null) continue
    const name = 'pdfs/' + String(row.id) + '.pdf'
    entries.push({ name, data: body })
    pdfs.push({ versionId: String(row.id), paperId: String(row.paper_id), name, bytes: body.length, sha256: String(row.sha256 || '') })
  }

  const figures = []
  try {
    const names = await readdir(layout.figuresDir)
    for (const name of names) {
      if (!/\.(png|jpe?g|webp)$/i.test(name)) continue
      const body = await safeRead(path.join(layout.figuresDir, name))
      if (body === null) continue
      const entry = 'figures/' + archiveName(name)
      entries.push({ name: entry, data: body })
      figures.push({ name, entry })
    }
  } catch { /* figures are optional */ }

  const noteAssets = []
  try {
    const names = await readdir(layout.noteAssetsDir)
    for (const name of names) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue
      const body = await safeRead(path.join(layout.noteAssetsDir, name))
      if (body === null) continue
      const entry = 'note-assets/' + archiveName(name)
      entries.push({ name: entry, data: body })
      noteAssets.push({ name, entry })
    }
  } catch { /* note assets are optional */ }

  const counts = {
    papers: data.papers.length,
    notes: data.note_docs.length,
    annotations: data.annotations.length,
    figures: data.figures.length,
    pdfs: pdfs.length,
  }
  const exportedAt = new Date()
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: String(version || ''),
    schemaVersion: Number(schemaVersion) || 0,
    exportedAt: exportedAt.toISOString(),
    counts,
    pdfs,
    figures,
    noteAssets,
  }
  const dataBody = Buffer.from(JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, tables: data }), 'utf8')
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  entries.splice(1, 0, { name: 'data.json', data: dataBody })
  entries.push({ name: 'README.md', data: Buffer.from('# Pappers-Hall backup\n\nImport this ZIP in Pappers-Hall → Settings → Backup & restore. It contains paper metadata, original PDFs, annotations, folders and notes. AI caches and search indexes are rebuilt after import.\n', 'utf8') })
  const buffer = buildZip(entries, exportedAt)
  const stamp = exportedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return { filename: 'pappers-hall-backup-' + stamp + '.zip', buffer, manifest }
}

/* --------------------------------------------------------------- import --- */
function insertRow(db, table, row) {
  if (!row || typeof row !== 'object') return 0
  const columns = Object.keys(row)
  if (columns.length === 0) return 0
  const values = columns.map((key) => (row[key] && typeof row[key] === 'object' && row[key].__type === 'buffer' ? Buffer.from(String(row[key].base64 || ''), 'base64') : row[key]))
  const sql = 'INSERT OR REPLACE INTO ' + table + ' (' + columns.map((key) => '"' + key.replaceAll('"', '""') + '"').join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')'
  db.prepare(sql).run(...values)
  return 1
}

export async function importBackup({ db, layout, search, buffer }) {
  const files = readZip(buffer)
  const manifestFile = files.get('manifest.json')
  const dataFile = files.get('data.json')
  if (!manifestFile || !dataFile) throw new Error('backup is missing manifest.json or data.json')
  let manifest
  let payload
  try {
    manifest = JSON.parse(manifestFile.toString('utf8'))
    payload = JSON.parse(dataFile.toString('utf8'))
  } catch {
    throw new Error('backup JSON is malformed')
  }
  if (!manifest || manifest.format !== FORMAT || Number(manifest.formatVersion) !== FORMAT_VERSION) throw new Error('unsupported backup format')
  if (!payload || payload.format !== FORMAT || !payload.tables || typeof payload.tables !== 'object') throw new Error('backup data is malformed')

  await mkdir(layout.filesDir, { recursive: true })
  await mkdir(layout.figuresDir, { recursive: true })
  await mkdir(layout.noteAssetsDir, { recursive: true })

  const pdfPaths = new Map()
  let restoredPdfs = 0
  for (const item of Array.isArray(manifest.pdfs) ? manifest.pdfs : []) {
    const entry = files.get(item.entry || item.name)
    if (!entry || !/^ph-[a-f0-9]{12}$/.test(String(item.paperId || ''))) continue
    const target = path.join(layout.filesDir, archiveName(String(item.paperId) + '-' + String(item.versionId) + '.pdf'))
    await writeFile(target, entry)
    pdfPaths.set(String(item.versionId), target)
    restoredPdfs += 1
  }

  let restoredFigures = 0
  for (const item of Array.isArray(manifest.figures) ? manifest.figures : []) {
    const entry = files.get(item.entry)
    if (!entry) continue
    await writeFile(path.join(layout.figuresDir, path.basename(String(item.name))), entry)
    restoredFigures += 1
  }
  let restoredAssets = 0
  for (const item of Array.isArray(manifest.noteAssets) ? manifest.noteAssets : []) {
    const entry = files.get(item.entry)
    if (!entry) continue
    await writeFile(path.join(layout.noteAssetsDir, path.basename(String(item.name))), entry)
    restoredAssets += 1
  }

  const tables = payload.tables
  for (const row of Array.isArray(tables.paper_versions) ? tables.paper_versions : []) {
    if (row && pdfPaths.has(String(row.id))) row.file_path = pdfPaths.get(String(row.id))
  }

  const counts = {}
  db.exec('BEGIN')
  try {
    for (const table of TABLES) {
      const rows = Array.isArray(tables[table]) ? tables[table] : []
      let inserted = 0
      for (const row of rows) inserted += insertRow(db, table, row)
      counts[table] = inserted
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
  try { if (search && typeof search.rebuildAll === 'function') search.rebuildAll() } catch { /* index is derived */ }
  return {
    ok: true,
    counts: {
      papers: counts.papers || 0,
      notes: counts.note_docs || 0,
      annotations: counts.annotations || 0,
      figures: counts.figures || restoredFigures,
      pdfs: restoredPdfs,
      noteAssets: restoredAssets,
    },
    exportedAt: manifest.exportedAt || null,
    appVersion: manifest.appVersion || null,
  }
}

export { FORMAT, FORMAT_VERSION }
