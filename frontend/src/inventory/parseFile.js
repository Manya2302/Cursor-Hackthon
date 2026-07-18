/**
 * Client-side inventory file parsing (no backend).
 * Supports CSV, Excel (.xlsx/.xls via SheetJS), and text-ish PDF extraction.
 */

const HEADER_ALIASES = {
  name: ['name', 'product', 'item', 'sku', 'product name', 'item name', 'વસ્તુ', 'નામ'],
  quantity: ['quantity', 'qty', 'stock', 'units', 'count', 'જથ્થો'],
  unit: ['unit', 'uom', 'measure', 'એકમ'],
  price: ['price', 'rate', 'mrp', 'unit price', 'amount', 'કિંમત'],
}

function blankRow() {
  return { name: '', quantity: '', unit: 'pcs', price: '', source: 'manual' }
}

export function emptyInventoryRows(count = 3) {
  return Array.from({ length: count }, () => blankRow())
}

export async function parseInventoryFile(file) {
  if (!file) throw new Error('No file selected.')
  const name = file.name.toLowerCase()
  const ext = name.split('.').pop()

  if (ext === 'csv' || ext === 'txt') {
    const text = await file.text()
    return { items: parseDelimitedText(text), source: 'csv', fileName: file.name }
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const items = await parseExcel(file)
    return { items, source: 'excel', fileName: file.name }
  }

  if (ext === 'pdf') {
    const items = await parsePdfLite(file)
    return { items, source: 'pdf', fileName: file.name }
  }

  throw new Error('Use Excel (.xlsx), CSV, or PDF.')
}

async function parseExcel(file) {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const workbook = XLSX.read(buf, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  })
  return rowsFromObjects(rows, 'excel')
}

function parseDelimitedText(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return []

  const delim = lines[0].includes('\t') ? '\t' : ','
  const cells = lines.map((line) => splitCsvLine(line, delim))
  const header = cells[0].map((h) => String(h).trim().toLowerCase())
  const hasHeader = header.some((h) =>
    Object.values(HEADER_ALIASES).some((list) => list.includes(h)),
  )

  if (hasHeader) {
    const map = mapHeaders(header)
    return cells.slice(1).map((row) => ({
      name: pick(row, map.name),
      quantity: pick(row, map.quantity),
      unit: pick(row, map.unit) || 'pcs',
      price: pick(row, map.price),
      source: 'csv',
    })).filter((r) => r.name)
  }

  // No header: col0=name, col1=qty, col2=unit, col3=price
  return cells
    .map((row) => ({
      name: String(row[0] || '').trim(),
      quantity: String(row[1] || '').trim(),
      unit: String(row[2] || 'pcs').trim() || 'pcs',
      price: String(row[3] || '').trim(),
      source: 'csv',
    }))
    .filter((r) => r.name)
}

function rowsFromObjects(rows, source) {
  if (!rows.length) return []
  const keys = Object.keys(rows[0]).map((k) => k.trim())
  const lower = keys.map((k) => k.toLowerCase())
  const map = mapHeaders(lower)
  return rows
    .map((row) => {
      const values = keys.map((k) => row[k])
      return {
        name: pick(values, map.name),
        quantity: pick(values, map.quantity),
        unit: pick(values, map.unit) || 'pcs',
        price: pick(values, map.price),
        source,
      }
    })
    .filter((r) => r.name)
}

function mapHeaders(headerLower) {
  const find = (aliases) =>
    headerLower.findIndex((h) => aliases.includes(h))
  return {
    name: find(HEADER_ALIASES.name),
    quantity: find(HEADER_ALIASES.quantity),
    unit: find(HEADER_ALIASES.unit),
    price: find(HEADER_ALIASES.price),
  }
}

function pick(row, index) {
  if (index == null || index < 0) return ''
  return String(row[index] ?? '').trim()
}

function splitCsvLine(line, delim) {
  if (delim === '\t') return line.split('\t')
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      inQ = !inQ
      continue
    }
    if (ch === delim && !inQ) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Lightweight PDF text scrape (works for text PDFs, not scanned images).
 */
async function parsePdfLite(file) {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let raw = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i]
    raw += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 || c === 13 ? '\n' : ' '
  }

  const tjMatches = [...raw.matchAll(/\(([^)]{2,80})\)\s*Tj/g)].map((m) => m[1])
  const candidates = tjMatches.length
    ? tjMatches
    : raw
        .split(/[\n\r]+/)
        .map((l) => l.replace(/[^\w\s./%-]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((l) => l.length >= 3 && l.length < 60)

  const items = []
  for (const line of candidates) {
    const cleaned = line.replace(/\\[nrt]/g, ' ').trim()
    if (!cleaned || /^(page|date|total|invoice|bill)\b/i.test(cleaned)) continue
    const qtyMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|l|pcs|pkt|packet)?$/i)
    let name = cleaned
    let quantity = ''
    let unit = 'pcs'
    if (qtyMatch) {
      quantity = qtyMatch[1]
      unit = (qtyMatch[2] || 'pcs').toLowerCase()
      name = cleaned.slice(0, qtyMatch.index).trim() || cleaned
    }
    if (name.length < 2) continue
    if (items.some((i) => i.name.toLowerCase() === name.toLowerCase())) continue
    items.push({ name, quantity, unit, price: '', source: 'pdf' })
    if (items.length >= 40) break
  }

  if (!items.length) {
    return [
      {
        name: '',
        quantity: '',
        unit: 'pcs',
        price: '',
        source: 'pdf',
      },
    ]
  }
  return items
}
