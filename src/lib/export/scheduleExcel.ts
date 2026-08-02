import { formatMonthDay, ISODate, weekdayLabelKo } from '@/lib/domain/dateUtils';
import { Block, Holiday, ProcessInstance } from '@/lib/domain/types';
import {
  buildWeeklyScheduleData,
  HEADER_FILL,
  HOLIDAY_FILL,
  BLOCK_NAME_FILL,
  LEGEND_ITEMS,
  isWeeklyHoliday,
} from './weeklyScheduleData';

export { FILL_HEX, SUB_FILL } from './weeklyScheduleData';

const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
// 동이 바뀌는 경계 — 화면(GanttChart)의 검정 굵은 선과 맞춰서 표에서도 동 구간이
// 한눈에 구분되게 한다.
const BLOCK_BOUNDARY_BORDER = { style: 'medium' as const, color: { argb: 'FF18181B' } };

export interface WeeklyScheduleExportParams {
  siteName: string;
  blocks: Block[];
  processes: ProcessInstance[];
  holidays: Holiday[];
  startDate: ISODate;
  weeks: number; // 1~8
  scopeBlockId: 'all' | string;
}

export async function downloadWeeklyScheduleExcel(params: WeeklyScheduleExportParams) {
  const { siteName, blocks, processes, holidays, startDate, weeks, scopeBlockId } = params;
  const ExcelJS = (await import('exceljs')).default;

  const data = buildWeeklyScheduleData({ blocks, processes, holidays, startDate, weeks, scopeBlockId });
  const dayCount = data.dates.length;

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('주간공정표', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });

  sheet.getColumn(1).width = 14;
  for (let i = 0; i < dayCount; i++) {
    sheet.getColumn(2 + i * 2).width = 12;
    sheet.getColumn(3 + i * 2).width = 12;
  }

  sheet.mergeCells(1, 1, 2, 1);
  const cornerCell = sheet.getCell(1, 1);
  cornerCell.value = '구분';
  cornerCell.alignment = { horizontal: 'center', vertical: 'middle' };
  cornerCell.font = { bold: true };
  cornerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };

  data.dates.forEach((d, i) => {
    const col1 = 2 + i * 2;
    const col2 = col1 + 1;
    const fill = isWeeklyHoliday(d, holidays) ? HOLIDAY_FILL : HEADER_FILL;

    sheet.mergeCells(1, col1, 1, col2);
    const dateCell = sheet.getCell(1, col1);
    dateCell.value = `${formatMonthDay(d)} (${weekdayLabelKo(d)})`;
    dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dateCell.font = { bold: true };

    const amCell = sheet.getCell(2, col1);
    amCell.value = '오전';
    const pmCell = sheet.getCell(2, col2);
    pmCell.value = '오후';
    [dateCell, sheet.getCell(1, col2), amCell, pmCell].forEach((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = cell.font ?? { bold: false };
    });
  });

  let rowIdx = 3;
  const blockEndRows: number[] = [];
  for (const row of data.rows) {
    sheet.mergeCells(rowIdx, 1, rowIdx + 1, 1);
    const nameCell = sheet.getCell(rowIdx, 1);
    nameCell.value = row.blockInfo ? `${row.blockName}\n${row.blockInfo}` : row.blockName;
    nameCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    nameCell.font = { bold: true };
    nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLOCK_NAME_FILL } };

    row.cells.forEach((cellData, i) => {
      const col1 = 2 + i * 2;
      const col2 = col1 + 1;

      if (cellData.merged) {
        sheet.mergeCells(rowIdx + 1, col1, rowIdx + 1, col2);
        const cell = sheet.getCell(rowIdx + 1, col1);
        if (cellData.am.text) cell.value = cellData.am.text;
        if (cellData.am.fillArgb) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cellData.am.fillArgb } };
      } else {
        const amCell = sheet.getCell(rowIdx + 1, col1);
        if (cellData.am.text) amCell.value = cellData.am.text;
        if (cellData.am.fillArgb) amCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cellData.am.fillArgb } };

        const pmCell = sheet.getCell(rowIdx + 1, col2);
        if (cellData.pm.text) pmCell.value = cellData.pm.text;
        if (cellData.pm.fillArgb) pmCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cellData.pm.fillArgb } };
      }
    });

    blockEndRows.push(rowIdx + 1);
    rowIdx += 2;
  }

  const lastRow = rowIdx - 1;
  const lastCol = 1 + dayCount * 2;
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= lastCol; c++) {
      const cell = sheet.getCell(r, c);
      cell.border = FULL_BORDER;
      if (r >= 3) {
        cell.alignment = { ...cell.alignment, wrapText: true, vertical: 'middle', horizontal: 'center' };
        cell.font = { ...cell.font, size: 9 };
      }
    }
    if (r >= 3) sheet.getRow(r).height = 32;
  }

  // 동이 바뀌는 경계(각 동의 마지막 행)에 굵은 검은 선을 덧그린다.
  for (const endRow of blockEndRows) {
    for (let c = 1; c <= lastCol; c++) {
      const cell = sheet.getCell(endRow, c);
      cell.border = { ...cell.border, bottom: BLOCK_BOUNDARY_BORDER };
    }
  }

  // 범례: 표 아래에 공정별 색상이 뭘 뜻하는지 두 줄로 적어둔다.
  let legendRow = rowIdx + 1;
  sheet.mergeCells(legendRow, 1, legendRow, lastCol);
  sheet.getCell(legendRow, 1).value = '범례';
  sheet.getCell(legendRow, 1).font = { bold: true };
  legendRow += 1;
  for (const item of LEGEND_ITEMS) {
    sheet.mergeCells(legendRow, 1, legendRow, 2);
    const swatch = sheet.getCell(legendRow, 1);
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.argb } };
    swatch.border = FULL_BORDER;
    sheet.mergeCells(legendRow, 3, legendRow, Math.min(lastCol, 8));
    const labelCell = sheet.getCell(legendRow, 3);
    labelCell.value = item.label;
    labelCell.font = { size: 9 };
    legendRow += 1;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const scopeLabel = scopeBlockId === 'all' ? '전체' : blocks.find((b) => b.id === scopeBlockId)?.name ?? scopeBlockId;
  a.download = `${siteName}_주간공정표_${scopeLabel}_${startDate}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
