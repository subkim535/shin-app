import { ISODate } from '@/lib/domain/dateUtils';

const HEADER_FILL = 'FFF4F4F5'; // zinc-100
const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

export interface DailyReportGroupedItem {
  blockName: string;
  floor: string;
  timeSlot?: 'morning' | 'afternoon';
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
  return `${slot}${it.blockName}${it.floor ? ` ${it.floor}` : ''}`;
}

export async function downloadDailyReportExcel(params: DailyReportExportParams) {
  const { siteName, date, totalHeadcount, crewHeadcount, directHeadcount, grouped, notes, labor } = params;
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('작업일보');
  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 60;

  function titleRow(text: string) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).font = { bold: true, size: 13 };
  }
  function sectionHeaderRow(text: string) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  }

  titleRow(`${date.slice(5)} 작업일보`);
  sheet.addRow(['현장명', siteName]);
  sheet.addRow(['일자', date]);
  sheet.addRow(['총 출력인원', `${totalHeadcount}명 (협력사 ${crewHeadcount}명 + 직영 ${directHeadcount}명)`]);
  sheet.addRow([]);

  sectionHeaderRow('작업내용');
  const workHeader = sheet.addRow(['공정', '위치']);
  workHeader.font = { bold: true };
  if (grouped.length === 0) {
    sheet.addRow(['이 날짜에 예정된 공정이 없습니다.']);
  }
  for (const g of grouped) {
    const row = sheet.addRow([g.label, g.items.map(itemLabel).join(', ')]);
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.colorHex } };
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
  }
  sheet.addRow([]);

  sectionHeaderRow('특이사항');
  if (notes.length === 0) {
    sheet.addRow(['이 날짜에 등록된 특이사항이 없습니다.']);
  } else {
    const noteHeader = sheet.addRow(['동', '내용']);
    noteHeader.font = { bold: true };
    for (const n of notes) {
      const row = sheet.addRow([n.blockName, n.text]);
      row.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
    }
  }
  sheet.addRow([]);

  sectionHeaderRow('직영 작업');
  if (labor.length === 0) {
    sheet.addRow(['등록된 직영 작업이 없습니다.']);
  } else {
    const laborHeader = sheet.addRow(['구분', '관리자', '작업내용', '인원']);
    laborHeader.font = { bold: true };
    for (const d of labor) {
      sheet.addRow([d.category, d.manager ?? '', d.workContent, d.headcount]);
    }
  }

  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = FULL_BORDER;
    });
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
