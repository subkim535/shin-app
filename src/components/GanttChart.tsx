'use client';

import { useMemo, useRef, useState } from 'react';
import { datesInRange, dayOfWeek, diffDays, formatMonthDay, ISODate, todayISO, weekdayLabelKo } from '@/lib/domain/dateUtils';
import { PROCESS_COLOR, PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { processLabel } from '@/lib/domain/schedule';
import { Block, ChangeRecord, Holiday, ProcessInstance } from '@/lib/domain/types';

const HEADER_W = 96;
const CELL_W = 96;
const REMARK_W = 140;
const HEADER_H = 48;
const ROW_MAIN_H = 52;
const ROW_SUB_H = 28;
const ROW_NOTE_H = 36;
const FALLBACK_COLOR = { bg: 'bg-slate-300', text: 'text-slate-900' };

type RowType = 'main' | 'sub';

interface GanttChartProps {
  blocks: Block[];
  processes: ProcessInstance[];
  holidays: Holiday[];
  changeHistory: ChangeRecord[];
  notes: Record<string, string>;
  onChangeNote: (blockId: string, date: ISODate, text: string) => void;
  onOpenNote: (blockId: string, date: ISODate) => void;
  onShowReason: (label: string, reason: string, path?: string) => void;
  onEditCrew: (processId: string) => void;
  onChangeBlockRemark: (blockId: string, text: string) => void;
  onClickHeaderDate: (date: ISODate) => void;
  viewStartDate: ISODate;
  dayCount: number;
  selectedProcessId: string | null;
  onSelectProcess: (id: string) => void;
  onDropProcess: (processId: string, blockId: string, date: ISODate) => void;
  onDropHeader: (fromDate: ISODate, toDate: ISODate) => void;
  onReorderCellOrder: (processId: string, direction: 'up' | 'down') => void;
}

type DragState =
  | { type: 'process'; id: string; rowType: RowType; originBlockId: string; originDate: ISODate }
  | { type: 'header'; date: ISODate };

function isHoliday(date: ISODate, holidays: Holiday[]): boolean {
  return dayOfWeek(date) === 0 || holidays.some((h) => h.date === date);
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
  onChangeBlockRemark,
  onClickHeaderDate,
  viewStartDate,
  dayCount,
  selectedProcessId,
  onSelectProcess,
  onDropProcess,
  onDropHeader,
  onReorderCellOrder,
}: GanttChartProps) {
  const dates = useMemo(() => datesInRange(viewStartDate, dayCount), [viewStartDate, dayCount]);
  const dateIndex = useMemo(() => new Map(dates.map((d, i) => [d, i])), [dates]);
  const blockIndex = useMemo(() => new Map(blocks.map((b, i) => [b.id, i])), [blocks]);
  const today = todayISO();

  const [dragging, setDragging] = useState<DragState | null>(null);
  const [hoverCell, setHoverCell] = useState<{ blockId: string; date: ISODate } | null>(null);
  const [hoverHeaderDate, setHoverHeaderDate] = useState<ISODate | null>(null);

  // pointerup은 React state 커밋을 기다리지 않고 같은 제스처 안에서 즉시 window에
  // 리스너를 붙였다 떼는 ref 기반 방식으로 처리한다. state 업데이트 타이밍에 의존하면
  // 빠르게 이어지는 포인터 이벤트에서 드롭을 놓칠 수 있다.
  const dragRef = useRef<DragState | null>(null);
  const hoverCellRef = useRef<{ blockId: string; date: ISODate } | null>(null);
  const hoverHeaderDateRef = useRef<ISODate | null>(null);

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
    }
    dragRef.current = null;
    hoverCellRef.current = null;
    hoverHeaderDateRef.current = null;
    setDragging(null);
    setHoverCell(null);
    setHoverHeaderDate(null);
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

  // 화살표는 셀 전체 높이의 중앙이 아니라, 맨 위 첫 줄 칩 텍스트 높이에 맞춰 그린다.
  // 주요공정 행은 아래쪽에 여러 칩이 더 쌓일 수 있는 여유 공간이 있어서, 셀 중앙에 그리면
  // 칩 밑 빈 공간을 지나가 "공정 아래에 화살표가 있다"처럼 보인다.
  const CHIP_LINE_CENTER = 13;
  const LANE_STEP = 20; // 같은 칸에 고스트가 여러 개 쌓일 때 한 줄씩 내려가는 간격(고스트 한 줄 높이 이상이어야 안 겹친다)
  const GHOST_BOX_H = 20; // 고스트 한 줄이 실제로 차지하는 대략적인 높이
  const ARROW_LANE_STEP = 8; // 같은 행에서 화살표끼리 겹칠 때 갈라놓는 간격

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
    const ghosts: {
      date: ISODate;
      label: string;
      reason: string;
      path: string;
      colIndex: number;
      rowIndex: number;
      rowType: RowType;
      pushDown: boolean;
      oneDayDirection?: 'left' | 'right';
      seq: number;
      lane: number;
    }[] = [];
    const arrows: {
      originCol: number;
      destCol: number;
      rowIndex: number;
      rowType: RowType;
      isBackward: boolean;
      lane: number;
      label: string;
      reason: string;
      path: string;
    }[] = [];
    const arrowLaneEnds = new Map<string, number[]>();
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
        const seq = recent.length - i; // 최신이 1번
        const originCol = dateIndex.get(record.previousDate);
        const destCol = dateIndex.get(record.newDate);
        const isBackward = magnitude < 0;
        const isOneDay = Math.abs(magnitude) === 1;
        if (originCol !== undefined) {
          // 그 칸(원래 날짜)에 실제 공정이 남아있을 때만 겹쳐 보이므로, 그럴 때만 고스트를
          // 행 아래쪽으로 내린다. 방향(정방향/역방향)과는 무관하다 — 같은 칸을 공유하는
          // 고스트는 항상 같은 칸 내용을 보고 판단해야, ①②③ 순서로 정렬했을 때 실제로도
          // 위에서 아래로 그 순서대로 보인다(방향이 섞이면 순서와 안 맞게 밀릴 수 있었다).
          const originHasRealContent = (rowType === 'main' ? byBlockDateMain : byBlockDateSub).has(
            `${proc.blockId}__${record.previousDate}`,
          );
          const pushDown = originHasRealContent;
          // 하루 이동은 점선 화살표 대신 라벨 글자 앞/뒤에 작은 방향 표시를 붙인다
          // (SVG로 따로 그리면 라벨 텍스트 폭을 몰라서 겹치기 쉽다 — 같은 텍스트 줄에 넣으면
          // 브라우저가 알아서 겹치지 않게 배치해준다).
          ghosts.push({
            date: record.previousDate,
            label,
            reason: record.reason,
            path,
            colIndex: originCol,
            rowIndex,
            rowType,
            pushDown,
            oneDayDirection: isOneDay ? (isBackward ? 'left' : 'right') : undefined,
            seq,
            lane: 0, // 아래에서 같은 칸끼리 seq 오름차순(①이 위)으로 다시 배정한다
          });
        }
        if (originCol !== undefined && destCol !== undefined && !isOneDay) {
          // 화살표끼리 날짜 구간이 실제로 겹칠 때만 레인을 갈라서, 안 겹치는 화살표까지
          // 괜히 어긋나게 그리지 않는다. 방향(위/아래로 향하는 방향)이 다르면 애초에 다른
          // 높이에 그려지므로 방향별로 따로 레인을 관리한다.
          const laneKey = `${rowIndex}_${rowType}_${isBackward}`;
          const ends = arrowLaneEnds.get(laneKey) ?? [];
          arrowLaneEnds.set(laneKey, ends);
          const lane = assignLane(ends, Math.min(originCol, destCol), Math.max(originCol, destCol));
          arrows.push({ originCol, destCol, rowIndex, rowType, isBackward, lane, label, reason: record.reason, path });
        }
      });
    }
    // 같은 칸에 고스트가 여러 개 겹치면 seq가 작을수록(=최근일수록) 위쪽에 오도록 정렬한다.
    const cellGroups = new Map<string, typeof ghosts>();
    for (const g of ghosts) {
      const key = `${g.rowIndex}_${g.rowType}_${g.colIndex}`;
      if (!cellGroups.has(key)) cellGroups.set(key, []);
      cellGroups.get(key)!.push(g);
    }
    for (const group of cellGroups.values()) {
      group.sort((a, b) => a.seq - b.seq);
      group.forEach((g, lane) => {
        g.lane = lane;
      });
    }
    return { ghosts, arrows };
  }, [movesByProcessId, processById, blockIndex, dateIndex, byBlockDateMain, byBlockDateSub]);

  // 2단계: 한 칸에 고스트/화살표가 여러 개 쌓이면 그만큼 그 행(주공정/보조공정 행 각각)의 높이를 늘린다.
  const rowMetrics = useMemo(() => {
    const extra = new Map<string, number>(); // key: `${rowIndex}_${rowType}` -> 기본 높이를 넘어서는 만큼(px)
    for (const g of rawVisuals.ghosts) {
      const base = g.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const topOffset = (g.pushDown ? base / 2 : 0) + g.lane * LANE_STEP;
      const neededBottom = topOffset + GHOST_BOX_H;
      const key = `${g.rowIndex}_${g.rowType}`;
      extra.set(key, Math.max(extra.get(key) ?? 0, neededBottom - base));
    }
    for (const a of rawVisuals.arrows) {
      const base = a.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const anchor = a.isBackward ? base - 6 : CHIP_LINE_CENTER;
      const neededBottom = anchor + a.lane * ARROW_LANE_STEP + 6;
      const key = `${a.rowIndex}_${a.rowType}`;
      extra.set(key, Math.max(extra.get(key) ?? 0, neededBottom - base));
    }
    const mainH: number[] = [];
    const subH: number[] = [];
    const blockTop: number[] = [];
    let cursor = HEADER_H;
    for (let i = 0; i < blocks.length; i++) {
      blockTop.push(cursor);
      const mh = ROW_MAIN_H + (extra.get(`${i}_main`) ?? 0);
      const sh = ROW_SUB_H + (extra.get(`${i}_sub`) ?? 0);
      mainH.push(mh);
      subH.push(sh);
      cursor += mh + sh + ROW_NOTE_H;
    }
    return { mainH, subH, blockTop, totalHeight: cursor };
  }, [rawVisuals, blocks.length]);

  function rowTopFor(rowIndex: number, rowType: RowType): number {
    // rawVisuals/rowMetrics는 같은 blocks 값에서 계산되지만, 다른 사용자가 동에서 실시간으로
    // 동을 추가/삭제하는 순간과 겹치면 한 렌더 동안 rowIndex가 잠깐 범위를 벗어날 수 있다.
    // 그 경우 NaN 스타일이 나가지 않도록 0으로 안전하게 대체한다(다음 렌더에서 바로 정상화된다).
    const top = rowMetrics.blockTop[rowIndex] ?? 0;
    return top + (rowType === 'sub' ? (rowMetrics.mainH[rowIndex] ?? ROW_MAIN_H) : 0);
  }
  function arrowYFor(rowIndex: number, rowType: RowType): number {
    return rowTopFor(rowIndex, rowType) + CHIP_LINE_CENTER;
  }

  // 3단계: 이제 행 높이가 확정됐으니 실제 픽셀 좌표를 계산한다.
  const visuals = useMemo(() => {
    const ghosts = rawVisuals.ghosts.map((g) => {
      const base = g.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const topOffset = (g.pushDown ? base / 2 : 0) + g.lane * LANE_STEP;
      return { ...g, top: rowTopFor(g.rowIndex, g.rowType) + topOffset };
    });
    const arrows = rawVisuals.arrows.map((a) => {
      const originLeft = HEADER_W + a.originCol * CELL_W;
      const destLeft = HEADER_W + a.destCol * CELL_W;
      // 라벨과 겹치지 않도록, 두 셀의 텍스트를 지나지 않고 그 "사이 빈 공간"만 지나가게 그린다.
      // (1일 이동은 애초에 arrows에 안 들어오고 고스트 라벨 옆 ◀/▶ 표시로 대신한다.)
      const [x1, x2] = a.destCol > a.originCol ? [originLeft + CELL_W, destLeft] : [originLeft, destLeft + CELL_W];
      // 앞당겨진(왼쪽으로 향하는) 이동은 칩 텍스트 줄과 같은 높이에 그리면 주공정 행과
      // 겹쳐 보인다. 이 경우만 행 아래쪽 여백으로 내려서 그린다. 행이 다른 이유로(고스트
      // 누적 등) 늘어나도 화살표 위치가 같이 딸려 내려가지 않도록, 늘어나기 전 기본 높이를
      // 기준으로 삼는다.
      const base = a.rowType === 'main' ? ROW_MAIN_H : ROW_SUB_H;
      const baseY = a.isBackward ? rowTopFor(a.rowIndex, a.rowType) + base - 6 : arrowYFor(a.rowIndex, a.rowType);
      const y = baseY + a.lane * ARROW_LANE_STEP; // 같은 행에서 겹치는 화살표끼리 살짝 어긋나게
      return { x1, y1: y, x2, y2: y, label: a.label, reason: a.reason, path: a.path };
    });
    return { ghosts, arrows };
  }, [rawVisuals, rowMetrics]);

  const totalWidth = HEADER_W + dates.length * CELL_W + REMARK_W;
  const totalHeight = rowMetrics.totalHeight;
  const gridTemplateRows = `${HEADER_H}px ` + blocks.map((_, i) => `${rowMetrics.mainH[i]}px ${rowMetrics.subH[i]}px ${ROW_NOTE_H}px`).join(' ');

  function renderChip(p: ProcessInstance, rowType: RowType, blockId: string, date: ISODate) {
    const def = PROCESS_TYPE_MAP[p.typeCode];
    const category = def?.category ?? 'main';
    const selected = p.id === selectedProcessId;
    const color = category === 'main' ? PROCESS_COLOR[p.typeCode] ?? FALLBACK_COLOR : undefined;
    const isDragSource = dragging?.type === 'process' && dragging.id === p.id;
    const label = processLabel(p);
    return (
      <div key={p.id} className="flex items-center gap-0.5 w-full">
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
            startDragProcess(p.id, rowType, blockId, date);
          }}
          data-process-id={p.id}
          title={p.crew ? `${p.crew.team} · ${p.crew.headcount}명` : undefined}
          className={[
            'text-left rounded px-1.5 py-0.5 text-xs leading-tight relative flex-1 min-w-0',
            category === 'main' ? `font-semibold ${color?.bg ?? ''} ${color?.text ?? ''}` : 'text-zinc-600 bg-zinc-50',
            'cursor-grab active:cursor-grabbing',
            selected ? 'ring-2 ring-indigo-600' : '',
            isDragSource ? 'opacity-50' : '',
          ].join(' ')}
        >
          {def?.showFloorLabel && p.floorLabel ? `${p.floorLabel} ` : ''}
          {label}
          {p.conflictSeq ? <sup className="ml-0.5">{p.conflictSeq}</sup> : null}
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
        {category === 'main' && (
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
        )}
      </div>
    );
  }

  return (
    <div className="overflow-auto border border-zinc-200 rounded-md" data-testid="gantt-chart">
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

        {/* 행 헤더 (동 이름, 3행 전체에 걸쳐 표시) */}
        {blocks.map((block, rowIndex) => (
          <div
            key={`label-${block.id}`}
            className="sticky left-0 z-20 bg-white border-b border-r border-zinc-200 flex flex-col justify-center px-2 font-medium whitespace-nowrap"
            style={{ gridColumn: 1, gridRow: `${rowIndex * 3 + 2} / span 3` }}
          >
            <span>{block.name}</span>
            {block.info && <span className="text-[10px] text-zinc-400 font-normal">{block.info}</span>}
          </div>
        ))}

        {/* 비고 열 (동 단위, 날짜와 무관, 오른쪽 고정) */}
        {blocks.map((block, rowIndex) => (
          <div
            key={`remark-${block.id}`}
            className="sticky right-0 z-10 bg-zinc-50 border-b border-l border-zinc-200 px-1 py-1"
            style={{ gridColumn: dates.length + 2, gridRow: `${rowIndex * 3 + 2} / span 3` }}
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

        {/* 본문: 동마다 주요공정 / 보조공정 / 특이사항 3행 */}
        {blocks.map((block, rowIndex) =>
          dates.map((d, colIndex) => {
            const mainKey = `${block.id}__${d}`;
            const mainProcs = byBlockDateMain.get(mainKey) ?? [];
            const subProcs = byBlockDateSub.get(mainKey) ?? [];
            const holiday = isHoliday(d, holidays);
            const isToday = d === today;
            const isMainHover = dragging?.type === 'process' && dragging.rowType === 'main' && hoverCell?.blockId === block.id && hoverCell?.date === d;
            const isSubHover = dragging?.type === 'process' && dragging.rowType === 'sub' && hoverCell?.blockId === block.id && hoverCell?.date === d;
            const baseRow = rowIndex * 3 + 2;
            const cellShade = holiday ? 'bg-red-50' : isToday ? 'bg-indigo-50' : 'bg-white';
            return (
              <div key={mainKey} style={{ display: 'contents' }}>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="main"
                  onPointerEnter={() => updateHoverCell(block.id, d, 'main')}
                  className={['border-b border-l border-zinc-200 overflow-y-auto px-1 py-0.5', cellShade, isMainHover ? 'ring-2 ring-inset ring-indigo-600' : ''].join(' ')}
                  style={{ gridColumn: colIndex + 2, gridRow: baseRow }}
                >
                  <div className="flex flex-col gap-0.5">{mainProcs.map((p) => renderChip(p, 'main', block.id, d))}</div>
                </div>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="sub"
                  onPointerEnter={() => updateHoverCell(block.id, d, 'sub')}
                  className={['border-b border-l border-zinc-200 overflow-y-auto px-1 py-0.5', cellShade, isSubHover ? 'ring-2 ring-inset ring-indigo-600' : ''].join(' ')}
                  style={{ gridColumn: colIndex + 2, gridRow: baseRow + 1 }}
                >
                  <div className="flex flex-col gap-0.5">{subProcs.map((p) => renderChip(p, 'sub', block.id, d))}</div>
                </div>
                <div
                  data-block={block.name}
                  data-date={d}
                  data-row="note"
                  className={['border-b border-l border-zinc-200 px-0.5 py-0.5', cellShade].join(' ')}
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
              onClick={() => onShowReason(g.label, g.reason, g.path)}
              title={`이동 사유: ${g.reason}`}
              className="text-xs leading-tight text-zinc-400 bg-zinc-100/80 hover:bg-zinc-200 rounded px-1.5 py-0.5 text-left whitespace-nowrap"
            >
              <span className="mr-0.5 text-zinc-500">{seqBadge(g.seq)}</span>
              {g.oneDayDirection === 'left' && <span className="mr-0.5">◀</span>}
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
                onClick={() => onShowReason(a.label, a.reason, a.path)}
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
      </div>
    </div>
  );
}
