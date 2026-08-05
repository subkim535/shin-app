import { addDays, dayOfWeek, ISODate } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP, customProcessArgb } from '@/lib/domain/processTypes';
import { processLabel, workableSpanEnd } from '@/lib/domain/schedule';
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
  { label: '보조공정 (박리제·검측 등)', argb: SUB_FILL },
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

export interface WeeklyCellLine {
  text: string;
  sub: boolean; // 보조공정 여부 — 엑셀/인쇄에서 주공정과 다르게(작게·들여쓰기) 그린다
}

export interface WeeklyCellGroup {
  text: string; // 전체 텍스트(줄바꿈) — 폴백/하위호환용
  lines: WeeklyCellLine[];
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
    // 구간공정(커스텀 단계)은 단계 이름별 팔레트 색으로 칠한다. 실제 보조공정(박리제 등)만 회색.
    const custom = list.find((p) => p.customLabel && PROCESS_TYPE_MAP[p.typeCode]?.category !== 'sub');
    if (custom?.customLabel) return customProcessArgb(custom.customLabel);
    return list.length > 0 ? SUB_FILL : null;
  }

  function groupFor(list: ProcessInstance[]): WeeklyCellGroup {
    // 주공정을 먼저, 보조공정을 뒤로 정렬해서 표에서도 "주공정 아래에 보조공정"이 되게 한다.
    const sorted = [...list].sort((a, b) => {
      const sa = PROCESS_TYPE_MAP[a.typeCode]?.category === 'sub' ? 1 : 0;
      const sb = PROCESS_TYPE_MAP[b.typeCode]?.category === 'sub' ? 1 : 0;
      return sa - sb;
    });
    const lines: WeeklyCellLine[] = sorted.map((p) => ({
      text: labelFor(p),
      sub: PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub',
    }));
    return { text: lines.map((l) => l.text).join('\n'), lines, fillArgb: fillFor(list) };
  }

  const rows: WeeklyBlockRow[] = targetBlocks.map((block) => {
    const blockProcesses = processes.filter((p) => p.blockId === block.id);
    const cells: WeeklyDayCell[] = dates.map((d) => {
      const startingHere = blockProcesses.filter((p) => p.date === d);
      // 여러 날짜짜리 공정(durationDays>1)이 이 날을 "지나가는(연장)" 경우 — 시작일이 아니라
      // 그 기간 안에 든 날. 라벨은 시작일에만 두고, 연장일에는 색만 이어 칠한다.
      const spanning = blockProcesses.filter((p) => {
        const dur = Math.max(1, Math.floor(p.durationDays || 1));
        // 일수는 작업일 기준 — 중간에 낀 휴일은 빼고 그만큼 뒤로 늘려 색칠 범위를 잡는다.
        return dur > 1 && p.date < d && d <= workableSpanEnd(p.typeCode, p.date, dur, holidays);
      });
      const morning = startingHere.filter((p) => p.timeSlot === 'morning');
      const afternoon = startingHere.filter((p) => p.timeSlot === 'afternoon');
      const wholeDay = startingHere.filter((p) => p.timeSlot !== 'morning' && p.timeSlot !== 'afternoon');
      const holiday = isWeeklyHoliday(d, holidays);

      const emptyGroup = (fillArgb: string | null): WeeklyCellGroup => ({ text: '', lines: [], fillArgb });

      if (morning.length || afternoon.length) {
        const am = groupFor([...morning, ...wholeDay]);
        // 오전칸이 비었으면 지나가는 공정 색을 얹어 색이 이어지게 한다.
        const amWithSpan = am.fillArgb ? am : { ...am, fillArgb: fillFor(spanning) };
        return { date: d, isHoliday: holiday, merged: false, am: amWithSpan, pm: groupFor(afternoon) };
      }
      if (wholeDay.length) {
        const g = groupFor(wholeDay);
        return {
          date: d,
          isHoliday: holiday,
          merged: true,
          am: { ...g, fillArgb: fillFor([...wholeDay, ...spanning]) },
          pm: emptyGroup(null),
        };
      }
      if (spanning.length) {
        // 연장일만 있는 날: 라벨 없이 그 공정 색으로 칸 전체를 칠한다.
        return { date: d, isHoliday: holiday, merged: true, am: emptyGroup(fillFor(spanning)), pm: emptyGroup(null) };
      }
      return {
        date: d,
        isHoliday: holiday,
        merged: true,
        am: emptyGroup(holiday ? HOLIDAY_FILL : null),
        pm: emptyGroup(null),
      };
    });
    return { blockId: block.id, blockName: block.name, blockInfo: block.info, cells };
  });

  return { dates, rows };
}
