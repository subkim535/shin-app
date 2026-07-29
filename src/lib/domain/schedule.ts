import { addDays, dayOfWeek, ISODate } from './dateUtils';
import { CONFLICT_GROUP, MAIN_SEQUENCE_CODES, PROCESS_TYPE_MAP } from './processTypes';
import { ChangeRecord, Holiday, ProcessInstance, ProcessTemplate } from './types';

let arrivalCounter = 0;
function nextArrival() {
  arrivalCounter += 1;
  return arrivalCounter;
}

function isPublicHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return holidays.some((h) => h.date === date && h.kind !== 'sunday');
}

// 문서 2.5 휴일 규칙: 타설(토·일·공휴일 금지), 갱폼(일·공휴일 금지).
// 그 외 공종은 기본적으로 일요일도 휴무로 취급한다. 단, 사용자가 직접 일요일 칸으로
// 드래그해서 옮긴 경우(allowSunday)는 그 공정 하나만 예외로 허용한다 — 자동 생성/후속
// 연쇄/전체순연에는 이 예외를 절대 넘기지 않는다(항상 기본값으로 호출).
export function isBlockedForType(
  typeCode: string,
  date: ISODate,
  holidays: Holiday[],
  opts: { allowSunday?: boolean } = {},
): boolean {
  const dow = dayOfWeek(date);
  const sunday = dow === 0;
  const saturday = dow === 6;
  const publicHoliday = isPublicHoliday(date, holidays);
  if (typeCode === 'POUR') return saturday || sunday || publicHoliday;
  if (typeCode === 'GANGFORM') return sunday || publicHoliday;
  if (sunday && !opts.allowSunday) return true;
  return publicHoliday;
}

function nextWorkableDate(typeCode: string, date: ISODate, holidays: Holiday[]): ISODate {
  let d = date;
  while (isBlockedForType(typeCode, d, holidays)) {
    d = addDays(d, 1);
  }
  return d;
}

function makeProcess(
  blockId: string,
  typeCode: string,
  date: ISODate,
  cycleId: string,
  opts: { floorLabel?: string; linkedMainProcessId?: string; customLabel?: string } = {},
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
  if (mainCode === 'S_REBAR') {
    subs.push(makeProcess(blockId, 'ELECTRIC_FACILITY', mainDate, cycleId, { linkedMainProcessId: mainId }));
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
): ProcessInstance[] {
  const cycleId = crypto.randomUUID();
  const result: ProcessInstance[] = [];
  let cursor = startDate;
  for (const code of MAIN_SEQUENCE_CODES) {
    const def = PROCESS_TYPE_MAP[code];
    const date = nextWorkableDate(code, cursor, holidays);
    const main = makeProcess(blockId, code, date, cycleId, { floorLabel: def.showFloorLabel ? floor : undefined });
    result.push(main);
    result.push(...attachSubProcesses(blockId, code, date, main.id, cycleId));
    cursor = addDays(date, 1);
  }
  return result;
}

// "16F" -> "17F"처럼 앞의 숫자만 1 증가시킨다. 숫자가 없는 라벨(자유 텍스트)은 그대로 둔다.
function nextFloorLabel(floor: string): string {
  const match = floor.match(/^(\d+)(.*)$/);
  if (!match) return floor;
  return `${Number(match[1]) + 1}${match[2]}`;
}

/**
 * 기준층은 한 번 만들고 끝나는 게 아니라 층이 계속 반복되므로, 시작 층부터 한 층씩
 * 자동으로 올려가며 해당월 + 익월 말일까지 반복 생성한다. 안전장치로 최대 60개 층까지만
 * 만든다(무한루프 방지 — 날짜가 안 늘어나는 이상 상태가 생겨도 멈추게).
 */
export function generateRepeatingFloors(
  blockId: string,
  startFloor: string,
  startDate: ISODate,
  holidays: Holiday[],
  untilDate: ISODate,
): ProcessInstance[] {
  const result: ProcessInstance[] = [];
  let floor = startFloor;
  let cursor = startDate;
  for (let i = 0; i < 60; i++) {
    const cycle = generateBaseFloorSequence(blockId, floor, cursor, holidays);
    if (cycle.length === 0) break;
    result.push(...cycle);
    const lastDate = cycle.reduce((max, p) => (p.date > max ? p.date : max), cycle[0].date);
    if (lastDate >= untilDate) break;
    cursor = addDays(lastDate, 1);
    floor = nextFloorLabel(floor);
  }
  return result;
}

/**
 * 기초/지하층 등 지상층과 순서가 다른 구간을 위한 단순 순차 템플릿 생성.
 * 지상층 엔진과 달리 보조공정 자동배치·전용 휴일규칙·후속 연쇄이동·순서 불변 검증은
 * 아직 붙이지 않았다 (원 기획서에도 "추후 별도 설계"로 남겨진 영역). 자유공정처럼
 * 각 스텝을 자유롭게 이동할 수 있는 수준으로만 우선 지원한다.
 */
export function generateFromTemplate(
  template: ProcessTemplate,
  blockId: string,
  startDate: ISODate,
  holidays: Holiday[] = [],
  opts: { skipOptional?: boolean } = {},
): ProcessInstance[] {
  const cycleId = crypto.randomUUID();
  const result: ProcessInstance[] = [];
  let cursor = startDate;
  for (const step of template.steps) {
    if (step.optional && opts.skipOptional) continue;
    cursor = nextWorkableDate(step.code, cursor, holidays);
    const main = makeProcess(blockId, step.code, cursor, cycleId, { customLabel: step.name });
    result.push(main);
    cursor = addDays(cursor, Math.max(1, step.durationDays || 1));
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
  opts: { skipOptional?: boolean } = {},
): ProcessInstance[] {
  const result: ProcessInstance[] = [];
  let cursor = startDate;
  for (let i = 0; i < Math.max(1, repeatCount); i++) {
    const cycle = generateFromTemplate(template, blockId, cursor, holidays, opts);
    result.push(...cycle);
    const lastDate = cycle[cycle.length - 1]?.date ?? cursor;
    cursor = addDays(lastDate, 1);
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
  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(moved.typeCode);

  if (seqIndex > 0) {
    const prevCode = MAIN_SEQUENCE_CODES[seqIndex - 1];
    const prevInCycle = processes.find(
      (p) => p.cycleId === moved.cycleId && p.blockId === moved.blockId && p.typeCode === prevCode,
    );
    if (prevInCycle && newDate < prevInCycle.date) {
      return {
        blockedReason: `${PROCESS_TYPE_MAP[moved.typeCode].name}은(는) 선행 공정인 ${PROCESS_TYPE_MAP[prevCode].name}(${prevInCycle.date})보다 앞선 날짜로 이동할 수 없습니다.`,
        collisionCount: 0,
      };
    }
  }

  return { collisionCount: collidingProcesses(processes, { ...moved, date: newDate }, newDate).length };
}

/** 같은 동·같은 날짜에 있는 주요공정 목록 (자기 자신 제외 가능). */
export function mainProcessesInCell(
  processes: ProcessInstance[],
  blockId: string,
  date: ISODate,
  excludeId?: string,
): ProcessInstance[] {
  return processes.filter(
    (p) => p.blockId === blockId && p.date === date && p.id !== excludeId && PROCESS_TYPE_MAP[p.typeCode]?.category === 'main',
  );
}

/**
 * moved 공정을 newDate로 옮겼을 때 겹치게 되는 다른 공정들.
 * (1) 같은 동·같은 날짜의 다른 주요공정 (드래그로 인한 셀 공존)
 * (2) 같은 날짜·같은 공종 그룹인 다른 동의 공정 (기존 충돌순번 대상 — 갱/철/AL)
 * 두 경우 모두 3개 이상이면 경고가 필요하므로 하나로 합쳐서 반환한다.
 */
export function collidingProcesses(processes: ProcessInstance[], moved: ProcessInstance, newDate: ISODate): ProcessInstance[] {
  const sameCell = mainProcessesInCell(processes, moved.blockId, newDate, moved.id);
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
 * 주요공정 이동: 이동한 공정만 change_history에 남기고, 후속 주요/보조공정은
 * 조용히 재계산한다 (문서 2.6: "후속공정 전체 흔적을 남기지 않고, 사용자가
 * 직접 이동한 기준 공정 중심으로 표시"). 목적지 셀에 다른 주요공정이 이미 있어도
 * 막지 않고 공존시키며, 새로 이동해온 공정이 1번이 되고 기존 것들은 뒤로 밀린다.
 */
export function moveMainProcess(
  processes: ProcessInstance[],
  changeHistory: ChangeRecord[],
  processId: string,
  newDate: ISODate,
  reason: string,
  holidays: Holiday[],
): MoveResult {
  const moved = processes.find((p) => p.id === processId);
  if (!moved) return { processes, changeHistory };
  const def = PROCESS_TYPE_MAP[moved.typeCode];
  if (!def || def.category !== 'main') return { processes, changeHistory };

  const preview = previewMainMove(processes, processId, newDate);
  if (preview.blockedReason) {
    return { processes, changeHistory, blockedReason: preview.blockedReason };
  }

  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(moved.typeCode);
  const laterMainCodes = MAIN_SEQUENCE_CODES.slice(seqIndex + 1);
  const blockId = moved.blockId;
  const cycleId = moved.cycleId;
  const oldDate = moved.date;

  const laterMainIds = new Set(
    processes
      .filter((p) => p.blockId === blockId && p.cycleId === cycleId && laterMainCodes.includes(p.typeCode))
      .map((p) => p.id),
  );
  const staleSubIds = new Set(
    processes
      .filter((p) => p.linkedMainProcessId && (p.linkedMainProcessId === processId || laterMainIds.has(p.linkedMainProcessId)))
      .map((p) => p.id),
  );

  const kept = processes.filter((p) => p.id !== processId && !laterMainIds.has(p.id) && !staleSubIds.has(p.id));

  const rebuilt: ProcessInstance[] = [];
  let cursor = newDate;
  [moved.typeCode, ...laterMainCodes].forEach((code, i) => {
    const stepDef = PROCESS_TYPE_MAP[code];
    // 사용자가 직접 드래그한 공정(맨 앞 하나)만 일요일 예외를 허용한다. 이어지는 후속
    // 공정들은 사용자가 직접 지정한 게 아니므로 계속 기본 휴일 규칙(일요일 포함)을 따른다.
    const date =
      i === 0 && !isBlockedForType(code, cursor, holidays, { allowSunday: true })
        ? cursor
        : nextWorkableDate(code, cursor, holidays);
    const main = makeProcess(blockId, code, date, cycleId, {
      floorLabel: stepDef.showFloorLabel ? moved.floorLabel : undefined,
    });
    main.id = code === moved.typeCode ? processId : main.id; // 이동한 공정 자체는 id 유지
    rebuilt.push(main);
    rebuilt.push(...attachSubProcesses(blockId, code, date, main.id, cycleId));
    cursor = addDays(date, 1);
  });

  const record: ChangeRecord = {
    id: crypto.randomUUID(),
    processId,
    previousDate: oldDate,
    newDate: rebuilt[0].date,
    reason,
  };

  let nextProcesses = withArrivals([...kept, ...rebuilt], [rebuilt[0].id]);
  nextProcesses = reindexCellOrders(nextProcesses, blockId, oldDate); // 떠난 셀 정리
  nextProcesses = placeIntoCellAsFirst(nextProcesses, processId); // 새 셀에서 1번으로
  return { processes: nextProcesses, changeHistory: [...changeHistory, record] };
}

// 보조공정만 이동: 후속 재계산 없음. 목적지에 다른 보조공정이 있으면 공존(병합) 허용.
export function moveSubProcess(processes: ProcessInstance[], processId: string, newDate: ISODate): ProcessInstance[] {
  const updated = processes.map((p) => (p.id === processId ? { ...p, date: newDate } : p));
  return withArrivals(updated, [processId]);
}

/**
 * 전체 일정 순연: fromDate 이후(포함) 모든 동의 공정을 deltaDays만큼 이동하고,
 * 타설·갱폼처럼 휴일 규칙이 있는 공정은 다시 규칙을 적용한다.
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
  const movedIds = shifted.filter((p) => p.date !== processes.find((o) => o.id === p.id)?.date).map((p) => p.id);
  return reindexAllCellGroups(withArrivals(shifted, movedIds));
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
  const others = mainProcessesInCell(processes, proc.blockId, proc.date, processId);
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
