import { addDays, dayOfWeek, formatMonthDay, ISODate, weekdayLabelKo } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { processLabel } from '@/lib/domain/schedule';
import { Block, Holiday, ProcessInstance } from '@/lib/domain/types';

// PROCESS_COLOR(Tailwind 클래스)와 같은 팔레트를 ARGB 헥스로 옮긴 것 — 엑셀 셀 배경은
// Tailwind 클래스를 못 쓰므로 별도로 들고 있는다.
export const FILL_HEX: Record<string, string> = {
  GANGFORM: 'FFFDBA74', // orange-300
  W_REBAR: 'FF93C5FD', // blue-300
  S_REBAR: 'FF93C5FD',
  AL: 'FFF59E0B', // amber-500
  POUR: 'FFF87171', // red-400
};
export const SUB_FILL = 'FFE4E4E7'; // zinc-200 — 보조공정/커스텀공정
const HOLIDAY_FILL = 'FFFEF3C7'; // amber-100 — 일요일/공휴일 날짜 헤더
const HEADER_FILL = 'FFF4F4F5'; // zinc-100 — 평일 날짜 헤더
const BLOCK_NAME_FILL = 'FFFEF9C3'; // yellow-100 — 동 이름 칸

const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function floorNumberLabel(floorLabel?: string): string {
  if (!floorLabel) return '';
  const digits = floorLabel.match(/^\d+/)?.[0];
  return digits ? `${digits}층` : floorLabel;
}

function isHolidayDate(date: ISODate, holidays: Holiday[]): boolean {
  return dayOfWeek(date) === 0 || holidays.some((h) => h.date === date);
}

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

  const dayCount = Math.max(1, weeks) * 7;
  const dates: ISODate[] = Array.from({ length: dayCount }, (_, i) => addDays(startDate, i));
  const targetBlocks = (scopeBlockId === 'all' ? blocks : blocks.filter((b) => b.id === scopeBlockId))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 층수는 갱폼 공정에만 붙어 있으므로(showFloorLabel), 같은 cycleId의 다른 공정에도 그대로 적용한다.
  const floorByCycle = new Map<string, string>();
  for (const p of processes) {
    if (p.typeCode === 'GANGFORM' && p.floorLabel) floorByCycle.set(p.cycleId, p.floorLabel);
  }

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

  dates.forEach((d, i) => {
    const col1 = 2 + i * 2;
    const col2 = col1 + 1;
    const holiday = isHolidayDate(d, holidays);
    const fill = holiday ? HOLIDAY_FILL : HEADER_FILL;

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
  for (const block of targetBlocks) {
    sheet.mergeCells(rowIdx, 1, rowIdx + 1, 1);
    const nameCell = sheet.getCell(rowIdx, 1);
    nameCell.value = block.info ? `${block.name}\n${block.info}` : block.name;
    nameCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    nameCell.font = { bold: true };
    nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLOCK_NAME_FILL } };

    const blockProcesses = processes.filter((p) => p.blockId === block.id);

    function labelFor(p: ProcessInstance): string {
      const floor = floorNumberLabel(p.typeCode === 'GANGFORM' ? p.floorLabel : floorByCycle.get(p.cycleId));
      return floor ? `${floor} ${processLabel(p)}` : processLabel(p);
    }

    function fillFor(list: ProcessInstance[]): string | undefined {
      const main = list.find((p) => PROCESS_TYPE_MAP[p.typeCode]?.category === 'main');
      if (main) return FILL_HEX[main.typeCode] ?? SUB_FILL;
      return list.length > 0 ? SUB_FILL : undefined;
    }

    dates.forEach((d, i) => {
      const col1 = 2 + i * 2;
      const col2 = col1 + 1;
      const dayProcs = blockProcesses.filter((p) => p.date === d);
      const morning = dayProcs.filter((p) => p.timeSlot === 'morning');
      const afternoon = dayProcs.filter((p) => p.timeSlot === 'afternoon');
      const wholeDay = dayProcs.filter((p) => p.timeSlot !== 'morning' && p.timeSlot !== 'afternoon');

      if (morning.length || afternoon.length) {
        const mList = [...morning, ...wholeDay];
        const mCell = sheet.getCell(rowIdx + 1, col1);
        if (mList.length) mCell.value = mList.map(labelFor).join('\n');
        const mFill = fillFor(mList);
        if (mFill) mCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mFill } };

        const aCell = sheet.getCell(rowIdx + 1, col2);
        if (afternoon.length) aCell.value = afternoon.map(labelFor).join('\n');
        const aFill = fillFor(afternoon);
        if (aFill) aCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: aFill } };
      } else {
        sheet.mergeCells(rowIdx + 1, col1, rowIdx + 1, col2);
        const cell = sheet.getCell(rowIdx + 1, col1);
        if (wholeDay.length) {
          cell.value = wholeDay.map(labelFor).join('\n');
          const fill = fillFor(wholeDay);
          if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        } else if (isHolidayDate(d, holidays)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HOLIDAY_FILL } };
        }
      }
    });

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
