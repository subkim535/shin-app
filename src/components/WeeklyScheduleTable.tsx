'use client';

import { Fragment } from 'react';
import { formatMonthDay, weekdayLabelKo } from '@/lib/domain/dateUtils';
import { Holiday } from '@/lib/domain/types';
import { argbToCss, HEADER_FILL, HOLIDAY_FILL, BLOCK_NAME_FILL, LEGEND_ITEMS, isWeeklyHoliday, WeeklyScheduleData } from '@/lib/export/weeklyScheduleData';

interface WeeklyScheduleTableProps {
  siteName: string;
  scopeLabel: string;
  data: WeeklyScheduleData;
  holidays: Holiday[];
}

// 화면에는 안 보이고 인쇄(PDF 저장)할 때만 나타나는 표 — 엑셀 내보내기와 같은 데이터로
// 같은 배색을 재현한다. print-area 클래스는 globals.css에서 인쇄 시 이 영역만 남기고
// 나머지 화면을 숨긴다.
export default function WeeklyScheduleTable({ siteName, scopeLabel, data, holidays }: WeeklyScheduleTableProps) {
  return (
    <div className="hidden print:block print-area bg-white p-4 text-black">
      <h2 className="text-sm font-bold mb-2">
        {siteName} 주간공정표 — {scopeLabel}
      </h2>
      <table className="border-collapse w-full text-[8px]">
        <thead>
          <tr>
            <th rowSpan={2} className="border border-zinc-400 px-1 py-0.5" style={{ background: argbToCss(HEADER_FILL) }}>
              구분
            </th>
            {data.dates.map((d) => (
              <th
                key={d}
                colSpan={2}
                className="border border-zinc-400 px-1 py-0.5"
                style={{ background: argbToCss(isWeeklyHoliday(d, holidays) ? HOLIDAY_FILL : HEADER_FILL) }}
              >
                {formatMonthDay(d)} ({weekdayLabelKo(d)})
              </th>
            ))}
          </tr>
          <tr>
            {data.dates.map((d) => (
              <Fragment key={d}>
                <th
                  key={`${d}-am`}
                  className="border border-zinc-400 px-1 py-0.5"
                  style={{ background: argbToCss(isWeeklyHoliday(d, holidays) ? HOLIDAY_FILL : HEADER_FILL) }}
                >
                  오전
                </th>
                <th
                  key={`${d}-pm`}
                  className="border border-zinc-400 px-1 py-0.5"
                  style={{ background: argbToCss(isWeeklyHoliday(d, holidays) ? HOLIDAY_FILL : HEADER_FILL) }}
                >
                  오후
                </th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.blockId}>
              <td className="border border-zinc-400 px-1 py-0.5 font-semibold text-center" style={{ background: argbToCss(BLOCK_NAME_FILL) }}>
                {row.blockName}
                {row.blockInfo && (
                  <>
                    <br />
                    <span className="font-normal">{row.blockInfo}</span>
                  </>
                )}
              </td>
              {row.cells.map((cell) =>
                cell.merged ? (
                  <td
                    key={cell.date}
                    colSpan={2}
                    className="border border-zinc-400 px-1 py-0.5 text-center whitespace-pre-line"
                    style={cell.am.fillArgb ? { background: argbToCss(cell.am.fillArgb) } : undefined}
                  >
                    {cell.am.text}
                  </td>
                ) : (
                  <Fragment key={cell.date}>
                    <td
                      key={`${cell.date}-am`}
                      className="border border-zinc-400 px-1 py-0.5 text-center whitespace-pre-line"
                      style={cell.am.fillArgb ? { background: argbToCss(cell.am.fillArgb) } : undefined}
                    >
                      {cell.am.text}
                    </td>
                    <td
                      key={`${cell.date}-pm`}
                      className="border border-zinc-400 px-1 py-0.5 text-center whitespace-pre-line"
                      style={cell.pm.fillArgb ? { background: argbToCss(cell.pm.fillArgb) } : undefined}
                    >
                      {cell.pm.text}
                    </td>
                  </Fragment>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap gap-3 text-[9px]">
        {LEGEND_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 border border-zinc-400" style={{ background: argbToCss(item.argb) }} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
