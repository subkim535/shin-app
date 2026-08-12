import { addDays, dayOfWeek, diffDays, ISODate } from './dateUtils';
import { CONFLICT_GROUP, MAIN_SEQUENCE_CODES, PROCESS_TYPE_MAP } from './processTypes';
import { ChangeRecord, Holiday, ProcessInstance, ProcessTemplate } from './types';

let arrivalCounter = 0;
function nextArrival() {
  arrivalCounter += 1;
  return arrivalCounter;
}

// 근로자의 날(5/1)은 매년 반복되는 법정 휴일이라, 휴일 목록에 매년 등록하지 않아도
// 항상 전 공종 작업 금지로 취급한다.
export function isWorkersDay(date: ISODate): boolean {
  return date.slice(5) === '05-01';
}

function isPublicHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return isWorkersDay(date) || holidays.some((h) => h.date === date && h.kind !== 'sunday');
}

// 문서 2.5 휴일 규칙: 타설(토·일·공휴일 금지), 갱폼(일·공휴일 금지), 그 외 공종은
// 일·공휴일 금지. 사용자가 직접 드래그해도 예외 없이 항상 이 규칙을 그대로 적용한다 —
// 어떤 조작(직접 이동/자동 생성/후속 연쇄/전체 순연/연장)으로도 막힌 날짜는 절대 쓰지 않는다.
export function isBlockedForType(typeCode: string, date: ISODate, holidays: Holiday[]): boolean {
  const dow = dayOfWeek(date);
  const sunday = dow === 0;
  const saturday = dow === 6;
  const publicHoliday = isPublicHoliday(date, holidays);
  if (typeCode === 'POUR') return saturday || sunday || publicHoliday;
  if (typeCode === 'GANGFORM') return sunday || publicHoliday;
  if (sunday) return true;
  return publicHoliday;
}

// 오전/오후로 반나절씩 나뉜 두 주요공정이 실제로 시간대가 겹치는지 판정한다.
// timeSlot이 'morning'|'afternoon'이 아닌 값(종일/미지정)은 하루 전체를 차지하는
// 것으로 보고 항상 겹침 처리한다 — 명시적으로 반나절로 나눈 경우에만 같은 날 공존을 허용한다.
function slotsOverlap(a: ProcessInstance['timeSlot'], b: ProcessInstance['timeSlot']): boolean {
  if (a !== 'morning' && a !== 'afternoon') return true;
  if (b !== 'morning' && b !== 'afternoon') return true;
  return a === b;
}

/**
 * 칩의 오전/오후/종일 토글 버튼은 캐스케이드 재계산 없이 그 공정의 timeSlot만 바로
 * 바꾸는 단순 조작이라, 같은 동·같은 날짜의 다른 주요공정과 겹치게 되는 조합(예:
 * 이미 오후로 나뉜 공정이 있는데 다른 하나를 종일로 바꾸는 경우)을 그대로 허용해버리면
 * slotsOverlap 불변식이 깨진 채로 저장된다. 바꾸기 전에 미리 확인해서, 겹치게 될
 * 상대 공정이 있으면 그 공정을 돌려준다(없으면 null).
 */
export function findTimeSlotConflict(
  processes: ProcessInstance[],
  processId: string,
  newSlot: ProcessInstance['timeSlot'],
): ProcessInstance | null {
  const target = processes.find((p) => p.id === processId);
  if (!target) return null;
  return (
    processes.find(
      (p) =>
        p.id !== processId &&
        p.blockId === target.blockId &&
        p.date === target.date &&
        PROCESS_TYPE_MAP[p.typeCode]?.category === 'main' &&
        slotsOverlap(newSlot, p.timeSlot),
    ) ?? null
  );
}

function nextWorkableDate(typeCode: string, date: ISODate, holidays: Holiday[]): ISODate {
  let d = date;
  while (isBlockedForType(typeCode, d, holidays)) {
    d = addDays(d, 1);
  }
  return d;
}

// 앞(과거)으로 가장 가까운 작업 가능일. 사이클을 앞당길 때 앵커(갱폼)가 휴일에 걸리면
// nextWorkableDate처럼 뒤로 되밀면 앞당김이 상쇄되므로, 이때는 과거 방향으로 스냅한다.
function prevWorkableDate(typeCode: string, date: ISODate, holidays: Holiday[]): ISODate {
  let d = date;
  let guard = 0;
  while (isBlockedForType(typeCode, d, holidays) && guard++ < 400) {
    d = addDays(d, -1);
  }
  return d;
}

// 일수(durationDays)는 "작업일" 기준으로 센다 — start(작업일 가정)부터 durationDays 만큼의
// 작업일을 차지할 때 마지막 작업일의 날짜를 돌려준다. 사이에 낀 휴일은 일수에서 빼고 그만큼
// 뒤로 늘린다(예: 2일인데 하루가 휴일이면 그 다음 작업일까지). 그래서 다음 공정도 그만큼 밀린다.
export function workableSpanEnd(typeCode: string, start: ISODate, durationDays: number | undefined, holidays: Holiday[]): ISODate {
  const span = Math.max(1, Math.floor(durationDays || 1));
  let d = start;
  for (let i = 1; i < span; i++) {
    d = nextWorkableDate(typeCode, addDays(d, 1), holidays);
  }
  return d;
}

function makeProcess(
  blockId: string,
  typeCode: string,
  date: ISODate,
  cycleId: string,
  opts: { floorLabel?: string; linkedMainProcessId?: string; customLabel?: string; durationDays?: number } = {},
): ProcessInstance {
  return {
    id: crypto.randomUUID(),
    blockId,
    typeCode,
    date,
    cycleId,
    floorLabel: opts.floorLabel,
    linkedMainProcessId: opts.linkedMainProcessId,
    customLabel: opts.customLabel,
    durationDays: opts.durationDays,
  };
}

export function setCrew(processes: ProcessInstance[], processId: string, team: string, headcount: number): ProcessInstance[] {
  return processes.map((p) =>
    p.id === processId ? { ...p, crew: team.trim() ? { team: team.trim(), headcount } : undefined } : p,
  );
}

function attachSubProcesses(
  blockId: string,
  mainCode: string,
  mainDate: ISODate,
  mainId: string,
  cycleId: string,
): ProcessInstance[] {
  const subs: ProcessInstance[] = [];
  if (mainCode === 'GANGFORM') {
    subs.push(makeProcess(blockId, 'RELEASE_AGENT', mainDate, cycleId, { linkedMainProcessId: mainId }));
  }
  if (mainCode === 'W_REBAR') {
    subs.push(makeProcess(blockId, 'REBAR_INSPECTION', mainDate, cycleId, { linkedMainProcessId: mainId }));
  }
  if (mainCode === 'S_REBAR') {
    subs.push(makeProcess(blockId, 'ELECTRIC_FACILITY', mainDate, cycleId, { linkedMainProcessId: mainId }));
    subs.push(makeProcess(blockId, 'REBAR_INSPECTION', mainDate, cycleId, { linkedMainProcessId: mainId }));
  }
  if (mainCode === 'POUR') {
    subs.push(makeProcess(blockId, 'TROWEL', addDays(mainDate, 1), cycleId, { linkedMainProcessId: mainId }));
  }
  return subs;
}

// 기준층 주요공정 순서: 갱폼 -> W_철근 -> AL -> S_철근 -> 타설 (+ 보조공정 자동배치)
// 하나의 호출로 만들어진 주요/보조공정은 같은 cycleId로 묶여, 같은 동에 여러 층 사이클이
// 동시에 흘러도 이동 시 서로 다른 사이클을 잘못 건드리지 않는다.
export function generateBaseFloorSequence(
  blockId: string,
  floor: string,
  startDate: ISODate,
  holidays: Holiday[],
  gapDays: number = 1,
  // 각 주요공정(갱폼→W_철근→AL→S_철근→타설)에서 다음 공정까지의 일수(간격)를 공정별로
  // 지정할 수 있다. 넘기지 않으면 모든 공정에 gapDays를 균일하게 적용한다(기존 동작).
  stepGaps?: number[],
): ProcessInstance[] {
  const cycleId = crypto.randomUUID();
  const result: ProcessInstance[] = [];
  let cursor = startDate;
  MAIN_SEQUENCE_CODES.forEach((code, i) => {
    const def = PROCESS_TYPE_MAP[code];
    const date = nextWorkableDate(code, cursor, holidays);
    const main = makeProcess(blockId, code, date, cycleId, { floorLabel: def.showFloorLabel ? floor : undefined });
    result.push(main);
    result.push(...attachSubProcesses(blockId, code, date, main.id, cycleId));
    const gap = stepGaps && stepGaps[i] != null ? Math.max(1, Math.floor(stepGaps[i])) : gapDays;
    cursor = addDays(date, gap);
  });
  return result;
}

// "16F" -> "17F"처럼 앞의 숫자만 1 증가시킨다. 숫자가 없는 라벨(자유 텍스트)은 그대로 둔다.
function nextFloorLabel(floor: string): string {
  const match = floor.match(/^(\d+)(.*)$/);
  if (!match) return floor;
  return `${Number(match[1]) + 1}${match[2]}`;
}

/**
 * 기초/지하층 등 지상층과 순서가 다른 구간을 위한 단순 순차 템플릿 생성.
 * 지상층 엔진과 달리 보조공정 자동배치·전용 휴일규칙·후속 연쇄이동·순서 불변 검증은
 * 아직 붙이지 않았다 (원 기획서에도 "추후 별도 설계"로 남겨진 영역). 자유공정처럼
 * 각 스텝을 자유롭게 이동할 수 있는 수준으로만 우선 지원한다.
 */
// 구간공정(커스텀 단계)을 (blockId, fromDate, timeSlot)로 놓을 때, 같은 동에서 이미 차
// 있는(슬롯이 겹치는) 칸을 피할 수 있는 가장 이른 작업 가능일을 찾는다. 주요공정과
// 마찬가지로 오전/오후로 정확히 나뉘면 공존을 허용하고(slotsOverlap=false), 종일이거나
// 같은 반나절이면 겹침으로 보고 다음 날로 넘긴다. 보조공정(배지)은 칸을 차지하지 않는
// 것으로 본다. occupied에는 기존 공정 + 이번에 이미 놓은 단계들을 넘긴다.
export function firstFreeDateForCustom(
  code: string,
  fromDate: ISODate,
  timeSlot: ProcessInstance['timeSlot'],
  occupied: ProcessInstance[],
  blockId: string,
  holidays: Holiday[],
  excludeId?: string,
): ISODate {
  const collides = (date: ISODate) =>
    occupied.some((p) => {
      if (p.id === excludeId || p.blockId !== blockId) return false;
      if (PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') return false;
      if (!slotsOverlap(timeSlot, p.timeSlot)) return false;
      // 여러 날짜짜리 공정(durationDays)은 그 "작업일" 수만큼을 모두 점유한 것으로 본다 —
      // 사이에 낀 휴일은 일수에서 빼고 그만큼 뒤로 늘려서(2일인데 하루가 휴일이면 그 다음
      // 작업일까지) 계산한다. 새 공정은 그 기간 다음부터 놓인다.
      const endDate = workableSpanEnd(p.typeCode, p.date, p.durationDays, holidays);
      return date >= p.date && date <= endDate;
    });
  let d = nextWorkableDate(code, fromDate, holidays);
  let guard = 0;
  while (collides(d) && guard++ < 400) {
    d = nextWorkableDate(code, addDays(d, 1), holidays);
  }
  return d;
}

export function generateFromTemplate(
  template: ProcessTemplate,
  blockId: string,
  startDate: ISODate,
  holidays: Holiday[] = [],
  // stepDates: 사용자가 생성 모달의 "선택한 순서"에서 특정 단계의 날짜를 직접 바꾼 경우(코드→날짜).
  // 지정된 단계는 그 날에 그대로 놓아(겹쳐도 허용, 휴일 회피 안 함) 여러 단계를 같은 날에 겹칠 수 있다.
  opts: { skipOptional?: boolean; floorLabel?: string; allowStartHoliday?: boolean; stepDates?: Record<string, ISODate> } = {},
  existing: ProcessInstance[] = [],
): ProcessInstance[] {
  const cycleId = crypto.randomUUID();
  const result: ProcessInstance[] = [];
  let cursor = startDate; // 순차 흐름 포인터 — 지정 안 된 단계는 여기서부터 빈 날을 찾는다.
  let firstPlaced = true;
  for (const step of template.steps) {
    if (step.optional && opts.skipOptional) continue;
    const override = opts.stepDates?.[step.code];
    let place: ISODate;
    if (override) {
      // 사용자가 이 단계 날짜를 직접 지정함 — 겹쳐도 그 날에 그대로(휴일도 회피 안 함).
      place = override;
    } else if (firstPlaced && opts.allowStartHoliday) {
      // 사용자가 "휴일이어도 이 날 시작"을 확인함 — 첫 단계는 휴일 스킵 없이 고른 날에 그대로.
      place = startDate;
    } else {
      // 기존 공정 + 이번에 이미 놓은 단계와 안 겹치는 가장 이른 날짜로 배치(겹침·휴일 회피).
      place = firstFreeDateForCustom(step.code, cursor, undefined, [...existing, ...result], blockId, holidays);
    }
    firstPlaced = false;
    const span = Math.max(1, step.durationDays || 1);
    const main = makeProcess(blockId, step.code, place, cycleId, {
      customLabel: step.name,
      durationDays: span > 1 ? span : undefined,
      floorLabel: opts.floorLabel || undefined,
    });
    result.push(main);
    // 순차 커서는 항상 앞으로만 — 지정 단계가 앞쪽에 놓여도 뒤 단계가 거꾸로 가지 않게 한다.
    const next = addDays(workableSpanEnd(step.code, place, span, holidays), 1);
    if (next > cursor) cursor = next;
  }
  return result;
}

// 기초/지하층처럼 같은 템플릿 사이클을 여러 번(예: 지하 B4~B1) 이어서 반복 생성한다.
// 각 사이클은 이전 사이클의 마지막 단계 다음 날부터 시작한다.
export function generateRepeatingFromTemplate(
  template: ProcessTemplate,
  blockId: string,
  startDate: ISODate,
  holidays: Holiday[],
  repeatCount: number,
  opts: { skipOptional?: boolean; floorLabel?: string; allowStartHoliday?: boolean; stepDates?: Record<string, ISODate> } = {},
  existing: ProcessInstance[] = [],
): ProcessInstance[] {
  const result: ProcessInstance[] = [];
  let cursor = startDate;
  let floor = opts.floorLabel;
  for (let i = 0; i < Math.max(1, repeatCount); i++) {
    // 휴일 시작 허용·단계별 지정 날짜는 맨 첫 사이클에만 적용(이후 반복 사이클은 순차 배치).
    const cycle = generateFromTemplate(
      template,
      blockId,
      cursor,
      holidays,
      {
        ...opts,
        floorLabel: floor,
        allowStartHoliday: i === 0 ? opts.allowStartHoliday : false,
        stepDates: i === 0 ? opts.stepDates : undefined,
      },
      [...existing, ...result],
    );
    result.push(...cycle);
    const lastDate = cycle[cycle.length - 1]?.date ?? cursor;
    cursor = addDays(lastDate, 1);
    // 반복 생성이면 다음 사이클은 한 층 올린다("3F"→"4F"). 층수가 없으면 그대로 undefined.
    if (floor) floor = nextFloorLabel(floor);
  }
  return result;
}

export function isKnownType(typeCode: string): boolean {
  return typeCode in PROCESS_TYPE_MAP;
}

export function processLabel(p: ProcessInstance): string {
  return PROCESS_TYPE_MAP[p.typeCode]?.name ?? p.customLabel ?? p.typeCode;
}

export interface MoveResult {
  processes: ProcessInstance[];
  changeHistory: ChangeRecord[];
  blockedReason?: string;
  notice?: string; // 막힌 건 아니지만 사용자에게 알려주면 좋은 정보성 메시지 (예: 일요일이라 자동 순연됨)
  // 이 이동으로 "다른 공사(다른 구간공정)"가 함께 밀리게 되는 경우, 그 공정 이름 목록.
  // 비어있지 않으면 실제 반영 전에 사용자에게 "다른 공사도 밀립니다" 경고 후 확인받는다.
  pushedOtherSections?: string[];
}

interface PreviewResult {
  blockedReason?: string;
  collisionCount: number; // 이동을 반영했을 때 함께 겹치게 되는 '다른' 공정 수 (같은 셀 + 같은 날짜·같은 공종 다른 동)
}

/**
 * 실제로 이동을 적용하지 않고, 불변 규칙 위반 여부와 겹치게 될 공정 수를 미리 확인한다.
 * UI에서 드롭 직후 경고/확인 모달을 띄울지 판단하는 데 사용한다.
 */
export function previewMainMove(processes: ProcessInstance[], processId: string, newDate: ISODate): PreviewResult {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return { collisionCount: 0 };
  // 후행 주공정을 선행 공정보다 앞으로 당기는 것도 이제 허용한다(사이클 전체가 함께 앞으로
  // 당겨진다). 실제 처리·겹침 검사는 moveMainProcess가 한다.
  return { collisionCount: collidingProcesses(processes, { ...moved, date: newDate }, newDate).length };
}

/**
 * 같은 동·같은 날짜에 있는 주요공정 목록 (자기 자신 제외 가능).
 * refSlot을 넘기면 그 timeSlot과 겹치는 것만 돌려준다 — 오전/오후로 반나절씩 나눠서
 * 겹치지 않는 공정끼리는 "같은 셀"로 취급하지 않기 위함. refSlot을 안 넘기면(=종일과
 * 동일하게 취급) 기존처럼 그 셀의 모든 주요공정을 돌려준다.
 */
export function mainProcessesInCell(
  processes: ProcessInstance[],
  blockId: string,
  date: ISODate,
  excludeId?: string,
  refSlot?: ProcessInstance['timeSlot'],
): ProcessInstance[] {
  return processes.filter(
    (p) =>
      p.blockId === blockId &&
      p.date === date &&
      p.id !== excludeId &&
      PROCESS_TYPE_MAP[p.typeCode]?.category === 'main' &&
      slotsOverlap(p.timeSlot, refSlot),
  );
}

/**
 * moved 공정을 newDate로 옮겼을 때 겹치게 되는 다른 공정들.
 * (1) 같은 동·같은 날짜의 다른 주요공정 (드래그로 인한 셀 공존)
 * (2) 같은 날짜·같은 공종 그룹인 다른 동의 공정 (기존 충돌순번 대상 — 갱/철/AL)
 * 두 경우 모두 3개 이상이면 경고가 필요하므로 하나로 합쳐서 반환한다.
 */
export function collidingProcesses(processes: ProcessInstance[], moved: ProcessInstance, newDate: ISODate): ProcessInstance[] {
  const sameCell = mainProcessesInCell(processes, moved.blockId, newDate, moved.id, moved.timeSlot);
  const group = CONFLICT_GROUP[moved.typeCode];
  const crossBlock = group
    ? processes.filter(
        (p) => p.id !== moved.id && p.date === newDate && p.blockId !== moved.blockId && CONFLICT_GROUP[p.typeCode] === group,
      )
    : [];
  const byId = new Map<string, ProcessInstance>();
  for (const p of [...sameCell, ...crossBlock]) byId.set(p.id, p);
  return Array.from(byId.values());
}

/**
 * 사이클 하나(주요공정 하나 + 그 뒤에 이어지는 같은 사이클의 later 단계들 + 딸린
 * 보조공정)를 fromTypeCode 위치부터 newDate 기준으로 통째로 다시 배치한다.
 * moveMainProcess 자신의 이동과, 도미노 연쇄로 다른 사이클을 밀어낼 때 둘 다 이
 * 함수를 쓴다 — 후자는 change_history를 남기지 않는 "조용한 재계산"이라 이 함수
 * 자체는 change_history를 건드리지 않고 processes만 돌려준다.
 */
function rebuildCycleFrom(
  processes: ProcessInstance[],
  blockId: string,
  cycleId: string,
  fromTypeCode: string,
  fromProcessId: string,
  newDate: ISODate,
  holidays: Holiday[],
  gapDays: number,
  preserveDurationDays: number | undefined,
  // 맨 앞(사용자가 직접 놓은) 단계를 휴일이어도 그 날에 그대로 둘지. 수동 드롭일 때만 true.
  allowHolidayFirst: boolean = false,
  // 연속된 두 주공정이 오전/오후로 나뉘면 같은 날에 공존시킬지. 사용자 규칙상 "앞으로 당길
  // 때만 1일 2공종"이라, 앞당김 이동에서만 true로 넘긴다(뒤로 순연·자동 밀림은 1일 1공정).
  allowSameDayShare: boolean = false,
): { processes: ProcessInstance[]; firstDate: ISODate; sundaySkipped?: boolean } {
  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(fromTypeCode);
  const laterMainCodes = MAIN_SEQUENCE_CODES.slice(seqIndex + 1);
  const sequenceCodes = [fromTypeCode, ...laterMainCodes];

  // 뒤 단계들이 원래 갖고 있던 정보를 기억해둔다 — (1) "바로 앞 단계와의 간격": 예를 들어
  // 사용자가 타설을 일부러 며칠 더 늦춰뒀는데, 그 앞의 철근만 하루 옮겼다고 타설과의 간격이
  // 기본 간격(gapDays)으로 뭉개지면 안 된다(원래 간격이 기본값보다 크면 유지, 작거나 없으면
  // 기본값 사용). (2) 배정된 작업팀·실제완료 체크·소요일수 — 이 단계들은 makeProcess로
  // 새로 만들어지므로, 원래 갖고 있던 값을 옮겨 적어주지 않으면 이동/연장 한 번에
  // 조용히 사라진다.
  const originalByCode = new Map<
    string,
    { date: ISODate; durationDays: number; crew: ProcessInstance['crew']; actualDone?: boolean; timeSlot: ProcessInstance['timeSlot'] }
  >();
  for (const code of sequenceCodes) {
    const p = processes.find((x) => x.blockId === blockId && x.cycleId === cycleId && x.typeCode === code);
    if (p) {
      originalByCode.set(code, {
        date: p.date,
        durationDays: p.durationDays ?? 1,
        crew: p.crew,
        actualDone: p.actualDone,
        timeSlot: p.timeSlot,
      });
    }
  }
  // 보조공정(박리제/전기·설비/먹메김)도 같은 이유로 typeCode 기준(사이클 안에서 한 종류뿐이라
  // 유일하게 식별됨)으로 원래 값을 기억해둔다.
  const originalSubByCode = new Map<string, { crew: ProcessInstance['crew']; actualDone?: boolean; timeSlot: ProcessInstance['timeSlot'] }>();
  for (const p of processes) {
    if (p.blockId === blockId && p.cycleId === cycleId && p.linkedMainProcessId && PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') {
      originalSubByCode.set(p.typeCode, { crew: p.crew, actualDone: p.actualDone, timeSlot: p.timeSlot });
    }
  }

  const laterMainIds = new Set(
    processes.filter((p) => p.blockId === blockId && p.cycleId === cycleId && laterMainCodes.includes(p.typeCode)).map((p) => p.id),
  );
  const staleSubIds = new Set(
    processes
      .filter((p) => p.linkedMainProcessId && (p.linkedMainProcessId === fromProcessId || laterMainIds.has(p.linkedMainProcessId)))
      .map((p) => p.id),
  );
  const kept = processes.filter((p) => p.id !== fromProcessId && !laterMainIds.has(p.id) && !staleSubIds.has(p.id));
  const floorLabel = processes.find((p) => p.id === fromProcessId)?.floorLabel;

  const rebuilt: ProcessInstance[] = [];
  let cursor = newDate;
  let firstDate = newDate;
  // 사용자가 직접 드롭한 자리(맨 앞 단계)가 하필 일요일이라 다음 날로 밀린 경우만 따로
  // 표시해준다 — 다른 휴일 때문에 밀리는 건 이미 당연한 동작이라 굳이 알릴 필요 없다.
  let sundaySkipped = false;
  // 이 단계가 "앞 단계와 같은 날 반대 반나절로 공존"으로 놓였는지 — 그렇다면 그 위에 또
  // 다음 단계를 붙이지 않는다(한 날에 오전/오후 둘까지만 공존).
  let arrivedViaShare = false;
  sequenceCodes.forEach((code, i) => {
    const stepDef = PROCESS_TYPE_MAP[code];
    // 맨 앞 단계(i===0)는 사용자가 직접 놓은 자리 — allowHolidayFirst면 휴일이어도 그 날에
    // 그대로 둔다("직접 가져다 대는 건 휴일에 들어가도 됨"). 아니면 예전처럼 다음 작업일로 스킵.
    const firstAllowsHoliday = i === 0 && allowHolidayFirst;
    if (i === 0 && !allowHolidayFirst && dayOfWeek(cursor) === 0 && isBlockedForType(code, cursor, holidays)) {
      sundaySkipped = true;
    }
    let date = firstAllowsHoliday ? cursor : nextWorkableDate(code, cursor, holidays);
    // 자동으로 재배치되는 뒤 단계(i>0)는 다른 공사(구간공정) 날에 겹쳐 오지 않게 다음 빈
    // 날로 민다 — 사용자가 직접 옮긴 맨 앞 단계(i===0)만 자유롭게 둔다("자동이면 무조건 밀림").
    if (i > 0) {
      let guard = 0;
      while (kept.some((p) => p.blockId === blockId && !!p.customLabel && p.date === date) && guard++ < 400) {
        date = nextWorkableDate(code, addDays(date, 1), holidays);
      }
    }
    if (i === 0) firstDate = date;
    const main = makeProcess(blockId, code, date, cycleId, {
      floorLabel: stepDef.showFloorLabel ? floorLabel : undefined,
    });
    const origMain = originalByCode.get(code);
    main.crew = origMain?.crew;
    main.actualDone = origMain?.actualDone;
    main.timeSlot = origMain?.timeSlot;
    if (code === fromTypeCode) {
      main.id = fromProcessId; // 이동한 공정 자체는 id 유지
      main.durationDays = preserveDurationDays;
    } else {
      main.durationDays = origMain?.durationDays;
    }
    rebuilt.push(main);
    const subs = attachSubProcesses(blockId, code, date, main.id, cycleId);
    for (const sub of subs) {
      const origSub = originalSubByCode.get(sub.typeCode);
      if (origSub) {
        sub.crew = origSub.crew;
        sub.actualDone = origSub.actualDone;
        sub.timeSlot = origSub.timeSlot;
      }
    }
    rebuilt.push(...subs);
    const span = code === fromTypeCode ? preserveDurationDays ?? 1 : origMain?.durationDays ?? 1;

    // "원래 간격을 유지"하되, 그 간격이 순전히 휴일 때문에 밀린 것이면(예: 사이에 있던
    // 일요일 때문에 원래도 자동으로 하루 더 벌어져 있었을 뿐) 그대로 옮겨오면 안 된다 —
    // 새 날짜 기준으로는 그 휴일이 더 이상 사이에 안 낄 수도 있기 때문이다. 그래서
    // "기본 간격만 뒀을 때 원래 자동으로 나왔을 날짜"보다 실제로 더 뒤에 있었던 만큼만
    // (= 사용자가 일부러 늘린 몫만) 새 날짜에도 그대로 얹어준다.
    const nextCode = sequenceCodes[i + 1];
    let extraDays = 0;
    if (nextCode) {
      const cur = originalByCode.get(code);
      const next = originalByCode.get(nextCode);
      if (cur && next) {
        // 일수는 작업일 기준 — 이 공정의 작업일 기간 끝 다음 간격에 오는 자연스러운 날짜.
        const naturalNext = nextWorkableDate(nextCode, addDays(workableSpanEnd(code, cur.date, cur.durationDays, holidays), gapDays), holidays);
        const excess = diffDays(naturalNext, next.date);
        if (Number.isFinite(excess) && excess > 0) extraDays = excess;
      }
    }
    // 연속된 두 주공정의 반나절이 서로 반대(앞=오전, 뒤=오후 또는 그 반대)면 다음 단계를
    // 같은 날에 놓아 오전/오후로 공존시킨다 — 사용자가 반나절로 나눠 붙여둔 배치가 이동·순연
    // 때 풀려서 다시 하루씩 벌어지지 않게 한다. 단 이미 공존으로 들어온 단계 위엔 또 붙이지
    // 않는다(한 날 오전/오후 둘까지).
    const curSlot = origMain?.timeSlot;
    const nextSlot = nextCode ? originalByCode.get(nextCode)?.timeSlot : undefined;
    const opposite =
      (curSlot === 'morning' && nextSlot === 'afternoon') || (curSlot === 'afternoon' && nextSlot === 'morning');
    const shareNext = allowSameDayShare && opposite && !arrivedViaShare;
    if (shareNext) {
      cursor = date; // 다음 단계는 같은 날 반대 반나절로 공존
    } else {
      // 일수는 작업일 기준으로 점유(휴일은 빼고 뒤로 늘림) → 그 끝에서 간격만큼 뒤가 다음 커서.
      cursor = addDays(workableSpanEnd(code, date, span, holidays), gapDays + extraDays);
    }
    arrivedViaShare = shareNext;
  });

  return { processes: [...kept, ...rebuilt], firstDate, sundaySkipped };
}

/**
 * 도미노 연쇄: 방금 옮긴(또는 방금 밀어낸) 사이클이 같은 동의 "이후 층" 사이클과
 * 날짜가 겹치면, 그 사이클을 곧바로 뒤로 밀어낸다 — 필요하면 그 다음 층, 또 그
 * 다음 층까지 연쇄적으로. 각 사이클은 자기 자신의 휴일 규칙에 맞춰 재배치된다.
 * "이전 층"(원래 더 앞선 층)과 겹치는 경우는 밀어내지 않고 통째로 막는다 — 이미
 * 앞서 있는 공정의 일정을 뒤로 미룰 수는 없기 때문이다. 층 순서는 이번 이동이
 * 시작되기 전(originalOrder)의 사이클별 가장 이른 날짜로 판별한다.
 */
function cascadePushLaterCycles(
  processes: ProcessInstance[],
  blockId: string,
  startCycleId: string,
  originalOrder: Map<string, ISODate>,
  holidays: Holiday[],
  gapDays: number,
): { processes: ProcessInstance[]; blockedReason?: string } {
  let procs = processes;

  function mainProcsOf(cid: string) {
    return procs.filter((p) => p.blockId === blockId && p.cycleId === cid && MAIN_SEQUENCE_CODES.includes(p.typeCode));
  }
  function earliestOf(mp: ProcessInstance[]) {
    return mp.reduce((min, p) => (p.date < min ? p.date : min), mp[0].date);
  }
  function latestOf(mp: ProcessInstance[]) {
    return mp.reduce((max, p) => (p.date > max ? p.date : max), mp[0].date);
  }
  // earliestOf/latestOf와 같은 기준으로 실제 공정 객체를 돌려준다 — 오전/오후로
  // 나뉜 경우 경계일에 있는 공정끼리 timeSlot이 겹치는지 확인하려면 날짜뿐 아니라
  // 그 공정 자체(timeSlot)가 필요하다.
  function earliestProcOf(mp: ProcessInstance[]) {
    return mp.reduce((min, p) => (p.date < min.date ? p : min), mp[0]);
  }
  function latestProcOf(mp: ProcessInstance[]) {
    return mp.reduce((max, p) => (p.date > max.date ? p : max), mp[0]);
  }

  // 이 동의 모든 사이클을 "원래(이동 전) 층 순서" 그대로 정렬한다 — 이동은 그 사이클이
  // 서 있는 층 순서 자체를 바꾸는 게 아니라 그 자리의 날짜만 바꾸는 것이라, 순서 판단은
  // 항상 이 원래 순서 기준으로 해야 층이 뒤바뀌는 일이 없다(날짜 구간이 우연히 안
  // 겹친다고 건너뛰면 뒤 층이 앞 층보다 먼저 시공되는 것처럼 보이는 역전이 생겼었다).
  const allCycleIds = Array.from(
    new Set(procs.filter((p) => p.blockId === blockId && MAIN_SEQUENCE_CODES.includes(p.typeCode)).map((p) => p.cycleId)),
  );
  const orderedCycleIds = allCycleIds.sort((a, b) => {
    const oa = originalOrder.get(a) ?? '';
    const ob = originalOrder.get(b) ?? '';
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  const startIdx = orderedCycleIds.indexOf(startCycleId);
  if (startIdx === -1) return { processes: procs };

  const startProcs = mainProcsOf(startCycleId);
  const startEarliest = earliestOf(startProcs);

  // 이동한 사이클보다 원래 층 순서가 앞서는(더 이전 층) 사이클과 겹치면 과거를 되돌릴
  // 수 없으니 여기서 막는다. 단, 정확히 경계일이 같고(startEarliest === 그 층의
  // 마지막 날짜) 그날 두 공정이 오전/오후로 나뉘어 시간대가 안 겹치면 진짜 충돌이
  // 아니므로 막지 않는다.
  const startEarliestProc = earliestProcOf(startProcs);
  for (let i = 0; i < startIdx; i++) {
    const mp = mainProcsOf(orderedCycleIds[i]);
    if (mp.length === 0) continue;
    const earlierLatest = latestOf(mp);
    const sameDaySplit = startEarliest === earlierLatest && !slotsOverlap(startEarliestProc.timeSlot, latestProcOf(mp).timeSlot);
    if (startEarliest <= earlierLatest && !sameDaySplit) {
      // 보통은 갱폼이 이 사이클의 첫 단계지만, 갱폼만 개별 삭제된 사이클이면 실제로
      // 남아있는 것 중 가장 이른 공정 이름을 대신 보여준다.
      const anchorProc = mp.find((p) => p.typeCode === 'GANGFORM') ?? earliestProcOf(mp);
      return {
        processes,
        blockedReason: `이 이동은 이전 층 공정과 겹치게 되어 이동할 수 없습니다: ${earliestOf(mp)} ${processLabel(anchorProc)}`,
      };
    }
  }

  // 이동한 사이클부터 시작해서 원래 층 순서대로 쭉 훑으며, 각 사이클이 바로 앞 사이클의
  // 마지막 날짜 + gapDays보다 뒤에서 시작하는지 확인한다. 아니면 그만큼만 뒤로 민다 —
  // 이미 충분히 떨어져 있으면 건드리지 않는다. 다만 바로 앞 사이클의 마지막 공정과
  // 다음 사이클의 첫 공정이 같은 날 오전/오후로 나뉘어 시간대가 안 겹치면, 하루를
  // 더 벌리지 않고 그 자리에 그대로 공존시킨다(반나절 압축).
  let cursor = latestOf(startProcs);
  let cursorProc = latestProcOf(startProcs);
  for (let i = startIdx + 1; i < orderedCycleIds.length; i++) {
    const cid = orderedCycleIds[i];
    const mp = mainProcsOf(cid);
    if (mp.length === 0) continue;
    const earliest = earliestOf(mp);
    const earliestProc = earliestProcOf(mp);
    const requiredStart = addDays(cursor, gapDays);
    const sameDaySplit = earliest === cursor && !slotsOverlap(cursorProc.timeSlot, earliestProc.timeSlot);
    if (earliest < requiredStart && !sameDaySplit) {
      // 보통은 갱폼이 이 사이클의 첫 단계지만, 갱폼만 개별 삭제된 사이클이어도 밀어야
      // 할 때 조용히 건너뛰지 않도록, 실제로 남아있는 것 중 가장 이른 공정(earliestProc)을
      // 앵커로 삼아 재계산한다 — rebuildCycleFrom은 anchor 타입 뒤로 이어지는 코드만
      // 다시 만들기 때문에 갱폼이 없어도 그대로 잘 동작한다.
      const rebuild = rebuildCycleFrom(procs, blockId, cid, earliestProc.typeCode, earliestProc.id, requiredStart, holidays, gapDays, undefined);
      procs = reindexCellOrders(rebuild.processes, blockId, earliest);
      const rebuiltMp = mainProcsOf(cid);
      cursor = latestOf(rebuiltMp);
      cursorProc = latestProcOf(rebuiltMp);
    } else {
      cursor = latestOf(mp);
      cursorProc = latestProcOf(mp);
    }
  }

  return { processes: procs };
}

/**
 * 주요공정 이동: 이동한 공정만 change_history에 남기고, 후속 주요/보조공정은
 * 조용히 재계산한다 (문서 2.6: "후속공정 전체 흔적을 남기지 않고, 사용자가
 * 직접 이동한 기준 공정 중심으로 표시"). 이 이동으로 같은 동의 다른(이후) 층
 * 사이클과 겹치게 되면 막지 않고 그 사이클을 도미노처럼 뒤로 밀어낸다 — 실제
 * 현장에서 한 층 일정이 밀리면 뒤에 이어지는 층들도 자연스럽게 순서대로 밀리는
 * 것과 같은 원리다. 다만 "이전 층"과 겹치게 되는 경우는 밀 수 없으므로 그대로 막는다.
 */
export function moveMainProcess(
  processes: ProcessInstance[],
  changeHistory: ChangeRecord[],
  processId: string,
  newDate: ISODate,
  reason: string,
  holidays: Holiday[],
  gapDays: number = 1,
  // 사용자가 직접 드롭한 경우 true — 놓은 날이 휴일이어도 그 날에 그대로 둔다.
  // 자동(휴일 순연 등) 호출은 false(기본)라 예전처럼 휴일을 피한다.
  allowHoliday: boolean = false,
): MoveResult {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return { processes, changeHistory };
  const def = PROCESS_TYPE_MAP[moved.typeCode];
  if (!def || def.category !== 'main') return { processes, changeHistory };

  const preview = previewMainMove(processes, processId, newDate);
  if (preview.blockedReason) {
    return { processes, changeHistory, blockedReason: preview.blockedReason };
  }

  const blockId = moved.blockId;
  const cycleId = moved.cycleId;
  const oldDate = moved.date;

  // 후행 주요공정을 같은 사이클의 선행 공정과 "같은 날"에 드롭하는 경우(예: AL(종일)을
  // W_철근이 있는 날로) 그대로 두면 slotsOverlap 불변식이 깨진 채 같은 셀에 겹쳐 공존해
  // 버린다. 오전/오후로 정확히 나뉘어 시간대가 안 겹치는 경우만 같은 날 공존을 허용하고,
  // 그 외(한쪽이 종일이거나 같은 반나절인 등)에는 선행 공정 바로 다음 작업 가능일로 밀어
  // 배치한다 — 사용자 규칙: "오전/오후 짝일 때만 겹치고, 그 외엔 밀려야 한다".
  // 앵커 결정: 보통은 옮긴 공정 자신을 그 날짜에 놓고 뒤 단계만 재배치한다. 그런데 후행
  // 공정을 "선행 공정 자리(또는 그 앞)"로 당기는 경우엔, 그만큼 선행 공정(갱폼 등)도 함께
  // 앞으로 당겨져야 순서가 유지된다 → 첫 주공정(갱폼)을 앵커로 삼아 사이클 전체를 앞당긴다.
  const seqIdx = MAIN_SEQUENCE_CODES.indexOf(moved.typeCode);
  const firstCode = MAIN_SEQUENCE_CODES[0];
  let anchorCode = moved.typeCode;
  let anchorId = processId;
  let anchorDate = newDate;
  let anchorDuration = moved.durationDays;
  let shiftedWholeCycle = false;

  if (seqIdx > 0) {
    const prevCode = MAIN_SEQUENCE_CODES[seqIdx - 1];
    const prevInCycle = processes.find((p) => p.cycleId === cycleId && p.blockId === blockId && p.typeCode === prevCode);
    const firstProc = processes.find((p) => p.cycleId === cycleId && p.blockId === blockId && p.typeCode === firstCode);
    if (prevInCycle && firstProc && newDate <= prevInCycle.date) {
      const offset = diffDays(moved.date, newDate); // newDate - moved.date (음수면 앞당김)
      anchorCode = firstCode;
      anchorId = firstProc.id;
      // 앞당긴 갱폼이 휴일이면 과거 방향으로 스냅해야(그래야 앞당김이 상쇄되지 않는다).
      anchorDate = prevWorkableDate(firstCode, addDays(firstProc.date, offset), holidays);
      anchorDuration = firstProc.durationDays;
      shiftedWholeCycle = true;
    }
  }

  // 이번 이동이 시작되기 전, 같은 동 안 사이클들의 원래 층 순서(가장 이른 날짜 기준)를
  // 기록해둔다 — 도미노 연쇄가 "이후 층"만 밀 수 있게 판별하는 기준이 된다.
  const originalOrder = new Map<string, ISODate>();
  for (const p of processes) {
    if (p.blockId !== blockId || !MAIN_SEQUENCE_CODES.includes(p.typeCode)) continue;
    const cur = originalOrder.get(p.cycleId);
    if (!cur || p.date < cur) originalOrder.set(p.cycleId, p.date);
  }

  // 휴일 허용은 "옮긴 공정 자신이 맨 앞 앵커인 일반 이동"에만 적용한다. 전체 앞당김
  // (shiftedWholeCycle)은 앵커가 갱폼으로 자동 계산돼서 사용자가 콕 찍은 날이 아니므로 제외.
  // "1일 2공종(오전/오후 공존)"은 앞으로 당기는 이동일 때만 허용한다(뒤로 순연은 1일 1공정).
  const isForwardPull = newDate < oldDate;
  const rebuild = rebuildCycleFrom(
    processes, blockId, cycleId, anchorCode, anchorId, anchorDate, holidays, gapDays, anchorDuration, allowHoliday && !shiftedWholeCycle, isForwardPull,
  );

  const cascade = cascadePushLaterCycles(rebuild.processes, blockId, cycleId, originalOrder, holidays, gapDays);
  if (cascade.blockedReason) {
    return { processes, changeHistory, blockedReason: cascade.blockedReason }; // 통째로 되돌림
  }

  // 앞으로 당기다 이전 층(다른 사이클)과 겹치면 통째로 되돌리고 알린다(전체 앞당김일 때만 검사).
  if (shiftedWholeCycle) {
    const collisions = findMainCollisions(cascade.processes).filter((c) => c.blockId === blockId);
    if (collisions.length > 0) {
      const list = collisions.map((c) => `${c.date} ${c.labels.join('/')}`).join(', ');
      return { processes, changeHistory, blockedReason: `이만큼 앞으로 당기면 다른 층 공정과 겹쳐서 옮길 수 없어요: ${list}` };
    }
  }

  // 옮긴 공정의 최종 위치. 전체 앞당김이면 앵커가 갱폼이라 옮긴 공정은 새 id로 재생성됐으므로
  // typeCode로 다시 찾는다. (일반 이동은 id가 유지되어 그대로 찾힌다.)
  const movedFinal = cascade.processes.find((p) => p.cycleId === cycleId && p.blockId === blockId && p.typeCode === moved.typeCode);
  const finalMovedId = movedFinal?.id ?? processId;
  const finalMovedDate = movedFinal?.date ?? rebuild.firstDate;

  const record: ChangeRecord = { id: crypto.randomUUID(), processId: finalMovedId, previousDate: oldDate, newDate: finalMovedDate, reason };

  let nextProcesses = withArrivals(cascade.processes, [finalMovedId]);
  nextProcesses = reindexCellOrders(nextProcesses, blockId, oldDate); // 떠난 셀 정리
  nextProcesses = placeIntoCellAsFirst(nextProcesses, finalMovedId); // 새 셀에서 1번으로

  let notice: string | undefined;
  if (rebuild.sundaySkipped) notice = `일요일로는 옮길 수 없어 ${rebuild.firstDate}(으)로 자동 순연되었습니다.`;
  else if (shiftedWholeCycle) notice = `앞 순서 공정들도 함께 앞으로 당겨졌어요.`;

  return { processes: nextProcesses, changeHistory: [...changeHistory, record], notice };
}

// 작업이 하루 안에 안 끝나 다음날로 넘어갈 때 쓰는 최대 연장 일수. 그 이상은 실제로는
// 날짜를 옮기는 게 맞는 경우가 대부분이라 안전장치로 막아둔다.
export const MAX_EXTEND_DAYS = 5;

/**
 * 연장/축소했을 때 후속 공정들이 다른 사이클과 겹치게 되는지 미리 확인한다.
 * previewCascadeCollisions와 같은 방식이지만, 기준 날짜(moved.date)는 그대로 두고
 * 그 공정이 차지하는 일수(newDuration)만 바뀐 걸로 시뮬레이션한다.
 */
export function previewExtendCollisions(
  processes: ProcessInstance[],
  processId: string,
  newDuration: number,
  holidays: Holiday[],
  gapDays: number = 1,
): { date: ISODate; label: string }[] {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return [];
  const def = PROCESS_TYPE_MAP[moved.typeCode];
  if (!def || def.category !== 'main') return [];

  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(moved.typeCode);
  const laterMainCodes = MAIN_SEQUENCE_CODES.slice(seqIndex + 1);
  const blockId = moved.blockId;
  const cycleId = moved.cycleId;

  const ownMainIds = new Set(
    processes
      .filter((p) => p.blockId === blockId && p.cycleId === cycleId && (p.id === processId || laterMainCodes.includes(p.typeCode)))
      .map((p) => p.id),
  );

  const collisions: { date: ISODate; label: string }[] = [];
  let cursor = addDays(moved.date, newDuration - 1 + gapDays);
  laterMainCodes.forEach((code) => {
    const date = nextWorkableDate(code, cursor, holidays);
    // 연장으로 재배치될 이 단계는 원래 갖고 있던 timeSlot을 그대로 유지하므로, 그
    // timeSlot과 겹치지 않는(오전/오후로 나뉜) 다른 공정은 진짜 충돌이 아니다.
    const codeTimeSlot = processes.find((p) => p.blockId === blockId && p.cycleId === cycleId && p.typeCode === code)?.timeSlot;
    const others = processes.filter(
      (p) =>
        p.blockId === blockId &&
        p.date === date &&
        !ownMainIds.has(p.id) &&
        PROCESS_TYPE_MAP[p.typeCode]?.category === 'main' &&
        slotsOverlap(codeTimeSlot, p.timeSlot),
    );
    for (const o of others) collisions.push({ date, label: processLabel(o) });
    cursor = addDays(date, gapDays);
  });
  return collisions;
}

/**
 * 주요공정을 하루(또는 direction='shrink'면 반대로) 연장한다. 이동과 달리 이 공정
 * 자체의 날짜·딸린 보조공정은 그대로 두고, 그 다음부터 이어지는 후속 주요/보조공정만
 * "며칠짜리로 늘어났는지"에 맞춰 다시 배치한다.
 */
export function extendMainProcess(
  processes: ProcessInstance[],
  processId: string,
  holidays: Holiday[],
  direction: 'extend' | 'shrink' = 'extend',
  gapDays: number = 1,
): MoveResult {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return { processes, changeHistory: [] };
  const def = PROCESS_TYPE_MAP[moved.typeCode];
  if (!def || def.category !== 'main') return { processes, changeHistory: [] };

  const currentDuration = moved.durationDays ?? 1;
  const newDuration = direction === 'extend' ? currentDuration + 1 : currentDuration - 1;
  if (newDuration < 1 || newDuration > MAX_EXTEND_DAYS) {
    return {
      processes,
      changeHistory: [],
      blockedReason:
        newDuration > MAX_EXTEND_DAYS
          ? `${processLabel(moved)}은(는) 최대 ${MAX_EXTEND_DAYS}일까지만 연장할 수 있습니다.`
          : `${processLabel(moved)}은(는) 더 줄일 수 없습니다.`,
    };
  }

  const collisions = previewExtendCollisions(processes, processId, newDuration, holidays, gapDays);
  if (collisions.length > 0) {
    const list = collisions.map((c) => `${c.date} ${c.label}`).join(', ');
    return {
      processes,
      changeHistory: [],
      blockedReason: `연장하면 후속공정이 밀리면서 주요공정이 겹치게 되어 처리할 수 없습니다: ${list}`,
    };
  }

  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(moved.typeCode);
  const laterMainCodes = MAIN_SEQUENCE_CODES.slice(seqIndex + 1);
  const blockId = moved.blockId;
  const cycleId = moved.cycleId;

  // rebuildCycleFrom과 같은 이유로, 뒤 단계들의 원래 간격·배정된 작업팀·실제완료 체크를
  // 기억해뒀다가 다시 만드는 단계에 그대로 옮겨 적는다.
  const originalByCode = new Map<
    string,
    { date: ISODate; durationDays: number; crew: ProcessInstance['crew']; actualDone?: boolean; timeSlot: ProcessInstance['timeSlot'] }
  >();
  for (const code of laterMainCodes) {
    const p = processes.find((x) => x.blockId === blockId && x.cycleId === cycleId && x.typeCode === code);
    if (p) {
      originalByCode.set(code, {
        date: p.date,
        durationDays: p.durationDays ?? 1,
        crew: p.crew,
        actualDone: p.actualDone,
        timeSlot: p.timeSlot,
      });
    }
  }
  const originalSubByCode = new Map<string, { crew: ProcessInstance['crew']; actualDone?: boolean; timeSlot: ProcessInstance['timeSlot'] }>();
  for (const p of processes) {
    if (p.blockId === blockId && p.cycleId === cycleId && p.linkedMainProcessId && PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') {
      originalSubByCode.set(p.typeCode, { crew: p.crew, actualDone: p.actualDone, timeSlot: p.timeSlot });
    }
  }

  const laterMainIds = new Set(
    processes
      .filter((p) => p.blockId === blockId && p.cycleId === cycleId && laterMainCodes.includes(p.typeCode))
      .map((p) => p.id),
  );
  const staleSubIds = new Set(
    processes.filter((p) => p.linkedMainProcessId && laterMainIds.has(p.linkedMainProcessId)).map((p) => p.id),
  );
  const kept = processes.filter((p) => !laterMainIds.has(p.id) && !staleSubIds.has(p.id));

  // moved 바로 다음 단계와의 간격도 rebuildCycleFrom과 같은 규칙을 따른다: 원래 간격이
  // 기본 gapDays로 자동 계산했을 때 나올 날짜(휴일 스킵 포함)보다 더 뒤에 있었다면, 그
  // 초과분만 그대로 옮겨온다 — 단순히 휴일 때문에 벌어진 간격까지 그대로 베끼면 안 된다.
  let firstExtraDays = 0;
  const firstNextCode = laterMainCodes[0];
  const firstNextOriginal = firstNextCode ? originalByCode.get(firstNextCode) : undefined;
  if (firstNextCode && firstNextOriginal) {
    const naturalFirstNext = nextWorkableDate(firstNextCode, addDays(moved.date, currentDuration - 1 + gapDays), holidays);
    const excess = diffDays(naturalFirstNext, firstNextOriginal.date);
    if (Number.isFinite(excess) && excess > 0) firstExtraDays = excess;
  }

  const rebuilt: ProcessInstance[] = [];
  let cursor = addDays(moved.date, newDuration - 1 + gapDays + firstExtraDays);
  laterMainCodes.forEach((code, i) => {
    const stepDef = PROCESS_TYPE_MAP[code];
    const date = nextWorkableDate(code, cursor, holidays);
    const main = makeProcess(blockId, code, date, cycleId, {
      floorLabel: stepDef.showFloorLabel ? moved.floorLabel : undefined,
    });
    const origMain = originalByCode.get(code);
    main.crew = origMain?.crew;
    main.actualDone = origMain?.actualDone;
    main.timeSlot = origMain?.timeSlot;
    main.durationDays = origMain?.durationDays;
    rebuilt.push(main);
    const subs = attachSubProcesses(blockId, code, date, main.id, cycleId);
    for (const sub of subs) {
      const origSub = originalSubByCode.get(sub.typeCode);
      if (origSub) {
        sub.crew = origSub.crew;
        sub.actualDone = origSub.actualDone;
        sub.timeSlot = origSub.timeSlot;
      }
    }
    rebuilt.push(...subs);

    const span = origMain?.durationDays ?? 1;
    const nextCode = laterMainCodes[i + 1];
    let extraDays = 0;
    if (nextCode) {
      const next = originalByCode.get(nextCode);
      if (origMain && next) {
        const naturalNext = nextWorkableDate(nextCode, addDays(origMain.date, origMain.durationDays - 1 + gapDays), holidays);
        const excess = diffDays(naturalNext, next.date);
        if (Number.isFinite(excess) && excess > 0) extraDays = excess;
      }
    }
    cursor = addDays(date, span - 1 + gapDays + extraDays);
  });

  const nextProcesses = withArrivals(
    [...kept.map((p) => (p.id === processId ? { ...p, durationDays: newDuration } : p)), ...rebuilt],
    rebuilt.map((p) => p.id),
  );
  return { processes: nextProcesses, changeHistory: [] };
}

// 보조공정(+구간 공정 생성으로 만든 커스텀 공정)만 이동: 후속 재계산 없음. 목적지에
// 다른 보조공정이 있으면 공존(병합) 허용. 자동 호출(휴일 순연 등)은 일·공휴일 규칙을
// 그대로 적용해 그 날짜를 피하지만, 사용자가 직접 드롭(allowHoliday)한 경우엔 놓은 날이
// 휴일이어도 그 날에 그대로 둔다("직접 가져다 대는 건 휴일에 들어가도 됨").
export function moveSubProcess(
  processes: ProcessInstance[],
  processId: string,
  newDate: ISODate,
  holidays: Holiday[] = [],
  allowHoliday: boolean = false,
): { processes: ProcessInstance[]; date: ISODate; sundaySkipped: boolean } {
  const target = processes.find((p) => p.id === processId);
  const sundaySkipped =
    !allowHoliday && !!target && dayOfWeek(newDate) === 0 && isBlockedForType(target.typeCode, newDate, holidays);
  const finalDate = allowHoliday ? newDate : target ? nextWorkableDate(target.typeCode, newDate, holidays) : newDate;
  const updated = processes.map((p) => (p.id === processId ? { ...p, date: finalDate } : p));
  return { processes: withArrivals(updated, [processId]), date: finalDate, sundaySkipped };
}

/**
 * 구간공정(커스텀 단계) 이동: 옮긴 공정은 놓은 자리에 두되, 같은 구간(cycle)의 나머지 단계는
 * "구간 순서(seq)"를 그대로 지키며 재배치한다. 앞 단계는 옮긴 공정보다 먼저 끝나게, 뒤 단계는
 * 옮긴 공정 뒤에 오게 — 그래서 뒤 단계를 앞으로 끌어와도 앞 단계가 사라지거나 순서가 뒤집히지
 * 않고, 앞 단계들이 그만큼 앞으로 함께 당겨진다(기준층 갱폼 캐스케이드와 같은 원리).
 *
 * - 옮긴 공정 자체는 기준층 주공정만 피하고 놓은 자리에 그대로 앉는다(다른 구간공정은 비켜준다).
 * - seq는 단계 코드 `CUSTOM_<구간>_<번호>_<이름>`에 박혀 있어 같은 구간끼리 공통 접두어를 떼고
 *   앞 숫자로 읽는다 — 날짜가 뒤섞여 있어도 원래 순서를 복원한다.
 * - 공정 일수(durationDays)만큼 기간 전체를 점유로 계산한다(중간 휴일은 빼고 뒤로 늘림).
 * - 뒤에 있던 "다른 구간공정(다른 공사)"이 옮긴 구간과 겹치면 그 공사도 뒤로 함께 밀어낸다.
 * - 변경 흔적(회색 고스트/화살표)은 사용자가 직접 옮긴 공정 하나만 남긴다.
 */
export function moveCustomProcess(
  processes: ProcessInstance[],
  changeHistory: ChangeRecord[],
  processId: string,
  newDate: ISODate,
  reason: string,
  holidays: Holiday[] = [],
  // 사용자가 직접 드롭한 경우 true — 옮긴 공정을 놓은 날이 휴일이어도 그 날에 그대로 둔다.
  // 자동으로 재배치되는 나머지 단계는 이 값과 무관하게 늘 휴일을 피한다.
  allowHoliday: boolean = false,
): MoveResult {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return { processes, changeHistory };
  const blockId = moved.blockId;

  // 일수는 작업일 기준 — 중간에 낀 휴일은 빼고 그만큼 뒤로 늘려 점유 끝날을 잡는다.
  const endOf = (start: ISODate, p: ProcessInstance) => workableSpanEnd(p.typeCode, start, p.durationDays, holidays);
  const rangesOverlap = (s1: ISODate, e1: ISODate, s2: ISODate, e2: ISODate) => s1 <= e2 && s2 <= e1;

  // 구간공정은 순서를 강제하지 않고 자유롭게 겹칠 수 있다("2안") — 옮긴 공정만 놓은 자리로
  // 이동하고, 나머지 공정(같은 구간이든 다른 공사든)은 밀지 않는다. 사용자가 직접 드롭
  // (allowHoliday)이면 휴일이어도 그 날에 그대로, 자동 경로면 다음 작업일로만 스냅한다.
  const movedStart = allowHoliday ? newDate : nextWorkableDate(moved.typeCode, newDate, holidays);
  const updated = processes.map((p) => (p.id === processId ? { ...p, date: movedStart } : p));
  const nextProcesses = withArrivals(updated, [processId]);
  const records: ChangeRecord[] =
    movedStart !== moved.date
      ? [{ id: crypto.randomUUID(), processId, previousDate: moved.date, newDate: movedStart, reason }]
      : [];

  // 겹침 감지: 옮긴 공정이 같은 동의 다른 "주공정/구간공정"과 실제로 겹치나? 오전/오후로
  // 정확히 나뉜(slotsOverlap=false) 경우는 공존이라 경고 안 하고, 종일끼리 등 시간대가 겹치는
  // 경우만 "주의" 문구를 띄운다(막지는 않는다 — 겹침 자체는 허용). 보조공정은 아랫줄이라 제외.
  const movedEnd = endOf(movedStart, moved);
  const overlapping = processes.filter((p) => {
    if (p.id === processId || p.blockId !== blockId) return false;
    if (PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') return false;
    return slotsOverlap(moved.timeSlot, p.timeSlot) && rangesOverlap(movedStart, movedEnd, p.date, endOf(p.date, p));
  });
  const notice =
    overlapping.length > 0
      ? `⚠ 주의: 같은 날 ${[...new Set(overlapping.map(processLabel))].join(', ')}과(와) 겹칩니다. (오전/오후로 나누면 나란히 쓸 수 있어요)`
      : undefined;

  return { processes: nextProcesses, changeHistory: [...changeHistory, ...records], notice };
}

/**
 * 새로 휴일로 지정한 날짜에 이미 잡혀 있던 공정들을 하루 뒤로 밀어낸다. 주요공정은
 * moveMainProcess를 그대로 태워서 같은 동 안의 도미노 캐스케이드(뒤 층 밀림·이전 층
 * 충돌 시 보류)를 그대로 적용받고, 그 결과 딸려 있던 보조공정도 자동으로 재생성된다.
 * 주요공정이 옮겨가고 남은, 자기 메인공정은 다른 날짜에 있는 보조공정(예: 타설 다음날
 * 먹메김이 우연히 이 날짜에 걸린 경우)만 직접 하루 미룬다.
 */
export function pushProcessesOffHoliday(
  processes: ProcessInstance[],
  changeHistory: ChangeRecord[],
  holidayDate: ISODate,
  holidays: Holiday[],
  gapDays: number,
): MoveResult {
  let procs = processes;
  let hist = changeHistory;
  const skipIds = new Set<string>();
  for (let guard = 0; guard < 50; guard++) {
    const onDate = procs.filter((p) => p.date === holidayDate && !skipIds.has(p.id));
    if (onDate.length === 0) break;
    const main = onDate.find((p) => PROCESS_TYPE_MAP[p.typeCode]?.category === 'main');
    if (main) {
      const result = moveMainProcess(procs, hist, main.id, addDays(holidayDate, 1), '휴일 지정으로 순연', holidays, gapDays);
      if (result.blockedReason) {
        skipIds.add(main.id);
        continue;
      }
      procs = result.processes;
      hist = result.changeHistory;
      continue;
    }
    procs = moveSubProcess(procs, onDate[0].id, addDays(holidayDate, 1), holidays).processes;
  }
  return { processes: procs, changeHistory: hist };
}

/**
 * 공정 하나를 삭제한다. 유령/중복으로 잘못 생성된 공정을 지울 때 쓰는 용도라, 후속
 * 공정을 다시 당겨오거나 재계산하지 않고 그 자리만 비운다. 주요공정을 지우면 거기
 * 딸린 보조공정(박리제·전기설비·먹메김)도 같이 지운다 — 남겨두면 주인 없는 고아
 * 보조공정이 되기 때문이다.
 */
export function deleteProcess(processes: ProcessInstance[], processId: string): ProcessInstance[] {
  const target = processes.find((p) => p.id === processId);
  if (!target) return processes;
  const isMain = PROCESS_TYPE_MAP[target.typeCode]?.category === 'main';
  const linkedSubIds = isMain
    ? new Set(processes.filter((p) => p.linkedMainProcessId === processId).map((p) => p.id))
    : new Set<string>();
  const remaining = processes.filter((p) => p.id !== processId && !linkedSubIds.has(p.id));
  return reindexCellOrders(remaining, target.blockId, target.date);
}

/**
 * 공정 하나가 아니라, 그 공정과 같은 호출로 함께 만들어진 세트 전체(같은 cycleId)를
 * 지운다 — 기준층이면 갱폼~타설 5개 주요공정과 딸린 보조공정 전부, 구간 공정 생성으로
 * 만든 커스텀 순서면 그 순서에 속한 단계 전부.
 */
export function deleteProcessCycle(processes: ProcessInstance[], processId: string): ProcessInstance[] {
  const target = processes.find((p) => p.id === processId);
  if (!target) return processes;
  const removedDates = new Set(
    processes.filter((p) => p.blockId === target.blockId && p.cycleId === target.cycleId).map((p) => p.date),
  );
  let remaining = processes.filter((p) => !(p.blockId === target.blockId && p.cycleId === target.cycleId));
  // 세트가 여러 날짜에 걸쳐 있으면(예: 기초공사 13단계), 그 세트와 같은 셀에 있던
  // 다른(별개 사이클) 주요공정의 순번 배지에 구멍이 생기지 않도록 날짜마다 다시 정리한다.
  for (const date of removedDates) {
    remaining = reindexCellOrders(remaining, target.blockId, date);
  }
  return remaining;
}

/**
 * 드래그 이동/연장이 아닌 경로(공정 생성, 전체 일정 순연 등)로 주요공정이 겹치게
 * 되는지 확인한다. 같은 동·같은 날짜에 주요공정이 2개 이상이면 겹침으로 본다 —
 * previewCascadeCollisions와 같은 "같은 동에서는 주요공정끼리 절대 안 겹친다" 규칙을
 * 결과 상태 전체에 대해 한 번에 검사하는 버전이다.
 */
export function findMainCollisions(processes: ProcessInstance[]): { blockId: string; date: ISODate; labels: string[] }[] {
  const byKey = new Map<string, ProcessInstance[]>();
  for (const p of processes) {
    const category = PROCESS_TYPE_MAP[p.typeCode]?.category ?? 'main';
    if (category !== 'main') continue;
    const key = `${p.blockId}__${p.date}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(p);
  }
  const collisions: { blockId: string; date: ISODate; labels: string[] }[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    // 오전/오후로 서로 겹치지 않게 나뉜 정확히 2개짜리 조합은 겹침으로 보지 않는다.
    // 시간대가 실제로 겹치는 쌍이 하나라도 있으면 그때만 진짜 충돌로 취급한다.
    const hasRealOverlap = list.some((a, i) => list.some((b, j) => j > i && slotsOverlap(a.timeSlot, b.timeSlot)));
    if (!hasRealOverlap) continue;
    const sep = key.indexOf('__');
    collisions.push({ blockId: key.slice(0, sep), date: key.slice(sep + 2), labels: list.map(processLabel) });
  }
  return collisions.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 전체 일정 순연: fromDate 이후(포함) 모든 동의 공정을 deltaDays만큼 이동하고,
 * 타설·갱폼처럼 휴일 규칙이 있는 공정은 다시 규칙을 적용한다.
 *
 * 균일 이동만 하면 휴일 회피로 뒤 공정과 같은 날에 겹치는 일이 생긴다. 그래서 이동 후
 * 동마다 앞→뒤 순서로 훑어, 앞 공정과 실제로 겹치는(오전/오후로 안 나뉜) 주공정은 앞 공정
 * 끝난 다음 작업일로 밀어낸다(뒤 공정도 연쇄로 따라 밀림). 겹치지 않으면 그대로 둬 원래
 * 간격을 유지한다. 밀린 주공정에 붙은 보조공정도 같은 양만큼 따라 이동한다.
 */
export function shiftAllFrom(
  processes: ProcessInstance[],
  fromDate: ISODate,
  deltaDays: number,
  holidays: Holiday[],
): ProcessInstance[] {
  const shifted = processes.map((p) => {
    if (p.date < fromDate) return p;
    const target = addDays(p.date, deltaDays);
    const finalDate = PROCESS_TYPE_MAP[p.typeCode] ? nextWorkableDate(p.typeCode, target, holidays) : target;
    return { ...p, date: finalDate };
  });

  // ── 연쇄 밀기(cascade): 동마다 주공정을 날짜순으로 훑어 실제 겹침을 뒤로 해소한다. ──
  const isSub = (p: ProcessInstance) => PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub';
  const byBlock = new Map<string, ProcessInstance[]>();
  for (const p of shifted) {
    if (!byBlock.has(p.blockId)) byBlock.set(p.blockId, []);
    byBlock.get(p.blockId)!.push(p);
  }
  const extraShift = new Map<string, number>(); // 주공정 id → 추가로 더 민 일수
  for (const list of byBlock.values()) {
    const mains = list
      .filter((p) => !isSub(p) && p.date >= fromDate)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.cellOrder ?? 0) - (b.cellOrder ?? 0));
    let prevEnd: ISODate | null = null;
    let prevSlot: ProcessInstance['timeSlot'] = undefined;
    for (const m of mains) {
      let start = m.date;
      if (prevEnd && start <= prevEnd && slotsOverlap(m.timeSlot, prevSlot)) {
        // 앞 공정과 겹침 → 앞 공정 끝난 다음 작업일로 밀기(휴일 규칙 있는 공정은 회피 반영).
        start = nextWorkableDate(m.typeCode, addDays(prevEnd, 1), holidays);
      }
      const delta = diffDays(m.date, start);
      if (delta > 0) extraShift.set(m.id, delta);
      const end = workableSpanEnd(m.typeCode, start, m.durationDays, holidays);
      if (!prevEnd || end >= prevEnd) {
        prevEnd = end;
        prevSlot = m.timeSlot;
      }
    }
  }

  const cascaded =
    extraShift.size === 0
      ? shifted
      : shifted.map((p) => {
          if (extraShift.has(p.id)) return { ...p, date: addDays(p.date, extraShift.get(p.id)!) };
          // 밀린 주공정에 붙은 보조공정은 같은 양만큼 따라간다.
          if (p.linkedMainProcessId && extraShift.has(p.linkedMainProcessId)) {
            return { ...p, date: addDays(p.date, extraShift.get(p.linkedMainProcessId)!) };
          }
          return p;
        });

  const origDate = new Map(processes.map((o) => [o.id, o.date]));
  const movedIds = cascaded.filter((p) => p.date !== origDate.get(p.id)).map((p) => p.id);
  return reindexAllCellGroups(withArrivals(cascaded, movedIds));
}

const arrivalStore = new Map<string, number>();

function withArrivals(processes: ProcessInstance[], movedIds: string[]): ProcessInstance[] {
  for (const id of movedIds) arrivalStore.set(id, nextArrival());
  return processes;
}

function arrivalOf(id: string): number {
  return arrivalStore.get(id) ?? 0;
}

/**
 * 같은 날짜·같은 공종 그룹(갱/철/AL)에 1,2,3 순번을 부여한다.
 * 가장 최근에 그 날짜로 이동/생성된 공정이 1번이 되고 기존 순번은 뒤로 밀린다.
 */
export function recomputeConflicts(processes: ProcessInstance[]): ProcessInstance[] {
  const groups = new Map<string, ProcessInstance[]>();
  for (const p of processes) {
    const group = CONFLICT_GROUP[p.typeCode];
    if (!group) continue;
    const key = `${p.date}__${group}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const seqById = new Map<string, number>();
  const groupById = new Map<string, string>();
  for (const [key, list] of groups) {
    const group = key.split('__')[1];
    const sorted = [...list].sort((a, b) => arrivalOf(b.id) - arrivalOf(a.id));
    sorted.forEach((p, idx) => {
      seqById.set(p.id, idx + 1);
      groupById.set(p.id, group);
    });
  }

  return processes.map((p) =>
    seqById.has(p.id)
      ? { ...p, conflictSeq: seqById.get(p.id), conflictGroup: groupById.get(p.id) }
      : { ...p, conflictSeq: undefined, conflictGroup: undefined },
  );
}

/** 특정 동·날짜 셀의 주요공정 cellOrder를 현재 상대 순서를 유지한 채 1..n으로 다시 채운다. */
export function reindexCellOrders(processes: ProcessInstance[], blockId: string, date: ISODate): ProcessInstance[] {
  const group = mainProcessesInCell(processes, blockId, date);
  if (group.length <= 1) {
    if (group.length === 0) return processes;
    return processes.map((p) => (p.id === group[0].id ? { ...p, cellOrder: undefined } : p));
  }
  const sorted = [...group].sort((a, b) => (a.cellOrder ?? Number.MAX_SAFE_INTEGER) - (b.cellOrder ?? Number.MAX_SAFE_INTEGER));
  const orderById = new Map(sorted.map((p, idx) => [p.id, idx + 1]));
  return processes.map((p) => (orderById.has(p.id) ? { ...p, cellOrder: orderById.get(p.id) } : p));
}

/** 이동해온 공정을 그 셀의 1번으로 두고 기존 공존 공정들은 뒤로 민다. */
export function placeIntoCellAsFirst(processes: ProcessInstance[], processId: string): ProcessInstance[] {
  const proc = processes.find((p) => p.id === processId);
  if (!proc) return processes;
  const others = mainProcessesInCell(processes, proc.blockId, proc.date, processId, proc.timeSlot);
  if (others.length === 0) {
    return processes.map((p) => (p.id === processId ? { ...p, cellOrder: undefined } : p));
  }
  const sortedOthers = [...others].sort(
    (a, b) => (a.cellOrder ?? Number.MAX_SAFE_INTEGER) - (b.cellOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const bumpedOrderById = new Map(sortedOthers.map((p, idx) => [p.id, idx + 2]));
  return processes.map((p) => {
    if (p.id === processId) return { ...p, cellOrder: 1 };
    if (bumpedOrderById.has(p.id)) return { ...p, cellOrder: bumpedOrderById.get(p.id) };
    return p;
  });
}

/** shiftAllFrom처럼 대량 이동 후 모든 셀의 cellOrder를 상대 순서 유지한 채 정리한다. */
export function reindexAllCellGroups(processes: ProcessInstance[]): ProcessInstance[] {
  const keys = new Set(
    processes.filter((p) => PROCESS_TYPE_MAP[p.typeCode]?.category === 'main').map((p) => `${p.blockId}__${p.date}`),
  );
  let result = processes;
  for (const key of keys) {
    const sep = key.indexOf('__');
    const blockId = key.slice(0, sep);
    const date = key.slice(sep + 2);
    result = reindexCellOrders(result, blockId, date);
  }
  return result;
}

/** 같은 셀 안에서 두 주요공정의 작업 순서를 맞바꾼다. */
export function swapCellOrder(processes: ProcessInstance[], processId: string, direction: 'up' | 'down'): ProcessInstance[] {
  const moved = processes.find((p) => p.id === processId);
  if (!moved || moved.cellOrder == null) return processes;
  const neighborOrder = direction === 'up' ? moved.cellOrder - 1 : moved.cellOrder + 1;
  const neighbor = processes.find(
    (p) => p.blockId === moved.blockId && p.date === moved.date && p.cellOrder === neighborOrder,
  );
  if (!neighbor) return processes;
  return processes.map((p) => {
    if (p.id === moved.id) return { ...p, cellOrder: neighborOrder };
    if (p.id === neighbor.id) return { ...p, cellOrder: moved.cellOrder };
    return p;
  });
}
