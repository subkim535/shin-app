import { ISODate } from '@/lib/domain/dateUtils';

// 동별 주간공정표(scheduleExcel)와 톤을 맞추기 위한 공용 스타일.
const HEADER_FILL = 'FFF4F4F5'; // zinc-100
const TITLE_FILL = 'FFFEF9C3'; // yellow-100 — 주간표의 노란 제목 톤과 맞춤
const SECTION_FILL = 'FFFEF08A'; // yellow-200 — 구분 라벨 톤
const BLOCK_NAME_FILL = 'FFFEF9C3'; // 동 이름 칸
const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
const MEDIUM_BORDER = { style: 'medium' as const, color: { argb: 'FF18181B' } };

export interface DailyGridCell {
  text: string;
  colorHex: string;
}
// 엑셀 간트형 한 줄 = 동 하나. 그날의 오전/오후/종일 주공정 셀 목록.
export interface DailyGridRow {
  blockName: string;
  blockInfo?: string;
  morning: DailyGridCell[];
  afternoon: DailyGridCell[];
  full: DailyGridCell[];
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
  dailyGrid: DailyGridRow[];
  notes: DailyReportNoteRow[];
  labor: DailyReportLaborRow[];
}

// 직영 작업 "고정 순서" — 사용자가 정한 목록. 항상 이 순서로 두되, 그날 인원이 있는 항목만
// 표를 채운다(인원 없으면 표시 안 함). 목록에 없는 구분이 입력돼 있으면 맨 뒤에 이어 붙인다.
const DIRECT_LABOR_ORDER = [
  '관리자', '공사', '직영/용역', '안전', '안전시설', '형틀', 'AL폼', '갱폼', '철근', '타설',
  '시스템', '해체·정리', '할석·미장', '견출', '세대청소', '기타',
];

export async function downloadDailyReportExcel(params: DailyReportExportParams) {
  const { siteName, date, totalHeadcount, crewHeadcount, directHeadcount, dailyGrid, notes, labor } = params;
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('작업일보');
  const LAST_COL = 3;
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 46;
  sheet.getColumn(3).width = 46;

  function fillRow(row: import('exceljs').Row, argb: string) {
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
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
  for (const [k, v] of [['현장명', siteName], ['일자', date], ['총 출력인원', `${totalHeadcount}명 (협력사 ${crewHeadcount}명 + 직영 ${directHeadcount}명)`]] as const) {
    const r = sheet.addRow([k, v, '']);
    sheet.mergeCells(r.number, 2, r.number, LAST_COL);
    r.getCell(1).font = { bold: true };
  }
  sheet.addRow([]);

  // ── 주요작업내용 (간트형: 동 세로 × 오전/오후 가로, 색칠) ──
  sectionHeaderRow('주요작업내용 (장비있으면 장비 포함)');
  colHeaderRow(['동/구간', '오전', '오후']);
  if (dailyGrid.length === 0) {
    fullRowSpan('이 날짜에 예정된 주요공정이 없습니다.');
  }
  function setSlotCell(row: import('exceljs').Row, colIdx: number, cells: DailyGridCell[]) {
    if (cells.length === 0) return;
    const c = row.getCell(colIdx);
    c.value = cells.map((x) => x.text).join(', ');
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cells[0].colorHex } };
    c.font = { bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }
  for (const row of dailyGrid) {
    const nameText = row.blockInfo ? `${row.blockName}\n${row.blockInfo}` : row.blockName;
    const r = sheet.addRow([nameText, '', '']);
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLOCK_NAME_FILL } };
    r.getCell(1).font = { bold: true };
    r.getCell(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    if (row.full.length > 0) {
      // 종일 공정은 오전+오후 칸을 병합해서 한 칸으로 보여준다(주간표와 동일).
      sheet.mergeCells(r.number, 2, r.number, 3);
      setSlotCell(r, 2, [...row.full, ...row.morning, ...row.afternoon]);
    } else {
      setSlotCell(r, 2, row.morning);
      setSlotCell(r, 3, row.afternoon);
    }
    r.height = 28;
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

  // ── 직영 작업 (고정 목록 순서, 그날 인원 있는 항목만) ──
  sectionHeaderRow('직영 작업');
  const laborByCat = new Map<string, DailyReportLaborRow[]>();
  for (const d of labor) {
    if (!d.headcount || d.headcount <= 0) continue; // 인원 없으면 표시 안 함
    if (!laborByCat.has(d.category)) laborByCat.set(d.category, []);
    laborByCat.get(d.category)!.push(d);
  }
  const orderedCats = [
    ...DIRECT_LABOR_ORDER.filter((c) => laborByCat.has(c)),
    ...[...laborByCat.keys()].filter((c) => !DIRECT_LABOR_ORDER.includes(c)),
  ];
  if (orderedCats.length === 0) {
    fullRowSpan('이 날짜에 인원이 배치된 직영 작업이 없습니다.');
  } else {
    colHeaderRow(['구분', '작업내용', '인원']);
    for (const cat of orderedCats) {
      const entries = laborByCat.get(cat)!;
      const totalHc = entries.reduce((s, d) => s + d.headcount, 0);
      const content = entries
        .map((d) => d.workContent + (d.manager ? ` (관리자 ${d.manager})` : ''))
        .filter((t) => t.trim())
        .join(', ');
      const r = sheet.addRow([cat, content, `${totalHc}명`]);
      r.getCell(1).font = { bold: true };
      r.getCell(2).alignment = { wrapText: true, vertical: 'middle' };
      r.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
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
