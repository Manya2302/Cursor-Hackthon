const STORAGE_KEY = 'nirvha_inventory_by_user'

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveAll(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function getInventory(userId) {
  if (!userId) return []
  const all = loadAll()
  return Array.isArray(all[userId]) ? all[userId] : []
}

export function saveInventory(userId, items) {
  if (!userId) throw new Error('Missing user id for inventory.')
  const cleaned = (items || [])
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => item.name)
  const all = loadAll()
  all[userId] = cleaned
  saveAll(all)
  return cleaned
}

export function normalizeItem(item = {}, index = 0) {
  const name = String(item.name || '').trim()
  const unit = String(item.unit || 'pcs').trim() || 'pcs'
  const qtyRaw = item.quantity ?? item.qty ?? item.stock
  const priceRaw = item.price ?? item.unit_price
  const quantity = qtyRaw === '' || qtyRaw == null ? null : Number(qtyRaw)
  const price = priceRaw === '' || priceRaw == null ? null : Number(priceRaw)

  return {
    id: item.id || crypto.randomUUID(),
    name,
    unit,
    quantity: Number.isFinite(quantity) ? quantity : null,
    price: Number.isFinite(price) ? price : null,
    aliases: Array.isArray(item.aliases)
      ? item.aliases.map((a) => String(a).trim()).filter(Boolean)
      : [],
    source: item.source || 'manual',
    updatedAt: new Date().toISOString(),
    sort: index,
  }
}

/**
 * Fuzzy-match bill line names against stored inventory (frontend demo).
 */
export function matchBillLinesToInventory(billLines, inventory) {
  const stock = inventory || []
  return (billLines || []).map((line) => {
    const raw = String(line.name || line || '').trim()
    const hit = findBestMatch(raw, stock)
    return {
      billName: raw,
      quantity: line.quantity ?? null,
      unit: line.unit || null,
      matched: Boolean(hit),
      product: hit
        ? {
            id: hit.id,
            name: hit.name,
            unit: hit.unit,
            price: hit.price,
            quantity: hit.quantity,
          }
        : null,
      confidence: hit ? hit._score : 0,
    }
  })
}

function findBestMatch(rawName, inventory) {
  const needle = normalizeName(rawName)
  if (!needle) return null

  let best = null
  for (const item of inventory) {
    const candidates = [item.name, ...(item.aliases || [])]
    for (const c of candidates) {
      const hay = normalizeName(c)
      if (!hay) continue
      let score = 0
      if (hay === needle) score = 1
      else if (hay.includes(needle) || needle.includes(hay)) score = 0.85
      else if (tokenOverlap(needle, hay) >= 0.5) score = 0.7
      if (score > (best?._score || 0)) {
        best = { ...item, _score: score }
      }
    }
  }
  return best && best._score >= 0.7 ? best : null
}

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0a80-\u0aff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenOverlap(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean))
  const tb = new Set(b.split(' ').filter(Boolean))
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  return inter / Math.max(ta.size, tb.size)
}

/**
 * Demo “OCR” from a bill image filename + inventory — no backend.
 * Uses filename tokens and a couple of random stock items to simulate a scan.
 */
export function demoOcrFromBill(fileName, inventory) {
  const stock = inventory || []
  const base = String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')

  const lines = []
  for (const item of stock) {
    const n = normalizeName(item.name)
    if (n && normalizeName(base).includes(n.split(' ')[0]) && n.split(' ')[0].length > 2) {
      lines.push({
        name: item.name,
        quantity: 1,
        unit: item.unit,
      })
    }
  }

  if (!lines.length && stock.length) {
    const pick = stock.slice(0, Math.min(3, stock.length))
    for (const item of pick) {
      lines.push({
        name: item.name,
        quantity: item.quantity != null ? 1 : null,
        unit: item.unit,
      })
    }
  }

  if (!lines.length) {
    lines.push({ name: base || 'Unknown item', quantity: 1, unit: 'pcs' })
  }

  return lines
}
