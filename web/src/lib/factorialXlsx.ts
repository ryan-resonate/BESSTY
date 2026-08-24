// I14 — formatted XLSX for the factorial study.
//
// `exceljs` rather than the `xlsx` package already in the bundle, because this
// export needs conditional FILL matching the on-screen pass/fail colours, which
// the community `xlsx` build cannot write.

import ExcelJS from 'exceljs';
import { weightingFor, weightingLabel } from './weighting';
import type { Project, Receiver } from './types';
import { exceedsLimit, limitComparisonFor, limitFor } from './limits';
import { type AxisSpec, type ComboResult } from './factorial';

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

/// One sheet per receiver — every selected receiver in the one workbook.
///
/// Batteries across the top, inverters down the side — the locked orientation.
export async function buildFactorialXlsx(
  project: Project,
  battery: AxisSpec,
  inverter: AxisSpec,
  results: ComboResult[],
  receivers: Receiver[],
  /// What each axis actually varied. Axes are scoped now — axis 2 can hold a
  /// BESS group — so hardcoding "Inverter \ Battery" would mislabel the file
  /// and lose which group each axis covered.
  axisLabels: { axis1: string; axis2: string } = { axis1: 'Axis 1', axis2: 'Axis 2' },
): Promise<Blob> {
  const corner = `${axisLabels.axis2} \\ ${axisLabels.axis1}`;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BESSTY';
  const mode = limitComparisonFor(project);
  const period = project.scenario.period;

  const at = (b: number, i: number) =>
    results.find((r) => r.combo.batteryIdx === b && r.combo.inverterIdx === i);

  const metaRows = (ws: ExcelJS.Worksheet, subtitle: string) => {
    ws.addRow([project.name || 'Untitled project']).font = { bold: true, size: 14 };
    ws.addRow([subtitle]);
    ws.addRow([`Axis 1 (columns): ${axisLabels.axis1}`, `Axis 2 (rows): ${axisLabels.axis2}`]);
    ws.addRow([
      `Period: ${period}`,
      `Wind: ${project.scenario.windSpeed} m/s`,
      `Standard: ISO 9613-2:${project.settings?.standard ?? '2024'}`,
      `Limit comparison: ${mode}`,
    ]);
    ws.addRow([]);
  };

  for (const rx of receivers) {
    const limit = limitFor(project, rx, period);
    const ws = wb.addWorksheet((rx.name || rx.id).slice(0, 28));
    metaRows(ws, `Receiver: ${rx.name || rx.id} — limit ${limit} ${weightingLabel(weightingFor(project))} (${period})`);

    styleHeader(ws.addRow([corner, ...battery.candidates.map((c) => c.label)]));
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

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
