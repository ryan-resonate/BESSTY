// I14 — formatted XLSX for the factorial study.
//
// `exceljs` rather than the `xlsx` package already in the bundle, because this
// export needs conditional FILL matching the on-screen pass/fail colours, which
// the community `xlsx` build cannot write.

import ExcelJS from 'exceljs';
import type { Project, Receiver } from './types';
import { limitForPeriod } from './types';
import { exceedsLimit, limitComparisonFor } from './limits';
import { worstOf, type AxisSpec, type ComboResult } from './factorial';

const GREEN = 'FFD6F5D6';
const RED = 'FFF8D2D2';
const HEAD = 'FFEFEFEF';

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    c.border = { bottom: { style: 'thin' } };
  });
}

/// One sheet per receiver plus a worst-case summary.
///
/// Batteries across the top, inverters down the side — the locked orientation.
export async function buildFactorialXlsx(
  project: Project,
  battery: AxisSpec,
  inverter: AxisSpec,
  results: ComboResult[],
  receivers: Receiver[],
): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BESSTY';
  const mode = limitComparisonFor(project);
  const period = project.scenario.period;

  const at = (b: number, i: number) =>
    results.find((r) => r.combo.batteryIdx === b && r.combo.inverterIdx === i);

  const metaRows = (ws: ExcelJS.Worksheet, subtitle: string) => {
    ws.addRow([project.name || 'Untitled project']).font = { bold: true, size: 14 };
    ws.addRow([subtitle]);
    ws.addRow([
      `Period: ${period}`,
      `Wind: ${project.scenario.windSpeed} m/s`,
      `Standard: ISO 9613-2:${project.settings?.standard ?? '2024'}`,
      `Limit comparison: ${mode}`,
    ]);
    ws.addRow([]);
  };

  for (const rx of receivers) {
    const limit = limitForPeriod(rx, period);
    const ws = wb.addWorksheet((rx.name || rx.id).slice(0, 28));
    metaRows(ws, `Receiver: ${rx.name || rx.id} — limit ${limit} dB(A) (${period})`);

    styleHeader(ws.addRow(['Inverter \\ Battery', ...battery.candidates.map((c) => c.label)]));
    inverter.candidates.forEach((inv, i) => {
      const row = ws.addRow([
        inv.label,
        ...battery.candidates.map((_, b) => at(b, i)?.byReceiver.get(rx.id) ?? null),
      ]);
      row.getCell(1).font = { bold: true };
      battery.candidates.forEach((_, b) => {
        const cell = row.getCell(b + 2);
        const v = at(b, i)?.byReceiver.get(rx.id);
        if (v == null || !Number.isFinite(v)) return;
        cell.numFmt = '0.0';
        // Same rule as the screen (I17) — an export that disagrees with the UI
        // about pass/fail is a defect, not a formatting choice.
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: exceedsLimit(v, limit, mode) ? RED : GREEN },
        };
      });
    });
    ws.getColumn(1).width = 34;
    battery.candidates.forEach((_, b) => { ws.getColumn(b + 2).width = 16; });
  }

  // ---- worst-case summary ----
  const ws = wb.addWorksheet('Worst case');
  metaRows(ws, 'Worst receiver level per configuration');
  const ids = receivers.map((r) => r.id);
  styleHeader(ws.addRow(['Inverter \\ Battery', ...battery.candidates.map((c) => c.label)]));
  inverter.candidates.forEach((inv, i) => {
    const row = ws.addRow([
      inv.label,
      ...battery.candidates.map((_, b) => {
        const r = at(b, i);
        return r ? worstOf(r, ids) : null;
      }),
    ]);
    row.getCell(1).font = { bold: true };
    battery.candidates.forEach((_, b) => {
      const cell = row.getCell(b + 2);
      const r = at(b, i);
      const v = r ? worstOf(r, ids) : null;
      if (v == null) return;
      cell.numFmt = '0.0';
      // The worst cell is judged against the limit of the receiver it came
      // from, so colour it by whether ANY receiver fails this configuration.
      const anyFail = receivers.some((rx) => {
        const lv = r!.byReceiver.get(rx.id);
        return exceedsLimit(lv, limitForPeriod(rx, period), mode);
      });
      cell.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: anyFail ? RED : GREEN },
      };
    });
  });
  ws.getColumn(1).width = 34;
  battery.candidates.forEach((_, b) => { ws.getColumn(b + 2).width = 16; });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
