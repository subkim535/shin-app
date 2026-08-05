'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, datesInRange, dayOfWeek, diffDays, formatMonthDay, ISODate, todayISO, weekdayLabelKo } from '@/lib/domain/dateUtils';
import { PROCESS_COLOR, PROCESS_TYPE_MAP, customProcessColor } from '@/lib/domain/processTypes';
import { isBlockedForType, isWorkersDay, processLabel, workableSpanEnd } from '@/lib/domain/schedule';
import { Block, ChangeRecord, Holiday, ProcessInstance } from '@/lib/domain/types';

const HEADER_W = 96;
// 주공정 칩(예: "16F 갱폼" + ⚠ + 종일/오전/오후 + 더보기)이 한 줄에 다 들어가도록 폭을
// 넉넉히 잡는다. 좁으면 층수 붙은 갱폼 칩만 2줄로 접혀 높이가 들쭉날쭉해 거슬린다.
// (칸 폭은 균일해야 변경이력 고스트/화살표의 픽셀 위치 계산이 맞으므로 전체를 함께 넓힌다.)
const CELL_W = 176;
const REMARK_W = 140;
const HEADER_H = 48;
const ROW_MAIN_H = 52;
const ROW_SUB_H = 28;
const ROW_NOTE_H = 36;
const BAND_H = 22; // 동마다 공정 위에 붙는 "공사 구분 띠" 행 높이
const FALLBACK_COLOR = { bg: 'bg-slate-300', text: 'text-slate-900' };
// 공사 구분 띠 색 — 한 동 안에서 이어지는 공사끼리 색이 달라 보이게 순번대로 돌려 쓴다.
const BAND_COLORS = [
  'bg-blue-100 text-blue-800 border-blue-200',
  'bg-emerald-100 text-emerald-800 border-emerald-200',
  'bg-amber-100 text-amber-900 border-amber-200',
  'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  'bg-cyan-100 text-cyan-800 border-cyan-200',
];

type RowType = 'main' | 'sub';

interface GanttChartProps {
  blocks: Block[];
  processes: ProcessInstance[];
  holidays: Holiday[];
  changeHistory: ChangeRecord[];
  notes: Record<string, string>;
  onChangeNote: (blockId: string, date: ISODate, text: string) => void;
  onOpenNote: (blockId: string, date: ISODate) => void;
  onShowReason: (label: string, reason: string, path: string | undefined, processId: string) => void;
  onEditCrew: (processId: string) => void;
  onSetTimeSlot: (processId: string, slot: 'morning' | 'afternoon' | undefined) => void;
  onChangeBlockRemark: (blockId: string, text: string) => void;
  onClickHeaderDate: (date: ISODate) => void;
  viewStartDate: ISODate;
  dayCount: number;
  selectedProcessId: string | null;
  onSelectProcess: (id: string) => void;
  onDropProcess: (processId: string, blockId: string, date: ISODate) => void;
  onDropHeader: (fromDate: ISODate, toDate: ISODate) => void;
  onReorderCellOrder: (processId: string, direction: 'up' | 'down') => void;
  onToggleActualDone: (processId: string) => void;
  onCycleStatus: (processId: string) => void;
  onExtendProcess: (processId: string, direction: 'extend' | 'shrink') => void;
  onDeleteProcess: (processId: string) => void;
  onDeleteProcessCycle: (processId: string) => void;
  onMoveBlockTo: (draggedBlockId: string, targetBlockId: string) => void;
  onClickBlockName: (blockId: string) => void;
  // 동/층 검색으로 특정 동 행을 화면에 스크롤해서 보여줄 때 쓴다. nonce를 매번 바꿔서
  // 같은 동을 다시 검색해도(스크롤이 이미 그 위치라 값이 안 바뀌어도) 매번 스크롤이
  // 다시 실행되게 한다.
  scrollToBlockId?: { blockId: string; nonce: number } | null;
}

type DragState =
  | { type: 'process'; id: string; rowType: RowType; originBlockId: string; originDate: ISODate }
  | { type: 'header'; date: ISODate }
  | { type: 'block'; id: string };

function isHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return dayOfWeek(date) === 0 || isWorkersDay(date) || holidays.some((h) => h.date === date);
}

function noteKey(blockId: string, date: ISODate): string {
  return `${blockId}__${date}`;
}

// 같은 공정이 여러 번 이동했을 때 고스트에 붙이는 순번 표시 (①②③…, 21 이상은 숫자로).
function seqBadge(seq: number): string {
  return seq >= 1 && seq <= 20 ? String.fromCodePoint(0x2460 + seq - 1) : `(${seq})`;
}

export default function GanttChart({
  blocks,
  processes,
  holidays,
  changeHistory,
  notes,
  onChangeNote,
  onOpenNote,
  onShowReason,
  onEditCrew,
  onSetTimeSlot,
  onChangeBlockRemark,
  onClickHeaderDate,
  viewStartDate,
  dayCount,
  selectedProcessId,
  onSelectProcess,
  onDropProcess,
  onDropHeader,
  onReorderCellOrder,
  onToggleActualDone,
  onCycleStatus,
  onExtendProcess,
  onDeleteProcess,
  onDeleteProcessCycle,
  onMoveBlockTo,
  onClickBlockName,
  scrollToBlockId,
}: GanttChartProps) {
  const dates = useMemo(() => datesInRange(viewStartDate, dayCount), [viewStartDate, dayCount]);
  const dateIndex = useMemo(() => new Map(dates.map((d, i) => [d, i])), [dates]);
  const blockIndex = useMemo(() => new Map(blocks.map((b, i) => [b.id, i])), [blocks]);
  const today = todayISO();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [dragging, setDragging] = useState<DragState | null>(null);
  const [hoverCell, setHoverCell] = useState<{ blockId: string; date: ISODate } | null>(null);
  const [hoverHeaderDate, setHoverHeaderDate] = useState<ISODate | null>(null);
  const [hoverBlockId, setHoverBlockId] = useState<string | null>(null);
  // 연장/축소/삭제처럼 자주 안 쓰는 조작은 칩마다 버튼을 늘어놓지 않고 점 3개(⋯) 메뉴 하나로
  // 묶는다 — 매번 칩을 먼저 선택해야만 나오게 하면 불편하다는 피드백이 있었다. 셀에
  // overflow-y-auto가 걸려 있어 칩 옆에 바로 펼치면 잘릴 수 있으므로, 화면 좌표를 저장해
  // 그리드 바깥의 fixed 오버레이로 따로 그린다.
  const [chipMenu, setChipMenu] = useState<{
    processId: string;
    x: number;
    y: number;
    category: 'main' | 'sub';
    durationDays: number;
  } | null>(null);

  useEffect(() => {
    if (!chipMenu) return;
    function handleOutside() {
      setChipMenu(null);
    }
    window.addEventListener('pointerdown', handleOutside);
    return () => window.removeEventListener('pointerdown', handleOutside);
  }, [chipMenu]);

  // pointerup은 React state 커밋을 기다리지 않고 같은 제스처 안에서 즉시 window에
  // 리스너를 붙였다 떼는 ref 기반 방식으로 처리한다. state 업데이트 타이밍에 의존하면
  // 빠르게 이어지는 포인터 이벤트에서 드롭을 놓칠 수 있다.
  const dragRef = useRef<DragState | null>(null);
  const hoverCellRef = useRef<{ blockId: string; date: ISODate } | null>(null);
  const hoverHeaderDateRef = useRef<ISODate | null>(null);
  const hoverBlockIdRef = useRef<string | null>(null);

  function handlePointerUp() {
    const d = dragRef.current;
    if (d?.type === 'process') {
      const hc = hoverCellRef.current;
      if (hc) {
        if (hc.blockId !== d.originBlockId || hc.date !== d.originDate) {
          onDropProcess(d.id, hc.blockId, hc.date);
        } else {
          onSelectProcess(d.id);
        }
      }
    } else if (d?.type === 'header') {
      const hd = hoverHeaderDateRef.current;
      if (hd && hd !== d.date) {
        onDropHeader(d.date, hd);
      } else {
        onClickHeaderDate(d.date);
      }
    } else if (d?.type === 'block') {
      const hb = hoverBlockIdRef.current;
      if (hb && hb !== d.id) {
        onMoveBlockTo(d.id, hb);
      } else {
        onClickBlockName(d.id);
      }
    }
    dragRef.current = null;
    hoverCellRef.current = null;
    hoverHeaderDateRef.current = null;
    hoverBlockIdRef.current = null;
    setDragging(null);
    setHoverCell(null);
    setHoverHeaderDate(null);
    setHoverBlockId(null);
    window.removeEventListener('pointerup', handlePointerUp);
  }

  function startDragProcess(id: string, rowType: RowType, originBlockId: string, originDate: ISODate) {
    const d: DragState = { type: 'process', id, rowType, originBlockId, originDate };
    dragRef.current = d;
    hoverCellRef.current = { blockId: originBlockId, date: originDate };
    setDragging(d);
    setHoverCell(hoverCellRef.current);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function startDragHeader(date: ISODate) {
    const d: DragState = { type: 'header', date };
    dragRef.current = d;
    hoverHeaderDateRef.current = date;
    setDragging(d);
    setHoverHeaderDate(date);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function startDragBlock(id: string) {
    const d: DragState = { type: 'block', id };
    dragRef.current = d;
    hoverBlockIdRef.current = id;
    setDragging(d);
    setHoverBlockId(id);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function updateHoverBlock(id: string) {
    if (dragRef.current?.type !== 'block') return;
    hoverBlockIdRef.current = id;
    setHoverBlockId(id);
  }

  // rowType이 드래그 중인 항목과 일치하는 셀에서만 hover를 갱신한다.
  // 이렇게 하면 보조공정은 보조공정 행끼리만, 주요공정은 주요공정 행끼리만 드롭된다.
  function updateHoverCell(blockId: string, date: ISODate, rowType: RowType) {
    if (dragRef.current?.type !== 'process' || dragRef.current.rowType !== rowType) return;
    hoverCellRef.current = { blockId, date };
    setHoverCell(hoverCellRef.current);
  }

  function updateHoverHeader(date: ISODate) {
    if (dragRef.current?.type !== 'header') return;
    hoverHeaderDateRef.current = date;
    setHoverHeaderDate(date);
  }

  // 같은 날짜에 같은 공종 그룹(갱/철/AL — 타설은 제외)이 3개 이상 겹치는 날짜.
  // 처음 겹친 날뿐 아니라 그 날짜 헤더 자체를 표시해서 뒤에서도 눈에 띄게 한다.
  const heavyCollisionDates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of processes) {
      if (!p.conflictGroup) continue;
      const key = `${p.date}__${p.conflictGroup}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const dates = new Set<string>();
    for (const [key, count] of counts) {
      if (count >= 3) dates.add(key.split('__')[0]);
    }
    return dates;
  }, [processes]);

  const byBlockDateMain = useMemo(() => {
    const map = new Map<string, ProcessInstance[]>();
    for (const p of processes) {
      const category = PROCESS_TYPE_MAP[p.typeCode]?.category ?? 'main';
      if (category !== 'main') continue;
      const key = `${p.blockId}__${p.date}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    for (const list of map.values()) list.sort((a, b) => (a.cellOrder ?? 0) - (b.cellOrder ?? 0));
    return map;
  }, [processes]);

  const byBlockDateSub = useMemo(() => {
    const map = new Map<string, ProcessInstance[]>();
    for (const p of processes) {
      if (PROCESS_TYPE_MAP[p.typeCode]?.category !== 'sub') continue;
      const key = `${p.blockId}__${p.date}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (PROCESS_TYPE_MAP[a.typeCode]?.mainSequence ?? 0) - (PROCESS_TYPE_MAP[b.typeCode]?.mainSequence ?? 0));
    }
    return map;
  }, [processes]);

  // 다일 공정(일수>1)이 "지나가는" 날짜들 — 시작일 다음날부터 작업일 기준 끝날까지, 실제로
  // 일하는 작업일에만 표시(휴일은 빼서 그 날은 안 그림). 시작 셀에는 원래 칩이 있으니 제외.
  // 이걸로 시작일만 칩이 있고 나머지는 흰칸이라 "뭐하는 날인지 모르던" 것을 색바로 이어 보여준다.
  const spanByBlockDate = useMemo(() => {
    const map = new Map<string, ProcessInstance[]>();
    for (const p of processes) {
      const category = PROCESS_TYPE_MAP[p.typeCode]?.category ?? 'main';
      if (category !== 'main') continue;
      const dur = Math.max(1, Math.floor(p.durationDays || 1));
      if (dur <= 1) continue;
      const end = workableSpanEnd(p.typeCode, p.date, dur, holidays);
      let cur = addDays(p.date, 1);
      let guard = 0;
      while (cur <= end && guard++ < 400) {
        if (!isBlockedForType(p.typeCode, cur, holidays)) {
          const key = `${p.blockId}__${cur}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(p);
        }
        cur = addDays(cur, 1);
      }
    }
    return map;
  }, [processes, holidays]);

  // 동마다 "공사 구간(cycle)" 목록 — 한 동에 여러 공사가 이어질 때 어느 공사의 어느 부분인지
  // 알 수 있게, 각 공사의 이름(공사종류 + 층)과 기간(시작~끝날, 작업일·휴일 반영)을 뽑는다.
  // 공사종류는 커스텀 코드 `CUSTOM_<종류>_<번호>_<이름>`에서 종류를, 기준층은 층수를 쓴다.
  const sectionsByBlock = useMemo(() => {
    const byBlockCycle = new Map<string, ProcessInstance[]>();
    for (const p of processes) {
      const k = `${p.blockId}__${p.cycleId}`;
      if (!byBlockCycle.has(k)) byBlockCycle.set(k, []);
      byBlockCycle.get(k)!.push(p);
    }
    const map = new Map<string, { cycleId: string; label: string; start: ISODate; end: ISODate }[]>();
    for (const list of byBlockCycle.values()) {
      const blockId = list[0].blockId;
      let start = list[0].date;
      let end = list[0].date;
      let floor: string | undefined;
      for (const p of list) {
        if (p.date < start) start = p.date;
        const e = workableSpanEnd(p.typeCode, p.date, p.durationDays, holidays);
        if (e > end) end = e;
        if (p.floorLabel) floor = p.floorLabel;
      }
      // 공사종류(카테고리)는 같은 구간 단계들의 공통 접두어에서 뽑는다 — 코드가
      // `CUSTOM_<종류>_<번호>_<이름>`이고 <종류>에 "기초공사 1"처럼 공백→_이 섞여 있어도
      // (그 "_1"을 번호로 착각하지 않게) 여러 단계가 공유하는 접두어 `CUSTOM_<종류>_`로 정확히
      // 잘라낸다. 번호는 항상 0부터라 단계마다 갈라져서 접두어가 번호를 먹지 않는다.
      const customCodes = list.filter((p) => p.customLabel).map((p) => p.typeCode);
      let category: string | undefined;
      if (customCodes.length > 0) {
        let pre = customCodes[0];
        for (const c of customCodes) {
          while (!c.startsWith(pre)) pre = pre.slice(0, -1);
          if (!pre) break;
        }
        let cat = pre.replace(/^CUSTOM_/, '').replace(/_+$/, '');
        if (customCodes.length === 1) {
          // 단일 단계면 접두어가 번호·이름까지 포함하므로 정규식으로 최선 파싱.
          const m = customCodes[0].match(/^CUSTOM_(.+?)_\d+_/);
          if (m) cat = m[1];
        }
        category = cat.replace(/_/g, ' ').trim();
      }
      const isCustom = customCodes.length > 0;
      const name = category || (isCustom ? '구간공정' : '지상층');
      const label = floor ? `${floor} ${name}` : name;
      if (!map.has(blockId)) map.set(blockId, []);
      map.get(blockId)!.push({ cycleId: list[0].cycleId, label, start, end });
    }
    for (const arr of map.values()) arr.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    return map;
  }, [processes, holidays]);

  // 프로세스별 전체 이동 이력을 발생 순서대로 모아둔다 (changeHistory는 append 순서라
  // 이 순서 자체가 시간순). 같은 공정이 여러 번 옮겨졌으면 전부 그리드에 표시한다.
  const movesByProcessId = useMemo(() => {
    const map = new Map<string, ChangeRecord[]>();
    for (const c of changeHistory) {
      if (!map.has(c.processId)) map.set(c.processId, []);
      map.get(c.processId)!.push(c);
    }
    return map;
  }, [changeHistory]);

  const processById = useMemo(() => new Map(processes.map((p) => [p.id, p])), [processes]);

  // 고스트와 화살표가 같은 레인 번호를 공유하므로(위 참고), 레인 간격도 하나만 써야 레인
  // 번호가 같을 때 실제 픽셀 위치도 같아진다. 서로 다른 간격을 쓰면 0번 레인만 우연히
  // 맞고 그 아래(1번, 2번...)부터는 다시 어긋난다.
  const GHOST_BOX_H = 24; // 고스트 한 줄이 실제로 차지하는 높이(실측 약 23px, 여유 포함)
  const LANE_STEP = GHOST_BOX_H + 6; // 박스 높이보다 여유를 둬서, 같은 칸에 쌓인 고스트끼리 붙어 보이지 않게 간격을 확보한다

  // 고스트가 시작되는 기준 높이. 'bottom'은 화살표(항상 행 아래쪽에 그린다)와 같은 높이에서
  // 이어져 나오는 것처럼 보이도록, 화살표 높이 바로 위에 고스트 박스가 오게 맞춘다.
  function ghostBaseOffset(anchor: 'top' | 'bottom', base: number): number {
    // 'bottom'(원래 칸에 실제 공정이 남아있는 경우)은 그 공정 칩(약 34~40px)보다 아래에
    // 오도록 내려서, 회색 고스트가 칩과 겹치지 않게 한다. 행 높이는 rowMetrics에서 그만큼
    // 자동으로 늘어난다.
    return anchor === 'top' ? 0 : base - 12;
  }

  // 두 구간이 겹치지 않는 첫 번째 레인을 찾아 배정한다(겹치는 화살표만 갈라놓고,
  // 안 겹치는 화살표는 그냥 같은 레인을 써서 불필요하게 어긋나지 않게 한다).
  function assignLane(laneEnds: number[], start: number, end: number): number {
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] < start) {
        laneEnds[i] = end;
        return i;
      }
    }
    laneEnds.push(end);
    return laneEnds.length - 1;
  }

  // 1단계: 좌표 계산 없이 순수 논리(어느 행/칸, 몇 번, 위/아래 밀림 여부, 몇 번째로 쌓였는지)만 모은다.
  // 행 높이가 몇 번 쌓였는지에 따라 달라지므로, 좌표를 계산하려면 이 정보가 먼저 다 모여야 한다.
  const rawVisuals = useMemo(() => {
    type Info = {
      proc: ProcessInstance;
      record: ChangeRecord;
      rowIndex: number;
      rowType: RowType;
      label: string;
      path: string;
      seq: number;
      originCol?: number;
      destCol?: number;
      isBackward: boolean;
      isOneDay: boolean;
    };
    const infos: Info[] = [];
    for (const records of movesByProcessId.values()) {
      const proc = processById.get(records[0].processId);
      if (!proc) continue;
      const rowIndex = blockIndex.get(proc.blockId);
      if (rowIndex === undefined) continue;
      const rowType: RowType = PROCESS_TYPE_MAP[proc.typeCode]?.category === 'sub' ? 'sub' : 'main';
      const label = processLabel(proc);
      // 그리드에는 최근 3번만 표시하지만, 클릭했을 때 보여줄 전체 이동 경로는 처음부터
      // 끝까지 다 모아둔다 (예: "7/27 → 7/28 → 7/27 → 7/29").
      const path = [records[0].previousDate, ...records.map((r) => r.newDate)].join(' → ');
      // 이동 이력을 전부 다 표시하면 여러 번 옮긴 공정은 고스트가 겹겹이 쌓여 지저분해진다.
      // 최근 3번만 남기고, 가장 최근 이동이 항상 ①이 되도록 최신순으로 번호를 매긴다
      // (계속 옮기면 ①이던 게 ②, ③으로 밀려나다가 4번째부터는 화면에서 사라진다).
      const recent = records.slice(-3);
      recent.forEach((record, i) => {
        const magnitude = diffDays(record.previousDate, record.newDate);
        if (magnitude === 0) return;
        infos.push({
          proc,
          record,
          rowIndex,
          rowType,
          label,
          path,
          seq: recent.length - i, // 최신이 1번
          originCol: dateIndex.get(record.previousDate),
          destCol: dateIndex.get(record.newDate),
          isBackward: magnitude < 0,
          isOneDay: Math.abs(magnitude) === 1,
        });
      });
    }

    // 고스트와 그 화살표는 "한 세트"이므로 같은 레인을 함께 써야 항상 붙어 보인다. 그러려면
    // 레인 배정 자체를 하나로 합쳐야 한다 — 고스트는 원래 칸(점) 하나, 화살표는 원래~새
    // 날짜 구간을 "차지"한다고 보고, 같은 행(주공정/보조공정 행)에서 그 구간이 겹치는
    // 것끼리만 다른 레인으로 갈라놓는다. 번호가 작을수록(최신일수록) 먼저 자리를 배정받게
    // 정렬해두면, 같은 칸을 공유하는 고스트들 중 ①이 자연스럽게 가장 앞 레인을 차지한다.
    infos.sort((a, b) => a.seq - b.seq);

    const laneEndsByRow = new Map<string, number[]>();
    const ghosts: {
      date: ISODate;
      label: string;
      reason: string;
      path: string;
      processId: string;
      colIndex: number;
      rowIndex: number;
      rowType: RowType;
      anchor: 'top' | 'bottom';
      oneDayDirection?: 'right';
      seq: number;
      lane: number;
    }[] = [];
    const arrows: {
      originCol: number;
      destCol: number;
      rowIndex: number;
      rowType: RowType;
      lane: number;
      label: string;
      reason: string;
      path: string;
      processId: string;
    }[] = [];
    for (const info of infos) {
      if (info.originCol === undefined) continue;
      // 이전 날짜(왼쪽)로 당긴 이동은 고스트 자체를 아예 남기지 않는다 — 비워진 그 칸에는
      // 곧 이후 공정이 들어와야 하므로 흔적이 방해가 된다. 뒤로 밀린(지연된) 이동만 흔적을 남긴다.
      if (info.isBackward) continue;
      const hasArrow = info.destCol !== undefined && !info.isOneDay;
      const footprintStart = hasArrow ? Math.min(info.originCol, info.destCol!) : info.originCol;
      const footprintEnd = hasArrow ? Math.max(info.originCol, info.destCol!) : info.originCol;
      const laneKey = `${info.rowIndex}_${info.rowType}`;
      const ends = laneEndsByRow.get(laneKey) ?? [];
      laneEndsByRow.set(laneKey, ends);
      const lane = assignLane(ends, footprintStart, footprintEnd);

      // 그 칸(원래 날짜)에 실제 공정이 남아있을 때만 겹쳐 보이므로, 그럴 때만 고스트를 행
      // 아래쪽으로 내린다. 2일 이상 이동은 화살표가 항상 행 아래쪽에 그려지므로, 고스트도
      // 같은 높이로 맞춰야 화살표가 고스트에서 이어져 나오는 것처럼 보인다.
      const originHasRealContent = (info.rowType === 'main' ? byBlockDateMain : byBlockDateSub).has(
        `${info.proc.blockId}__${info.record.previousDate}`,
      );
      const anchor: 'top' | 'bottom' = hasArrow || originHasRealContent ? 'bottom' : 'top';
      ghosts.push({
        date: info.record.previousDate,
        label: info.label,
        reason: info.record.reason,
        path: info.path,
        processId: info.proc.id,
        colIndex: info.originCol,
        rowIndex: info.rowIndex,
        rowType: info.rowType,
        anchor,
        // 하루 이동은 점선 화살표 대신 라벨 글자 뒤에 작은 방향 표시를 붙인다 (SVG로 따로
        // 그리면 라벨 텍스트 폭을 몰라서 겹치기 쉽다 — 같은 텍스트 줄에 넣으면 브라우저가
        // 알아서 겹치지 않게 배치해준다). 당겨진(왼쪽) 이동은 위에서 이미 걸러지므로 여기
        // 도달하는 건 항상 지연(오른쪽) 방향이다.
        oneDayDirection: info.isOneDay ? 'right' : undefined,
        seq: info.seq,
        lane,
      });
      if (hasArrow) {
        arrows.push({
          originCol: info.originCol,
          destCol: info.destCol!,
          rowIndex: info.rowIndex,
          rowType: info.rowType,
          lane,
          label: info.label,
          reason: info.record.reason,
          path: info.path,
          processId: info.proc.id,
        });
      }
    }
    return { ghosts, arrows };
  }, [movesByProcessId, processById, blockIndex, dateIndex, byBlockDateMain, byBlockDateSub]);

  // 2단계: 한 칸에 고스트/화살표가 여러 개 쌓이면 그만큼 그 행(주공정/보조공정 행 각각)의 높이를 늘린다.
  const rowMetrics = useMemo(() => {
    const extra = new Map<string, number>(); // key: `${rowIndex}_${rowType}` -> 기본 높이를 넘어서는 만큼(px)
    for (const g of rawVisuals.ghosts) {
      const base = g.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const topOffset = ghostBaseOffset(g.anchor, base) + g.lane * LANE_STEP;
      const neededBottom = topOffset + GHOST_BOX_H;
      const key = `${g.rowIndex}_${g.rowType}`;
      extra.set(key, Math.max(extra.get(key) ?? 0, neededBottom - base));
    }
    for (const a of rawVisuals.arrows) {
      const base = a.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const neededBottom = base - 6 + a.lane * LANE_STEP + 6;
      const key = `${a.rowIndex}_${a.rowType}`;
      extra.set(key, Math.max(extra.get(key) ?? 0, neededBottom - base));
    }

    // 보조공정 배지가 한 셀에서 여러 줄로 늘어나는(특히 오전/오후로 반씩 나뉘어 칸이
    // 좁아진) 경우, 28px 고정 높이에선 잘려서 스크롤된다. 동별로 셀마다 필요한 보조공정
    // 줄 수를 세어, 가장 많이 필요한 만큼 그 동의 보조 행 높이를 늘린다.
    const SUB_LINE_H = 22; // 배지 한 줄이 차지하는 높이(약 20px) + 줄 간격
    const subContentExtra: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let maxLines = 1;
      for (const d of dates) {
        const key = `${block.id}__${d}`;
        const subs = byBlockDateSub.get(key) ?? [];
        if (subs.length === 0) continue;
        const mains = byBlockDateMain.get(key) ?? [];
        const mainIds = new Set(mains.map((m) => m.id));
        const half =
          mains.length === 2 &&
          (mains[0].timeSlot === 'morning' || mains[0].timeSlot === 'afternoon') &&
          (mains[1].timeSlot === 'morning' || mains[1].timeSlot === 'afternoon') &&
          mains[0].timeSlot !== mains[1].timeSlot;
        let lines: number;
        if (half) {
          // 반나절 분할: 각 주공정의 보조공정이 좁은 칸에 한 줄씩 쌓인다 → 양쪽 중 많은 쪽
          const perMain = new Map<string, number>();
          for (const s of subs) {
            if (s.linkedMainProcessId && mainIds.has(s.linkedMainProcessId))
              perMain.set(s.linkedMainProcessId, (perMain.get(s.linkedMainProcessId) ?? 0) + 1);
          }
          lines = Math.max(1, ...perMain.values());
        } else {
          // 일반(넓은 칸): 배지 하나가 꽤 넓어(전기·설비 등 ~90px) 한 칸(152px)에 두 개를
          // 다 못 넣고 줄바꿈되는 경우가 많다. 잘림을 막으려고 배지 하나당 한 줄로 넉넉히 잡는다.
          lines = Math.max(1, subs.length);
        }
        if (lines > maxLines) maxLines = lines;
      }
      subContentExtra.push(Math.max(0, maxLines * SUB_LINE_H + 6 - ROW_SUB_H));
    }

    // 한 칸에 주공정 칩이 여러 개 쌓이면(예: 구간공정 여러 단계가 같은 날) 기본 높이(칩 1개)
    // 에선 잘려서 칸 안에서 스크롤해야 한다. 동별로 한 칸에 들어가는 주공정 칩의 최대 개수를
    // 세어, 그만큼 그 동의 주공정 행 높이를 늘려 다 보이게 한다. (칩 1개는 기본 높이가 감당)
    const MAIN_CHIP_H = 46; // 칩 한 개가 차지하는 높이(컨트롤이 좁은 칸에서 줄바꿈되는 것 포함)
    const mainContentExtra: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let maxChips = 1;
      for (const d of dates) {
        const mains = byBlockDateMain.get(`${block.id}__${d}`) ?? [];
        if (mains.length > maxChips) maxChips = mains.length;
      }
      mainContentExtra.push(Math.max(0, (maxChips - 1) * MAIN_CHIP_H));
    }

    const mainH: number[] = [];
    const subH: number[] = [];
    const blockTop: number[] = [];
    let cursor = HEADER_H;
    for (let i = 0; i < blocks.length; i++) {
      blockTop.push(cursor); // 동의 맨 위 = 공사 구분 띠 행의 top
      const mh = ROW_MAIN_H + Math.max(extra.get(`${i}_main`) ?? 0, mainContentExtra[i] ?? 0);
      const sh = ROW_SUB_H + Math.max(extra.get(`${i}_sub`) ?? 0, subContentExtra[i] ?? 0);
      mainH.push(mh);
      subH.push(sh);
      cursor += BAND_H + mh + sh + ROW_NOTE_H;
    }
    return { mainH, subH, blockTop, totalHeight: cursor };
  }, [rawVisuals, blocks, dates, byBlockDateMain, byBlockDateSub]);

  function rowTopFor(rowIndex: number, rowType: RowType): number {
    // rawVisuals/rowMetrics는 같은 blocks 값에서 계산되지만, 다른 사용자가 동에서 실시간으로
    // 동을 추가/삭제하는 순간과 겹치면 한 렌더 동안 rowIndex가 잠깐 범위를 벗어날 수 있다.
    // 그 경우 NaN 스타일이 나가지 않도록 0으로 안전하게 대체한다(다음 렌더에서 바로 정상화된다).
    // blockTop은 띠 행의 top이므로, 주공정/보조공정 행은 그 아래로 BAND_H만큼 내려간다.
    const top = (rowMetrics.blockTop[rowIndex] ?? 0) + BAND_H;
    return top + (rowType === 'sub' ? (rowMetrics.mainH[rowIndex] ?? ROW_MAIN_H) : 0);
  }

  // 3단계: 이제 행 높이가 확정됐으니 실제 픽셀 좌표를 계산한다.
  const visuals = useMemo(() => {
    const ghosts = rawVisuals.ghosts.map((g) => {
      const base = g.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const topOffset = ghostBaseOffset(g.anchor, base) + g.lane * LANE_STEP;
      return { ...g, top: rowTopFor(g.rowIndex, g.rowType) + topOffset };
    });
    const arrows = rawVisuals.arrows.map((a) => {
      const originLeft = HEADER_W + a.originCol * CELL_W;
      const destLeft = HEADER_W + a.destCol * CELL_W;
      // 라벨과 겹치지 않도록, 두 셀의 텍스트를 지나지 않고 그 "사이 빈 공간"만 지나가게 그린다.
      // (1일 이동은 애초에 arrows에 안 들어오고 고스트 라벨 옆 ◀/▶ 표시로 대신한다.)
      const [x1, x2] = a.destCol > a.originCol ? [originLeft + CELL_W, destLeft] : [originLeft, destLeft + CELL_W];
      // 칩 텍스트 줄 높이(맨 위)에 그리면, 이동 구간이 여러 칸에 걸칠 때 그 사이에 있는
      // 다른 실제 공정들의 텍스트를 그대로 가로질러 지나가게 된다. 정방향/역방향 모두 행
      // 아래쪽 여백(칩이 잘 안 쌓이는 자리)에 그려서 이런 충돌을 피한다. 행이 다른 이유로
      // (고스트 누적 등) 늘어나도 화살표 위치가 같이 딸려 내려가지 않도록, 늘어나기 전
      // 기본 높이를 기준으로 삼는다. 고스트 박스의 맨 아래가 아니라 그 박스의 세로 중앙
      // (글자가 있는 높이)을 지나가게 살짝 위로 올려서, 고스트 글자에서 바로 이어지는
      // 것처럼 보이게 한다.
      const base = a.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const baseY = rowTopFor(a.rowIndex, a.rowType) + base - 12 + GHOST_BOX_H / 2;
      const y = baseY + a.lane * LANE_STEP; // 같은 행에서 겹치는 화살표끼리 살짝 어긋나게 (고스트와 같은 간격을 써야 레인이 맞는다)
      return { x1, y1: y, x2, y2: y, label: a.label, reason: a.reason, path: a.path, processId: a.processId };
    });
    return { ghosts, arrows };
  }, [rawVisuals, rowMetrics]);

  const totalWidth = HEADER_W + dates.length * CELL_W + REMARK_W;
  const totalHeight = rowMetrics.totalHeight;
  const gridTemplateRows =
    `${HEADER_H}px ` + blocks.map((_, i) => `${BAND_H}px ${rowMetrics.mainH[i]}px ${rowMetrics.subH[i]}px ${ROW_NOTE_H}px`).join(' ');

  // 동/층 검색으로 특정 동을 찾으면 그 동 행이 세로로 화면에 보이게 스크롤한다.
  useEffect(() => {
    if (!scrollToBlockId) return;
    const rowIndex = blockIndex.get(scrollToBlockId.blockId);
    const container = scrollContainerRef.current;
    if (rowIndex === undefined || !container) return;
    const top = rowMetrics.blockTop[rowIndex] ?? 0;
    const targetScroll = Math.max(0, top - HEADER_H);
    container.scrollTo({ top: targetScroll, behavior: 'smooth' });
  }, [scrollToBlockId, blockIndex, rowMetrics]);

  // 같은 날짜에 같이 붙는 보조공정(박리제/전기·설비/철근검측 등)을 별도 행이 아니라
  // 주공정 칩 바로 아래에 작은 배지로 묶어서 보여준다 — 체크·드래그·삭제는 그대로 되지만
  // 자리를 거의 안 차지한다.
  function renderSubBadge(s: ProcessInstance, blockId: string, date: ISODate) {
    const isDragSource = dragging?.type === 'process' && dragging.id === s.id;
    return (
      <button
        key={s.id}
        type="button"
        onPointerDown={(e) => {
          e.stopPropagation();
          startDragProcess(s.id, 'sub', blockId, date);
        }}
        data-process-id={s.id}
        data-testid="sub-badge"
        className={[
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-tight bg-zinc-100 text-zinc-700 border border-zinc-300 max-w-full shrink-0',
          'cursor-grab active:cursor-grabbing',
          selectedProcessId === s.id ? 'ring-1 ring-indigo-600' : '',
          isDragSource ? 'opacity-50' : '',
          s.actualDone ? 'line-through decoration-1' : '',
        ].join(' ')}
      >
        <span
          role="checkbox"
          aria-checked={!!s.actualDone}
          title="실제 완료 여부"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleActualDone(s.id);
          }}
          className={[
            'inline-flex items-center justify-center w-3 h-3 rounded-sm border shrink-0',
            s.actualDone ? 'bg-emerald-600 border-emerald-700 text-white' : 'border-current bg-white/60',
          ].join(' ')}
        >
          {s.actualDone ? '✓' : ''}
        </span>
        <span className="whitespace-nowrap">{processLabel(s)}</span>
        <span
          role="button"
          tabIndex={0}
          title="삭제"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteProcess(s.id);
          }}
          className="shrink-0 text-zinc-400 hover:text-red-600 font-semibold"
        >
          ×
        </span>
      </button>
    );
  }

  // 다일 공정이 "지나가는" 날에 그리는 연속 바 — 시작 칩과 같은 색(연하게)에 이름을 달아
  // 그 날 무슨 공정이 진행 중인지 보이게 한다. 클릭하면 그 공정을 선택. 드래그는 시작 칩에서만.
  function renderSpanBar(p: ProcessInstance) {
    const color = PROCESS_COLOR[p.typeCode] ?? (p.customLabel ? customProcessColor(p.customLabel) : FALLBACK_COLOR);
    const selected = p.id === selectedProcessId;
    return (
      <button
        key={p.id}
        type="button"
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelectProcess(p.id);
        }}
        title={`${processLabel(p)} · ${p.durationDays}일 공정 진행 중`}
        className={[
          'w-full text-left rounded px-1.5 py-0.5 text-[11px] leading-tight truncate opacity-60',
          `${color.bg} ${color.text}`,
          selected ? 'ring-2 ring-indigo-600 opacity-90' : '',
        ].join(' ')}
      >
        ↔ {processLabel(p)}
      </button>
    );
  }

  // 이제 이 함수는 주공정 칩 전용이다 — 보조공정은 renderSubBadge가 전담한다.
  function renderChip(p: ProcessInstance, blockId: string, date: ISODate) {
    const def = PROCESS_TYPE_MAP[p.typeCode];
    const selected = p.id === selectedProcessId;
    const color = PROCESS_COLOR[p.typeCode] ?? (p.customLabel ? customProcessColor(p.customLabel) : FALLBACK_COLOR);
    const isDragSource = dragging?.type === 'process' && dragging.id === p.id;
    const label = processLabel(p);
    // 지연: 계획 날짜가 오늘보다 지났는데 "실제 완료" 체크가 안 된 공정 — 빨갛게 강조한다.
    const overdue = !p.actualDone && p.date < today;
    return (
      // 칩 "그림"만 변경이력 고스트/화살표 레이어(z5)보다 위(z10)로 올린다. 셀 전체가
      // 아니라 칩 박스만 올리므로, 회색 고스트/점선 화살표가 칩을 가리지는 않으면서도
      // 빈 칸을 지나는 화살표는 끊기지 않고 그대로 이어져 보인다.
      <div key={p.id} className="relative z-10 flex items-center gap-0.5 w-full min-w-0 flex-wrap">
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
            startDragProcess(p.id, 'main', blockId, date);
          }}
          data-process-id={p.id}
          title={p.crew ? `${p.crew.team} · ${p.crew.headcount}명` : undefined}
          className={[
            'text-left rounded px-1.5 py-0.5 text-xs leading-tight relative flex-1 min-w-[44px]',
            `font-semibold ${color.bg} ${color.text}`,
            'cursor-grab active:cursor-grabbing',
            selected ? 'ring-2 ring-indigo-600' : overdue ? 'ring-2 ring-red-500' : '',
            isDragSource ? 'opacity-50' : '',
            p.actualDone ? 'line-through decoration-2' : '',
          ].join(' ')}
        >
          {overdue && (
            <span title="지연 (계획일이 지났는데 완료 안 됨)" className="mr-0.5 text-red-600 font-bold align-middle">
              ⚠
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            title={
              p.actualDone
                ? '상태: 완료 (클릭 → 시작 전)'
                : p.inProgress
                  ? '상태: 진행 중 (클릭 → 완료)'
                  : '상태: 시작 전 (클릭 → 진행 중)'
            }
            data-testid="status-toggle"
            data-status={p.actualDone ? 'done' : p.inProgress ? 'in_progress' : 'not_started'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCycleStatus(p.id);
            }}
            className={[
              'inline-flex items-center justify-center w-3.5 h-3.5 mr-1 rounded-sm border align-middle shrink-0 text-[9px] leading-none font-bold',
              p.actualDone
                ? 'bg-emerald-600 border-emerald-700 text-white'
                : p.inProgress
                  ? 'bg-sky-500 border-sky-600 text-white'
                  : 'border-current bg-white/60',
            ].join(' ')}
          >
            {p.actualDone ? '✓' : p.inProgress ? '▶' : ''}
          </span>
          {def?.showFloorLabel && p.floorLabel ? `${p.floorLabel} ` : ''}
          {label}
          {p.conflictSeq ? <sup className="ml-0.5">{p.conflictSeq}</sup> : null}
          {p.durationDays && p.durationDays > 1 ? (
            <span
              className="ml-1 inline-block px-1 rounded bg-white/70 text-[9px] align-middle"
              title={`${p.durationDays}일짜리 공정으로 연장됨`}
            >
              {p.durationDays}일
            </span>
          ) : null}
          {p.crew ? <span className="ml-0.5 text-[9px] opacity-80">👷{p.crew.headcount}</span> : null}
          {p.cellOrder ? (
            <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white/70 text-[9px] text-zinc-800">
                {p.cellOrder}
              </span>
              <span
                role="button"
                tabIndex={0}
                title="순서 앞당기기"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onReorderCellOrder(p.id, 'up');
                }}
                className="text-[9px] leading-none px-0.5"
              >
                ▲
              </span>
              <span
                role="button"
                tabIndex={0}
                title="순서 미루기"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onReorderCellOrder(p.id, 'down');
                }}
                className="text-[9px] leading-none px-0.5"
              >
                ▼
              </span>
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEditCrew(p.id);
          }}
          title="작업팀·투입인원"
          data-testid="crew-edit"
          className="shrink-0 text-zinc-400 hover:text-zinc-700 text-[9px] leading-none px-0.5"
        >
          👷
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const next = p.timeSlot === 'morning' ? 'afternoon' : p.timeSlot === 'afternoon' ? undefined : 'morning';
            onSetTimeSlot(p.id, next);
          }}
          title="오전/오후 반나절 설정 (설정 시 같은 날 다른 주요공정과 겹침 허용)"
          data-testid="timeslot-toggle"
          className={[
            'shrink-0 text-[9px] leading-none px-1 py-0.5 rounded border',
            p.timeSlot === 'morning'
              ? 'bg-sky-100 text-sky-700 border-sky-300'
              : p.timeSlot === 'afternoon'
                ? 'bg-violet-100 text-violet-700 border-violet-300'
                : 'text-zinc-400 border-zinc-200 hover:text-zinc-700',
          ].join(' ')}
        >
          {p.timeSlot === 'morning' ? '오전' : p.timeSlot === 'afternoon' ? '오후' : '종일'}
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setChipMenu((cur) =>
              cur?.processId === p.id
                ? null
                : { processId: p.id, x: rect.left, y: rect.bottom + 2, category: 'main', durationDays: p.durationDays ?? 1 },
            );
          }}
          title="더보기 (연장·삭제 등)"
          data-testid="chip-menu-toggle"
          className="shrink-0 text-zinc-400 hover:text-zinc-700 text-[9px] leading-none px-0.5"
        >
          ⋯
        </button>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="overflow-auto border border-zinc-200 rounded-md flex-1 min-h-0" data-testid="gantt-chart">
      <div
        className={dragging ? 'select-none' : ''}
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: `${HEADER_W}px repeat(${dates.length}, ${CELL_W}px) ${REMARK_W}px`,
          gridTemplateRows,
          width: totalWidth,
          height: totalHeight,
        }}
      >
        {/* 좌상단 코너 */}
        <div
          className="sticky top-0 left-0 z-30 bg-zinc-100 border-b border-r border-zinc-200 flex items-center justify-center font-medium text-sm"
          style={{ gridColumn: 1, gridRow: 1 }}
        >
          동/구간
        </div>

        {/* 날짜 헤더: 클릭하면 작업일보, 드래그하면 전체 일정 순연 */}
        {dates.map((d, colIndex) => {
          const isToday = d === today;
          const holiday = isHoliday(d, holidays);
          const heavyCollision = heavyCollisionDates.has(d);
          const isDragSource = dragging?.type === 'header' && dragging.date === d;
          const isHoverTarget = dragging?.type === 'header' && hoverHeaderDate === d;
          return (
            <div
              key={d}
              onPointerDown={() => startDragHeader(d)}
              onPointerEnter={() => updateHoverHeader(d)}
              data-header-date={d}
              title={
                heavyCollision
                  ? '같은 공종이 3개 이상 겹치는 날짜 / 클릭: 작업일보/순연 선택 / 드래그: 전체 일정 순연'
                  : '클릭: 작업일보/순연 선택 / 드래그: 전체 일정 순연'
              }
              data-heavy-collision={heavyCollision || undefined}
              className={[
                'sticky top-0 z-20 border-b border-l border-zinc-200 flex flex-col items-center justify-center text-xs cursor-grab active:cursor-grabbing',
                heavyCollision ? 'bg-red-100 text-red-700' : isToday ? 'bg-indigo-50' : 'bg-zinc-50',
                isToday ? 'border-b-2 border-b-indigo-900' : '',
                holiday && !isToday && !heavyCollision ? 'bg-red-50 text-red-500' : '',
                isDragSource ? 'opacity-50' : '',
                isHoverTarget ? 'ring-2 ring-inset ring-indigo-600' : '',
              ].join(' ')}
              style={{ gridColumn: colIndex + 2, gridRow: 1 }}
            >
              <div>{formatMonthDay(d)}</div>
              <div className="text-[11px]">{weekdayLabelKo(d)}</div>
            </div>
          );
        })}

        {/* 비고 헤더 */}
        <div
          className="sticky top-0 right-0 z-30 bg-zinc-100 border-b border-l border-zinc-200 flex items-center justify-center font-medium text-sm"
          style={{ gridColumn: dates.length + 2, gridRow: 1 }}
        >
          비고
        </div>

        {/* 행 헤더 (동 이름, 3행 전체에 걸쳐 표시) — 드래그해서 동 순서를 자유롭게 바꿀 수 있다 */}
        {blocks.map((block, rowIndex) => {
          const isDragSource = dragging?.type === 'block' && dragging.id === block.id;
          const isHoverTarget = dragging?.type === 'block' && dragging.id !== block.id && hoverBlockId === block.id;
          return (
            <div
              key={`label-${block.id}`}
              onPointerDown={() => startDragBlock(block.id)}
              onPointerEnter={() => updateHoverBlock(block.id)}
              data-block-row={block.name}
              title="드래그해서 동 순서 변경 / 클릭: PDF·엑셀 내보내기"
              className={[
                'sticky left-0 z-20 bg-white border-b-2 border-r border-zinc-200 border-b-zinc-900 flex flex-col justify-center px-2 font-medium whitespace-nowrap cursor-grab active:cursor-grabbing',
                isDragSource ? 'opacity-50' : '',
                isHoverTarget ? 'ring-2 ring-inset ring-indigo-600' : '',
              ].join(' ')}
              style={{ gridColumn: 1, gridRow: `${rowIndex * 4 + 2} / span 4` }}
            >
              <span>{block.name}</span>
              {block.info && <span className="text-[10px] text-zinc-400 font-normal">{block.info}</span>}
            </div>
          );
        })}

        {/* 비고 열 (동 단위, 날짜와 무관, 오른쪽 고정) */}
        {blocks.map((block, rowIndex) => (
          <div
            key={`remark-${block.id}`}
            className="sticky right-0 z-10 bg-zinc-50 border-b-2 border-l border-zinc-200 border-b-zinc-900 px-1 py-1"
            style={{ gridColumn: dates.length + 2, gridRow: `${rowIndex * 4 + 2} / span 4` }}
          >
            <textarea
              value={block.remark ?? ''}
              onChange={(e) => onChangeBlockRemark(block.id, e.target.value)}
              placeholder="비고"
              data-testid="block-remark"
              className="w-full h-full text-[10px] px-1 py-0.5 bg-transparent outline-none resize-none placeholder:text-zinc-300"
            />
          </div>
        ))}

        {/* 공사 구분 띠: 동마다 공정 위 한 줄에, 이어지는 공사들을 이름·기간 구간으로 표시 */}
        {blocks.map((block, rowIndex) => {
          const bandRow = rowIndex * 4 + 2;
          const sections = sectionsByBlock.get(block.id) ?? [];
          const first = dates[0];
          const last = dates[dates.length - 1];
          return (
            <div key={`band-${block.id}`} style={{ display: 'contents' }}>
              <div
                className="border-b border-l border-zinc-200 bg-zinc-50"
                style={{ gridColumn: `2 / ${dates.length + 2}`, gridRow: bandRow }}
              />
              {sections.map((sec, si) => {
                if (sec.end < first || sec.start > last) return null; // 보이는 주간 밖이면 skip
                const s = sec.start < first ? first : sec.start;
                const e = sec.end > last ? last : sec.end;
                const startCol = dateIndex.get(s);
                const endCol = dateIndex.get(e);
                if (startCol === undefined || endCol === undefined) return null;
                return (
                  <div
                    key={sec.cycleId}
                    title={`${sec.label} · ${sec.start} ~ ${sec.end}`}
                    className={[
                      'flex items-center gap-1 overflow-hidden whitespace-nowrap rounded-sm border px-1.5 my-[1px] text-[11px] font-semibold leading-none',
                      BAND_COLORS[si % BAND_COLORS.length],
                    ].join(' ')}
                    style={{ gridColumn: `${startCol + 2} / ${endCol + 3}`, gridRow: bandRow, zIndex: 6 }}
                  >
                    <span className="truncate">{sec.label}</span>
                    <span className="font-normal opacity-70 shrink-0">
                      {sec.start.slice(5)}~{sec.end.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* 본문: 동마다 주요공정 / 보조공정 / 특이사항 3행 */}
        {blocks.map((block, rowIndex) =>
          dates.map((d, colIndex) => {
            const mainKey = `${block.id}__${d}`;
            const mainProcs = byBlockDateMain.get(mainKey) ?? [];
            const allSubProcs = byBlockDateSub.get(mainKey) ?? [];
            // 같은 날짜의 보조공정은 자기 주공정(linkedMainProcessId)이 이 셀에 있으면 그
            // 주공정 칩 안에 작은 배지로 붙여서 보여준다. 주공정이 이 셀에 없는(예: 다음날
            // 붙는 먹메김이 우연히 다른 주공정 없이 혼자 있는) 경우만 아래 보조공정 행에
            // 그대로 남겨둔다.
            const mainIds = new Set(mainProcs.map((m) => m.id));
            const attachedSubsByMain = new Map<string, ProcessInstance[]>();
            const orphanSubProcs: ProcessInstance[] = [];
            for (const s of allSubProcs) {
              if (s.linkedMainProcessId && mainIds.has(s.linkedMainProcessId)) {
                if (!attachedSubsByMain.has(s.linkedMainProcessId)) attachedSubsByMain.set(s.linkedMainProcessId, []);
                attachedSubsByMain.get(s.linkedMainProcessId)!.push(s);
              } else {
                orphanSubProcs.push(s);
              }
            }
            // 이 셀에 그릴 항목 = 시작하는 주공정(칩) + 지나가는 다일공정(연속 바).
            const spanProcs = spanByBlockDate.get(mainKey) ?? [];
            const cellItems = [
              ...mainProcs.map((p) => ({ p, span: false })),
              ...spanProcs.map((p) => ({ p, span: true })),
            ];
            const slotRank = (p: ProcessInstance) => (p.timeSlot === 'morning' ? 0 : p.timeSlot === 'afternoon' ? 1 : 2);
            // 오전 항목과 오후 항목이 둘 다 있고 "종일" 항목이 없으면 좌(오전)/우(오후)로 반씩
            // 나눠 공존시킨다 — 이렇게 하면 오전 1일 공정과 오후 다일 공정이 같은 날 겹쳐도
            // 나란히 보인다(사용자 요청: 반나절+반대 반나절은 겹쳐질 수 있음).
            const morningItems = cellItems.filter((x) => x.p.timeSlot === 'morning');
            const afternoonItems = cellItems.filter((x) => x.p.timeSlot === 'afternoon');
            const wholeItems = cellItems.filter((x) => x.p.timeSlot !== 'morning' && x.p.timeSlot !== 'afternoon');
            const halfSplit = morningItems.length > 0 && afternoonItems.length > 0 && wholeItems.length === 0;
            // 보조공정 행을 주공정과 맞춰 정렬하기 위한 순서(오전 먼저)와 반분할 여부.
            const orderedMainProcs = [...mainProcs].sort((a, b) => slotRank(a) - slotRank(b) || (a.cellOrder ?? 0) - (b.cellOrder ?? 0));
            const isHalfDaySplit =
              orderedMainProcs.length === 2 &&
              (orderedMainProcs[0].timeSlot === 'morning' || orderedMainProcs[0].timeSlot === 'afternoon') &&
              (orderedMainProcs[1].timeSlot === 'morning' || orderedMainProcs[1].timeSlot === 'afternoon') &&
              orderedMainProcs[0].timeSlot !== orderedMainProcs[1].timeSlot;
            const holiday = isHoliday(d, holidays);
            const isToday = d === today;
            const isMainHover = dragging?.type === 'process' && dragging.rowType === 'main' && hoverCell?.blockId === block.id && hoverCell?.date === d;
            const isSubHover = dragging?.type === 'process' && dragging.rowType === 'sub' && hoverCell?.blockId === block.id && hoverCell?.date === d;
            const baseRow = rowIndex * 4 + 3;
            const cellShade = holiday ? 'bg-red-50' : isToday ? 'bg-indigo-50' : 'bg-white';
            return (
              <div key={mainKey} style={{ display: 'contents' }}>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="main"
                  onPointerEnter={() => updateHoverCell(block.id, d, 'main')}
                  className={['border-b border-l border-zinc-200 overflow-y-auto overflow-x-hidden px-1 py-0.5', cellShade, isMainHover ? 'ring-2 ring-inset ring-indigo-600' : ''].join(' ')}
                  style={{ gridColumn: colIndex + 2, gridRow: baseRow }}
                >
                  {halfSplit ? (
                    // 오전(왼쪽)/오후(오른쪽)로 나눠 배치 — 시작 칩과 지나가는 다일공정 바가
                    // 반대 반나절이면 같은 날 나란히 공존한다.
                    <div className="flex gap-0.5 items-start">
                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                        {morningItems.map((x) => (
                          <div key={x.p.id}>{x.span ? renderSpanBar(x.p) : renderChip(x.p, block.id, d)}</div>
                        ))}
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                        {afternoonItems.map((x) => (
                          <div key={x.p.id}>{x.span ? renderSpanBar(x.p) : renderChip(x.p, block.id, d)}</div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {cellItems.map((x) => (
                        <div key={x.p.id}>{x.span ? renderSpanBar(x.p) : renderChip(x.p, block.id, d)}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="sub"
                  onPointerEnter={() => updateHoverCell(block.id, d, 'sub')}
                  className={['border-b border-l border-zinc-200 overflow-y-auto overflow-x-hidden px-1 py-0.5', cellShade, isSubHover ? 'ring-2 ring-inset ring-indigo-600' : ''].join(' ')}
                  style={{ gridColumn: colIndex + 2, gridRow: baseRow + 1 }}
                >
                  {isHalfDaySplit ? (
                    // 위 주공정 칸이 오전/오후로 반씩 나뉘어 있으면, 보조공정도 각자의
                    // 주공정 바로 아래(같은 절반 폭)에 오도록 똑같이 반으로 나눠 배치한다.
                    <div className="flex gap-0.5 items-start h-full">
                      {orderedMainProcs.map((p) => (
                        <div key={p.id} className="flex-1 min-w-0 flex flex-wrap gap-0.5 content-start">
                          {(attachedSubsByMain.get(p.id) ?? []).map((s) => renderSubBadge(s, block.id, d))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-0.5">
                      {[...attachedSubsByMain.values()].flat().map((s) => renderSubBadge(s, block.id, d))}
                      {orphanSubProcs.map((s) => renderSubBadge(s, block.id, d))}
                    </div>
                  )}
                </div>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="note"
                  className={['border-b-2 border-l border-zinc-200 border-b-zinc-900 px-0.5 py-0.5', cellShade].join(' ')}
                  style={{ gridColumn: colIndex + 2, gridRow: baseRow + 2 }}
                >
                  <div className="flex items-center h-full w-full">
                    <input
                      value={notes[noteKey(block.id, d)] ?? ''}
                      onChange={(e) => onChangeNote(block.id, d, e.target.value)}
                      placeholder="특이사항"
                      className="flex-1 min-w-0 h-full text-[10px] px-1 bg-transparent outline-none placeholder:text-zinc-300"
                      data-testid="note-input"
                    />
                    <button
                      type="button"
                      onClick={() => onOpenNote(block.id, d)}
                      title="전체 보기/편집"
                      data-testid="note-expand"
                      className="shrink-0 text-zinc-300 hover:text-zinc-600 text-[10px] px-0.5"
                    >
                      ⤢
                    </button>
                  </div>
                </div>
              </div>
            );
          }),
        )}

        {/* 변경이력 고스트(이동 전 셀에 연한 회색으로 흔적 표시, 클릭하면 사유) */}
        {visuals.ghosts.map((g, i) => (
          <div
            key={i}
            className="flex flex-col gap-0.5 px-1 py-0.5"
            style={{
              position: 'absolute',
              left: HEADER_W + g.colIndex * CELL_W,
              top: g.top,
              width: CELL_W,
              zIndex: 5,
            }}
          >
            <button
              type="button"
              onClick={() => onShowReason(g.label, g.reason, g.path, g.processId)}
              title={`이동 사유: ${g.reason}`}
              className="text-xs leading-tight text-zinc-400 bg-zinc-100/80 hover:bg-zinc-200 rounded px-1.5 py-0.5 text-left whitespace-nowrap"
            >
              <span className="mr-0.5 text-zinc-500">{seqBadge(g.seq)}</span>
              {g.label}
              {g.oneDayDirection === 'right' && <span className="ml-0.5">▶</span>}
            </button>
          </div>
        ))}

        {/* 2일 이상 이동한 경우의 연한 점선 화살표 (클릭하면 사유) */}
        <svg
          style={{ position: 'absolute', left: 0, top: 0, width: totalWidth, height: totalHeight, zIndex: 5, pointerEvents: 'none' }}
        >
          <defs>
            <marker id="ghost-arrow-head" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#a1a1aa" />
            </marker>
          </defs>
          {visuals.arrows.map((a, i) => (
            <g key={i}>
              <line
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke="transparent"
                strokeWidth={10}
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onClick={() => onShowReason(a.label, a.reason, a.path, a.processId)}
              >
                <title>이동 사유: {a.reason}</title>
              </line>
              <line
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke="#a1a1aa"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                markerEnd="url(#ghost-arrow-head)"
                style={{ pointerEvents: 'none' }}
              />
            </g>
          ))}
        </svg>

        {/* 칩의 ⋯ 버튼 메뉴. 셀에 overflow-y-auto가 걸려 있어 칩 옆에 바로 펼치면 잘릴 수
            있으므로, 버튼을 누른 시점의 화면 좌표를 기준으로 그리드 바깥에 fixed로 그린다. */}
        {chipMenu && (
          <div
            className="fixed z-40 bg-white border border-zinc-200 rounded shadow-lg py-1 text-xs min-w-[120px]"
            style={{ left: chipMenu.x, top: chipMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {chipMenu.category === 'main' && (
              <button
                type="button"
                data-testid="menu-extend"
                className="block w-full text-left px-3 py-1.5 hover:bg-zinc-100"
                onClick={() => {
                  onExtendProcess(chipMenu.processId, 'extend');
                  setChipMenu(null);
                }}
              >
                연장 (+1일) — 오늘 안 끝났을 때
              </button>
            )}
            {chipMenu.category === 'main' && chipMenu.durationDays > 1 && (
              <button
                type="button"
                data-testid="menu-shrink"
                className="block w-full text-left px-3 py-1.5 hover:bg-zinc-100"
                onClick={() => {
                  onExtendProcess(chipMenu.processId, 'shrink');
                  setChipMenu(null);
                }}
              >
                연장 취소 (-1일)
              </button>
            )}
            <button
              type="button"
              data-testid="menu-delete"
              className="block w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
              onClick={() => {
                onDeleteProcess(chipMenu.processId);
                setChipMenu(null);
              }}
            >
              삭제 (이 공정만)
            </button>
            <button
              type="button"
              data-testid="menu-delete-cycle"
              className="block w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 border-t border-zinc-100"
              onClick={() => {
                onDeleteProcessCycle(chipMenu.processId);
                setChipMenu(null);
              }}
            >
              이 세트 전체 삭제 (같이 생성된 공정 전부)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
