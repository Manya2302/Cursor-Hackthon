import { useRef, useState } from 'react'
import { emptyInventoryRows, parseInventoryFile } from '../inventory/parseFile'

export default function InventorySetup({
  initialItems,
  onSave,
  onSkip,
  saving = false,
  title = 'Add your inventory',
  subtitle = 'Upload Excel / PDF / CSV, or type products. Bill photos will match against this list.',
}) {
  const fileRef = useRef(null)
  const [mode, setMode] = useState('upload')
  const [rows, setRows] = useState(() =>
    initialItems?.length
      ? initialItems.map((i) => ({
          name: i.name || '',
          quantity: i.quantity ?? '',
          unit: i.unit || 'pcs',
          price: i.price ?? '',
          source: i.source || 'manual',
        }))
      : emptyInventoryRows(3),
  )
  const [fileLabel, setFileLabel] = useState('')
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)

  function updateRow(index, key, value) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
    setError('')
  }

  function addRow() {
    setRows((prev) => [...prev, ...emptyInventoryRows(1)])
  }

  function removeRow(index) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setParsing(true)
    setError('')
    try {
      const { items, fileName } = await parseInventoryFile(file)
      setFileLabel(fileName)
      if (!items.length || (items.length === 1 && !items[0].name)) {
        setRows(emptyInventoryRows(3))
        setMode('type')
        setError('Could not read products from that file. Type them below.')
      } else {
        setRows(
          items.map((i) => ({
            name: i.name || '',
            quantity: i.quantity ?? '',
            unit: i.unit || 'pcs',
            price: i.price ?? '',
            source: i.source || 'upload',
          })),
        )
        setMode('type')
      }
    } catch (err) {
      setError(err.message || 'Could not parse file.')
    } finally {
      setParsing(false)
    }
  }

  function handleSave(e) {
    e.preventDefault()
    const filled = rows.filter((r) => String(r.name || '').trim())
    if (!filled.length) {
      setError('Add at least one product, or skip for now.')
      return
    }
    onSave?.(filled)
  }

  const showTable = mode === 'type' || rows.some((r) => r.name)

  return (
    <div className="inventory-setup">
      <header className="inventory-setup-head">
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </header>

      <div className="inv-mode-tabs" role="tablist" aria-label="Inventory entry mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'upload'}
          className={mode === 'upload' ? 'active' : ''}
          onClick={() => setMode('upload')}
        >
          Upload file
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'type'}
          className={mode === 'type' ? 'active' : ''}
          onClick={() => setMode('type')}
        >
          Type products
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {mode === 'upload' && (
        <div className="inv-upload">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={handleFile}
          />
          <button
            type="button"
            className="inv-dropzone"
            onClick={() => fileRef.current?.click()}
            disabled={parsing}
          >
            <strong>{parsing ? 'Reading file…' : 'Choose Excel, CSV, or PDF'}</strong>
            <span>Columns: Name, Quantity, Unit, Price (header row optional)</span>
          </button>
          {fileLabel && <p className="form-note">Loaded: {fileLabel}</p>}
        </div>
      )}

      {showTable && (
        <form className="inv-table-form" onSubmit={handleSave}>
          <div className="inv-table-wrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Price</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`inv-row-${index}`}>
                    <td>
                      <input
                        type="text"
                        placeholder="Sugar"
                        value={row.name}
                        onChange={(e) => updateRow(index, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        inputMode="decimal"
                        placeholder="0"
                        value={row.quantity}
                        onChange={(e) => updateRow(index, 'quantity', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        placeholder="kg"
                        value={row.unit}
                        onChange={(e) => updateRow(index, 'unit', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        inputMode="decimal"
                        placeholder="0"
                        value={row.price}
                        onChange={(e) => updateRow(index, 'price', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="inv-remove"
                        onClick={() => removeRow(index)}
                        aria-label="Remove row"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button type="button" className="btn btn-ghost" onClick={addRow}>
            + Add another product
          </button>

          <button className="btn btn-primary" type="submit" disabled={saving || parsing}>
            {saving ? 'Saving…' : 'Save inventory'}
          </button>
          {onSkip && (
            <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={saving}>
              Skip for now
            </button>
          )}
        </form>
      )}

      {mode === 'upload' && !showTable && onSkip && (
        <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={saving}>
          Skip for now
        </button>
      )}
    </div>
  )
}
