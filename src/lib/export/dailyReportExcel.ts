import { ISODate } from '@/lib/domain/dateUtils';

// 동별 주간공정표(scheduleExcel)와 톤을 맞추기 위한 공용 스타일.
const HEADER_FILL = 'FFF4F4F5'; // zinc-100
const TITLE_FILL = 'FFFEF9C3'; // yellow-100 — 주간표의 노란 제목 톤과 맞춤
const SECTION_FILL = 'FFFEF08A'; // yellow-200 — 구분(공종) 라벨 톤
const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
const MEDIUM_BORDER = { style: 'medium' as const, color: { argb: 'FF18181B' } };

export interface DailyReportGroupedItem {
  blockName: string;
  floor: string;
  timeSlot?: 'morning' | 'afternoon';
  headcount?: number;
}

export interface DailyReportGroupedRow {
  label: string;
  colorHex: string;
  items: DailyReportGroupedItem[];
}

export interface DailyReportNoteRow {
  blockName: string;
  text: string;
}

export interface DailyReportLaborRow {
  category: string;
  manager?: string;
  workContent: string;
  headcount: number;
}

export interface DailyReportExportParams {
  siteName: string;
  date: ISODate;
  totalHeadcount: number;
  crewHeadcount: number;
  directHeadcount: number;
  grouped: DailyReportGroupedRow[];
  notes: DailyReportNoteRow[];
  labor: DailyReportLaborRow[];
}

function itemLabel(it: DailyReportGroupedItem): string {
  const slot = it.timeSlot === 'morning' ? '오전 ' : it.timeSlot === 'afternoon' ? '오후 ' : '';
  const hc = it.headcount ? ` ${it.headcount}명` : '';
  return `${slot}${it.blockName}${it.floor ? ` ${it.floor}` : ''}${hc}`;
}

export async function downloadDailyReportExcel(params: DailyReportExportParams) {
  const { siteName, date, totalHeadcount, crewHeadcount, directHeadcount, grouped, notes, labor } = params;
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('작업일보');
  const LAST_COL = 3;
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 62;
  sheet.getColumn(3).width = 12;

  function fillRow(row: import('exceljs').Row, argb: string) {
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
  // 동별 주간공정표와 톤을 맞춘 제목/구분/열머리 스타일.
  function titleRow(text: string) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, LAST_COL);
    row.getCell(1).font = { bold: true, size: 15 };
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    fillRow(row, TITLE_FILL);
    row.height = 26;
  }
  function sectionHeaderRow(text: string) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, LAST_COL);
    row.getCell(1).font = { bold: true, size: 12 };
    fillRow(row, SECTION_FILL);
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).border = { ...FULL_BORDER, bottom: MEDIUM_BORDER };
  }
  function colHeaderRow(cells: (string | number)[]) {
    const row = sheet.addRow(cells);
    row.font = { bold: true };
    fillRow(row, HEADER_FILL);
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
  }
  function fullRowSpan(text: string) {
    const r = sheet.addRow([text]);
    sheet.mergeCells(r.number, 1, r.number, LAST_COL);
    r.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
  }

  titleRow(`${date.slice(5)} 작업일보 — ${siteName}`);
  const infoName = sheet.addRow(['현장명', siteName]);
  infoName.getCell(1).font = { bold: true };
  const infoDate = sheet.addRow(['일자', date]);
  infoDate.getCell(1).font = { bold: true };
  const infoHc = sheet.addRow(['총 출력인원', `${totalHeadcount}명 (협력사 ${crewHeadcount}명 + 직영 ${directHeadcount}명)`]);
  infoHc.getCell(1).font = { bold: true };
  sheet.addRow([]);

  // ── 주요작업내용 (주공정만, 인원 포함) ──
  sectionHeaderRow('주요작업내용 (장비있으면 장비 포함)');
  colHeaderRow(['공정', '위치 · 인원', '인원']);
  if (grouped.length === 0) {
    fullRowSpan('이 날짜에 예정된 주요공정이 없습니다.');
  }
  for (const g of grouped) {
    const total = g.items.reduce((s, it) => s + (it.headcount ?? 0), 0);
    const row = sheet.addRow([g.label, g.items.map(itemLabel).join(', '), total > 0 ? `${total}명` : '']);
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.colorHex } };
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
  }
  sheet.addRow([]);

  // ── 특이사항 ──
  sectionHeaderRow('특이사항');
  if (notes.length === 0) {
    fullRowSpan('이 날짜에 등록된 특이사항이 없습니다.');
  } else {
    colHeaderRow(['동', '내용', '']);
    for (const n of notes) {
      const row = sheet.addRow([n.blockName, n.text, '']);
      sheet.mergeCells(row.number, 2, row.number, LAST_COL);
      row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    }
  }
  sheet.addRow([]);

  // ── 직영 작업 ──
  sectionHeaderRow('직영 작업');
  if (labor.length === 0) {
    fullRowSpan('등록된 직영 작업이 없습니다.');
  } else {
    colHeaderRow(['구분', '작업내용', '인원']);
    for (const d of labor) {
      const row = sheet.addRow([d.category, d.workContent + (d.manager ? ` (관리자 ${d.manager})` : ''), d.headcount]);
      row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
      row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    }
  }

  // ── 범례(공종 색) — 주간표와 동일하게 색이 뭘 뜻하는지 ──
  if (grouped.length > 0) {
    sheet.addRow([]);
    const legendHeader = sheet.addRow(['범례']);
    sheet.mergeCells(legendHeader.number, 1, legendHeader.number, LAST_COL);
    legendHeader.getCell(1).font = { bold: true };
    for (const g of grouped) {
      const row = sheet.addRow(['', g.label, '']);
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.colorHex } };
      sheet.mergeCells(row.number, 2, row.number, LAST_COL);
      row.getCell(2).alignment = { vertical: 'middle' };
    }
  }

  // 전체 셀 테두리(1~3열).
  sheet.eachRow((row) => {
    for (let c = 1; c <= LAST_COL; c++) {
      const cell = row.getCell(c);
      if (!cell.border) cell.border = FULL_BORDER;
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${siteName}_작업일보_${date}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
