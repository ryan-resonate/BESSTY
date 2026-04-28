// Reusable CRS picker for import dialogs. Renders a single <select> with
// optgroups for Geographic / Web / MGA94 / MGA2020 / NZTM / UK / UTM, plus
// a "Custom proj4 string…" entry that pops a small inline prompt.
//
// All EPSGs in the dropdown are pre-registered with proj4 on module load
// (see lib/projections.ts) — the parent component just reads `value` and
// passes it to `toWgs84` / `fromWgs84`.

import { useMemo, useState } from 'react';
import { groupedEpsgPresets, registerCustomEpsg } from '../lib/projections';

interface Props {
  /// Currently selected EPSG code.
  value: number;
  onChange(epsg: number): void;
  /// Optional label shown above the dropdown.
  label?: string;
  /// Show a hint line beneath the dropdown.
  hint?: string;
}

export function EpsgPicker({ value, onChange, label = 'Coordinate system', hint }: Props) {
  const groups = useMemo(() => groupedEpsgPresets(), []);
  const [showCustom, setShowCustom] = useState(false);
  const [customCode, setCustomCode] = useState('');
  const [customDef, setCustomDef] = useState('');

  function handleSelectChange(v: string) {
    if (v === '__custom__') {
      setShowCustom(true);
      return;
    }
    const epsg = parseInt(v, 10);
    if (Number.isFinite(epsg)) onChange(epsg);
  }

  function commitCustom() {
    const code = parseInt(customCode, 10);
    if (!Number.isFinite(code) || !customDef.trim()) {
      alert('Enter a numeric EPSG code and a proj4 definition string.');
      return;
    }
    registerCustomEpsg(code, customDef.trim());
    onChange(code);
    setShowCustom(false);
    setCustomCode('');
    setCustomDef('');
  }

  return (
    <label className="fld">
      <span>{label}</span>
      <select value={String(value)} onChange={(e) => handleSelectChange(e.target.value)}>
        {groups.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.presets.map((p) => (
              <option key={p.code} value={String(p.code)}>{p.label}</option>
            ))}
          </optgroup>
        ))}
        <optgroup label="Other">
          <option value="__custom__">Custom proj4 string…</option>
        </optgroup>
      </select>
      {hint && <div className="hint">{hint}</div>}
      {showCustom && (
        <div className="settings-section" style={{ marginTop: 6 }}>
          <div className="hint">
            Paste a proj4 definition (e.g. from <a href="https://epsg.io" target="_blank" rel="noreferrer">epsg.io</a>).
            BESSTY will register it for the rest of this session.
          </div>
          <label className="fld">
            <span>EPSG code</span>
            <input type="number" value={customCode} onChange={(e) => setCustomCode(e.target.value)}
              placeholder="e.g. 32633" />
          </label>
          <label className="fld">
            <span>proj4 definition</span>
            <input type="text" value={customDef} onChange={(e) => setCustomDef(e.target.value)}
              placeholder="+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs" />
          </label>
          <div className="add-row">
            <button className="btn small primary" onClick={commitCustom}>Use</button>
            <button className="btn small" onClick={() => setShowCustom(false)}>Cancel</button>
          </div>
        </div>
      )}
    </label>
  );
}
