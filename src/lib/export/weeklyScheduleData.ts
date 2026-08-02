import { addDays, dayOfWeek, ISODate } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { processLabel } from '@/lib/domain/schedule';
import { Block, Holiday, ProcessInstance } from '@/lib/domain/types';

// 색칠 팔레트 — 엑셀(ARGB)과 인쇄용 HTML(CSS hex)이 같은 값을 공유한다.
// GanttChart/PROCESS_COLOR와 같은 톤으로 맞춰서 앱 화면과 한눈에 대응된다.
export const FILL_HEX: Record<string, string> = {
  GANGFORM: 'FFFDBA74', // orange-300
  W_REBAR: 'FF93C5FD', // blue-300
  S_REBAR: 'FF93C5FD',
  AL: 'FFF59E0B', // amber-500
  POUR: 'FFF87171', // red-400
};
export const SUB_FILL = 'FFE4E4E7'; // zinc-200 — 보조공정/커스텀공정
export const HOLIDAY_FILL = 'FFFEF3C7'; // amber-100 — 일요일/공휴일 날짜 헤더
export const HEADER_FILL = 'FFF4F4F5'; // zinc-100 — 평일 날짜 헤더
export const BLOCK_NAME_FILL = 'FFFEF9C3'; // yellow-100 — 동 이름 칸

// ARGB('FFRRGGBB') -> CSS hex('#RRGGBB'). 앞 2자리(알파)만 잘라낸다.
export function argbToCss(argb: string): string {
  return `#${argb.slice(2)}`;
}

export const LEGEND_ITEMS: { label: string; argb: string }[] = [
  { label: '갱폼', argb: FILL_HEX.GANGFORM },
  { label: '철근 (W_철근/S_철근)', argb: FILL_HEX.W_REBAR },
  { label: 'AL', argb: FILL_HEX.AL },
  { label: '타설', argb: FILL_HEX.POUR },
  { label: '보조공정 · 기초/지하층 등 구간공정', argb: SUB_FILL },
  { label: '일요일 · 공휴일', argb: HOLIDAY_FILL },
];

function floorNumberLabel(floorLabel?: string): string {
  if (!floorLabel) return '';
  const digits = floorLabel.match(/^\d+/)?.[0];
  return digits ? `${digits}층` : floorLabel;
}

export function isWeeklyHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return dayOfWeek(date) === 0 || holidays.some((h) => h.date === date);
}

export interface WeeklyCellGroup {
  text: string;
  fillArgb: string | null;
}

export interface WeeklyDayCell {
  date: ISODate;
  isHoliday: boolean;
  merged: boolean; // true면 am만 채워지고(전체 병합 칸), pm은 항상 빈 값
  am: WeeklyCellGroup;
  pm: WeeklyCellGroup;
}

export interface WeeklyBlockRow {
  blockId: string;
  blockName: string;
  blockInfo?: string;
  cells: WeeklyDayCell[];
}

export interface WeeklyScheduleData {
  dates: ISODate[];
  rows: WeeklyBlockRow[];
}

export interface WeeklyScheduleParams {
  blocks: Block[];
  processes: ProcessInstance[];
  holidays: Holiday[];
  startDate: ISODate;
  weeks: number; // 1~8
  scopeBlockId: 'all' | string;
}

export function buildWeeklyScheduleData(params: WeeklyScheduleParams): WeeklyScheduleData {
  const { blocks, processes, holidays, startDate, weeks, scopeBlockId } = params;
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

  function labelFor(p: ProcessInstance): string {
    const floor = floorNumberLabel(p.typeCode === 'GANGFORM' ? p.floorLabel : floorByCycle.get(p.cycleId));
    return floor ? `${floor} ${processLabel(p)}` : processLabel(p);
  }

  function fillFor(list: ProcessInstance[]): string | null {
    const main = list.find((p) => PROCESS_TYPE_MAP[p.typeCode]?.category === 'main');
    if (main) return FILL_HEX[main.typeCode] ?? SUB_FILL;
    return list.length > 0 ? SUB_FILL : null;
  }

  const rows: WeeklyBlockRow[] = targetBlocks.map((block) => {
    const blockProcesses = processes.filter((p) => p.blockId === block.id);
    const cells: WeeklyDayCell[] = dates.map((d) => {
      const dayProcs = blockProcesses.filter((p) => p.date === d);
      const morning = dayProcs.filter((p) => p.timeSlot === 'morning');
      const afternoon = dayProcs.filter((p) => p.timeSlot === 'afternoon');
      const wholeDay = dayProcs.filter((p) => p.timeSlot !== 'morning' && p.timeSlot !== 'afternoon');
      const holiday = isWeeklyHoliday(d, holidays);

      if (morning.length || afternoon.length) {
        const mList = [...morning, ...wholeDay];
        return {
          date: d,
          isHoliday: holiday,
          merged: false,
          am: { text: mList.map(labelFor).join('\n'), fillArgb: fillFor(mList) },
          pm: { text: afternoon.map(labelFor).join('\n'), fillArgb: fillFor(afternoon) },
        };
      }
      if (wholeDay.length) {
        return {
          date: d,
          isHoliday: holiday,
          merged: true,
          am: { text: wholeDay.map(labelFor).join('\n'), fillArgb: fillFor(wholeDay) },
          pm: { text: '', fillArgb: null },
        };
      }
      return {
        date: d,
        isHoliday: holiday,
        merged: true,
        am: { text: '', fillArgb: holiday ? HOLIDAY_FILL : null },
        pm: { text: '', fillArgb: null },
      };
    });
    return { blockId: block.id, blockName: block.name, blockInfo: block.info, cells };
  });

  return { dates, rows };
}
