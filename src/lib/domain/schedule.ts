import { addDays, dayOfWeek, ISODate } from './dateUtils';
import { CONFLICT_GROUP, MAIN_SEQUENCE_CODES, PROCESS_TYPE_MAP } from './processTypes';
import { ChangeRecord, Holiday, ProcessInstance, ProcessTemplate } from './types';

let arrivalCounter = 0;
function nextArrival() {
  arrivalCounter += 1;
  return arrivalCounter;
}

// 근로자의 날(5/1)은 매년 반복되는 법정 휴일이라, 휴일 목록에 매년 등록하지 않아도
// 항상 전 공종 작업 금지로 취급한다.
function isWorkersDay(date: ISODate): boolean {
  return date.slice(5) === '05-01';
}

function isPublicHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return isWorkersDay(date) || holidays.some((h) => h.date === date && h.kind !== 'sunday');
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
  gapDays: number = 1,
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
    cursor = addDays(date, gapDays);
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
  gapDays: number = 1,
): ProcessInstance[] {
  const result: ProcessInstance[] = [];
  let floor = startFloor;
  let cursor = startDate;
  for (let i = 0; i < 60; i++) {
    const cycle = generateBaseFloorSequence(blockId, floor, cursor, holidays, gapDays);
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
): { processes: ProcessInstance[]; firstDate: ISODate } {
  const seqIndex = MAIN_SEQUENCE_CODES.indexOf(fromTypeCode);
  const laterMainCodes = MAIN_SEQUENCE_CODES.slice(seqIndex + 1);

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
  [fromTypeCode, ...laterMainCodes].forEach((code, i) => {
    const stepDef = PROCESS_TYPE_MAP[code];
    // 사용자가 직접 드래그한 공정(맨 앞 하나)만 일요일 예외를 허용한다. 이어지는 후속
    // 공정들(및 도미노로 밀린 다른 사이클)은 계속 기본 휴일 규칙(일요일 포함)을 따른다.
    const date =
      i === 0 && !isBlockedForType(code, cursor, holidays, { allowSunday: true })
        ? cursor
        : nextWorkableDate(code, cursor, holidays);
    if (i === 0) firstDate = date;
    const main = makeProcess(blockId, code, date, cycleId, {
      floorLabel: stepDef.showFloorLabel ? floorLabel : undefined,
    });
    if (code === fromTypeCode) {
      main.id = fromProcessId; // 이동한 공정 자체는 id 유지
      main.durationDays = preserveDurationDays;
    }
    rebuilt.push(main);
    rebuilt.push(...attachSubProcesses(blockId, code, date, main.id, cycleId));
    const span = code === fromTypeCode ? preserveDurationDays ?? 1 : 1;
    cursor = addDays(date, span - 1 + gapDays);
  });

  return { processes: [...kept, ...rebuilt], firstDate };
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
  let referenceCycleId = startCycleId;
  const startOriginal = originalOrder.get(startCycleId);

  function mainProcsOf(cid: string) {
    return procs.filter((p) => p.blockId === blockId && p.cycleId === cid && MAIN_SEQUENCE_CODES.includes(p.typeCode));
  }

  // 무한루프 방지 안전장치 — 한 동에 60개 층 이상은 없다고 본다(생성 쪽과 동일한 한도).
  for (let guard = 0; guard < 60; guard++) {
    const refProcs = mainProcsOf(referenceCycleId);
    if (refProcs.length === 0) break;
    const refEarliest = refProcs.reduce((min, p) => (p.date < min ? p.date : min), refProcs[0].date);
    const refLatest = refProcs.reduce((max, p) => (p.date > max ? p.date : max), refProcs[0].date);

    const otherCycleIds = Array.from(
      new Set(
        procs
          .filter((p) => p.blockId === blockId && MAIN_SEQUENCE_CODES.includes(p.typeCode) && p.cycleId !== referenceCycleId)
          .map((p) => p.cycleId),
      ),
    );

    let target: { cid: string; earliest: ISODate; gangformId: string; label: string } | null = null;
    for (const cid of otherCycleIds) {
      const mp = mainProcsOf(cid);
      const earliest = mp.reduce((min, p) => (p.date < min ? p.date : min), mp[0].date);
      const latest = mp.reduce((max, p) => (p.date > max ? p.date : max), mp[0].date);
      const overlaps = earliest <= refLatest && latest >= refEarliest;
      if (!overlaps) continue;

      const otherOriginal = originalOrder.get(cid);
      const isLaterFloor = startOriginal === undefined || otherOriginal === undefined || otherOriginal > startOriginal;
      const gangform = mp.find((p) => p.typeCode === 'GANGFORM');
      if (!isLaterFloor) {
        return {
          processes,
          blockedReason: `이 이동은 이전 층 공정과 겹치게 되어 이동할 수 없습니다: ${earliest} ${gangform ? processLabel(gangform) : ''}`,
        };
      }
      if (gangform && (!target || earliest < target.earliest)) {
        target = { cid, earliest, gangformId: gangform.id, label: processLabel(gangform) };
      }
    }

    if (!target) break; // 더 이상 겹치는 이후 층이 없으면 연쇄 종료

    const requiredStart = addDays(refLatest, gapDays);
    const rebuild = rebuildCycleFrom(procs, blockId, target.cid, 'GANGFORM', target.gangformId, requiredStart, holidays, gapDays, undefined);
    procs = reindexCellOrders(rebuild.processes, blockId, target.earliest);
    referenceCycleId = target.cid;
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

  // 이번 이동이 시작되기 전, 같은 동 안 사이클들의 원래 층 순서(가장 이른 날짜 기준)를
  // 기록해둔다 — 도미노 연쇄가 "이후 층"만 밀 수 있게 판별하는 기준이 된다.
  const originalOrder = new Map<string, ISODate>();
  for (const p of processes) {
    if (p.blockId !== blockId || !MAIN_SEQUENCE_CODES.includes(p.typeCode)) continue;
    const cur = originalOrder.get(p.cycleId);
    if (!cur || p.date < cur) originalOrder.set(p.cycleId, p.date);
  }

  const rebuild = rebuildCycleFrom(processes, blockId, cycleId, moved.typeCode, processId, newDate, holidays, gapDays, moved.durationDays);

  const cascade = cascadePushLaterCycles(rebuild.processes, blockId, cycleId, originalOrder, holidays, gapDays);
  if (cascade.blockedReason) {
    return { processes, changeHistory, blockedReason: cascade.blockedReason }; // 통째로 되돌림
  }

  const record: ChangeRecord = {
    id: crypto.randomUUID(),
    processId,
    previousDate: oldDate,
    newDate: rebuild.firstDate,
    reason,
  };

  let nextProcesses = withArrivals(cascade.processes, [processId]);
  nextProcesses = reindexCellOrders(nextProcesses, blockId, oldDate); // 떠난 셀 정리
  nextProcesses = placeIntoCellAsFirst(nextProcesses, processId); // 새 셀에서 1번으로
  return { processes: nextProcesses, changeHistory: [...changeHistory, record] };
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
    const others = processes.filter(
      (p) => p.blockId === blockId && p.date === date && !ownMainIds.has(p.id) && PROCESS_TYPE_MAP[p.typeCode]?.category === 'main',
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

  const laterMainIds = new Set(
    processes
      .filter((p) => p.blockId === blockId && p.cycleId === cycleId && laterMainCodes.includes(p.typeCode))
      .map((p) => p.id),
  );
  const staleSubIds = new Set(
    processes.filter((p) => p.linkedMainProcessId && laterMainIds.has(p.linkedMainProcessId)).map((p) => p.id),
  );
  const kept = processes.filter((p) => !laterMainIds.has(p.id) && !staleSubIds.has(p.id));

  const rebuilt: ProcessInstance[] = [];
  let cursor = addDays(moved.date, newDuration - 1 + gapDays);
  laterMainCodes.forEach((code) => {
    const stepDef = PROCESS_TYPE_MAP[code];
    const date = nextWorkableDate(code, cursor, holidays);
    const main = makeProcess(blockId, code, date, cycleId, {
      floorLabel: stepDef.showFloorLabel ? moved.floorLabel : undefined,
    });
    rebuilt.push(main);
    rebuilt.push(...attachSubProcesses(blockId, code, date, main.id, cycleId));
    cursor = addDays(date, gapDays);
  });

  const nextProcesses = withArrivals(
    [...kept.map((p) => (p.id === processId ? { ...p, durationDays: newDuration } : p)), ...rebuilt],
    rebuilt.map((p) => p.id),
  );
  return { processes: nextProcesses, changeHistory: [] };
}

// 보조공정만 이동: 후속 재계산 없음. 목적지에 다른 보조공정이 있으면 공존(병합) 허용.
export function moveSubProcess(processes: ProcessInstance[], processId: string, newDate: ISODate): ProcessInstance[] {
  const updated = processes.map((p) => (p.id === processId ? { ...p, date: newDate } : p));
  return withArrivals(updated, [processId]);
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
    const sep = key.indexOf('__');
    collisions.push({ blockId: key.slice(0, sep), date: key.slice(sep + 2), labels: list.map(processLabel) });
  }
  return collisions.sort((a, b) => a.date.localeCompare(b.date));
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
