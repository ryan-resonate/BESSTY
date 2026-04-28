// Runtime .xlsx → CatalogEntry parser. Mirrors `tools/import_catalog.py` so
// users can upload the same files in-app that the seed importer accepts.
//
// Supports both layouts:
//   - "WTG-style": one workbook per model, one sheet per mode, with R1=Model:,
//     R2=Mode:, optional R3=Type:, then a wind-speed header row and a
//     frequency × wind-speed grid.
//   - "Flat": Model | Mode | Type | <freq1> | <freq2> | ... headers, one row
//     per (model, mode).

import * as XLSX from 'xlsx';
import type { CatalogBandSystem, CatalogEntry, CatalogModeData, SourceKind } from './types';

const KIND_MAP: Record<string, SourceKind> = {
  WTG: 'wtg', 'WIND TURBINE': 'wtg', WINDTURBINE: 'wtg',
  BESS: 'bess', BATTERY: 'bess',
  INVERTER: 'auxiliary', TRANSFORMER: 'auxiliary',
  AUXILIARY: 'auxiliary', AUX: 'auxiliary', OTHER: 'auxiliary',
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function isThirdOctave(frequencies: number[]): boolean {
  const fs = frequencies.filter((f) => f && f > 0);
  if (fs.length < 2) return false;
  const ratios = [];
  for (let i = 1; i < fs.length; i++) if (fs[i - 1] > 0) ratios.push(fs[i] / fs[i - 1]);
  if (ratios.length === 0) return false;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)] < 1.5;
}

function extractRotorDiameter(name: string): number | undefined {
  const v = /\bV[- ]?(\d{2,3})\b/.exec(name);
  if (v) return +v[1];
  const dash = /-(\d{2,3})\b/.exec(name);
  if (dash) return +dash[1];
  return undefined;
}

function cell(ws: XLSX.WorkSheet, r: number, c: number): unknown {
  // r and c are 1-based; aoa returns 0-based rows.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  return aoa[r - 1]?.[c - 1] ?? null;
}

function asString(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

function parseWtgWorkbook(wb: XLSX.WorkBook, fname: string): CatalogEntry[] {
  let entry: CatalogEntry | null = null;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    const r = (row: number, col: number) => aoa[row - 1]?.[col - 1] ?? null;

    if (asString(r(1, 1)) !== 'Model:' || asString(r(2, 1)) !== 'Mode:') continue;
    const model = asString(r(1, 2));
    const mode = asString(r(2, 2));
    if (!model || !mode) continue;

    let kind: SourceKind = 'wtg';
    let windRow = 3;
    let dataStart = 4;
    if (asString(r(3, 1)) === 'Type:') {
      kind = KIND_MAP[asString(r(3, 2)).toUpperCase()] ?? 'wtg';
      windRow = 4;
      dataStart = 5;
    }

    // Wind speeds — column B onward in windRow.
    const windSpeeds: number[] = [];
    const headerRow = aoa[windRow - 1] ?? [];
    for (let c = 1; c < headerRow.length; c++) {
      const v = asNumber(headerRow[c]);
      if (v == null) break;
      windSpeeds.push(v);
    }

    // Frequency rows.
    const frequencies: number[] = [];
    const spectra: Record<string, number[]> = {};
    for (const w of windSpeeds) spectra[String(Number.isInteger(w) ? w : w)] = [];

    for (let row = dataStart - 1; row < aoa.length; row++) {
      const fr = asNumber(aoa[row]?.[0]);
      if (fr == null) continue;
      frequencies.push(fr);
      for (let i = 0; i < windSpeeds.length; i++) {
        const w = windSpeeds[i];
        const key = String(Number.isInteger(w) ? w : w);
        const v = asNumber(aoa[row]?.[1 + i]);
        spectra[key].push(v ?? 0);
      }
    }

    const bandSystem: CatalogBandSystem = isThirdOctave(frequencies) ? 'oneThirdOctave' : 'octave';

    const modeData: CatalogModeData = {
      name: mode, bandSystem, frequencies, spectra, windSpeeds,
    };

    if (!entry) {
      const rotor = extractRotorDiameter(model);
      entry = {
        id: slugify(model), kind, displayName: model, defaultMode: mode,
        modes: [], origin: 'user', source: fname,
      };
      if (rotor) entry.rotorDiameterM = rotor;
    }
    entry.modes.push(modeData);
  }

  return entry ? [entry] : [];
}

function parseFlatWorkbook(wb: XLSX.WorkBook, fname: string): CatalogEntry[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  const headers = aoa[0] ?? [];
  if (headers.length < 4) return [];

  const freqCols: Array<[number, number]> = [];
  for (let i = 3; i < headers.length; i++) {
    const f = asNumber(headers[i]);
    if (f != null) freqCols.push([i, f]);
  }
  if (freqCols.length === 0) return [];
  const frequencies = freqCols.map(([, f]) => f);
  const bandSystem: CatalogBandSystem = isThirdOctave(frequencies) ? 'oneThirdOctave' : 'octave';

  const entries = new Map<string, CatalogEntry>();
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const model = asString(row[0]);
    const mode = asString(row[1]);
    const typeStr = asString(row[2]);
    if (!model || !mode) continue;
    const kind = KIND_MAP[typeStr.toUpperCase()] ?? 'auxiliary';

    const spectrum: number[] = [];
    for (const [colIdx] of freqCols) {
      spectrum.push(asNumber(row[colIdx]) ?? 0);
    }

    const modeData: CatalogModeData = {
      name: mode, bandSystem, frequencies,
      spectra: { broadband: spectrum },
    };

    let entry = entries.get(model);
    if (!entry) {
      entry = {
        id: slugify(model), kind, displayName: model, defaultMode: mode,
        modes: [], origin: 'user', source: fname,
      };
      if (kind === 'auxiliary') entry.auxiliaryType = typeStr.toLowerCase();
      entries.set(model, entry);
    }
    entry.modes.push(modeData);
  }
  return Array.from(entries.values());
}

/// Detect format and parse. Returns one or more CatalogEntry instances.
export async function parseCatalogXlsx(file: File): Promise<CatalogEntry[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  if (wb.SheetNames.length === 0) throw new Error('Empty workbook');
  const first = wb.Sheets[wb.SheetNames[0]];
  const a1 = asString(cell(first, 1, 1));
  const b1 = cell(first, 1, 2);
  if (a1 === 'Model:') return parseWtgWorkbook(wb, file.name);
  if (a1 === 'Model' && asString(b1).toLowerCase() === 'mode') return parseFlatWorkbook(wb, file.name);
  throw new Error(`Unrecognised xlsx layout (cell A1 = ${JSON.stringify(a1)})`);
}
