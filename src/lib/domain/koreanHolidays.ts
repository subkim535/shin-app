import { ISODate } from '@/lib/domain/dateUtils';
import { HolidayKind } from '@/lib/domain/types';

// 한국 공휴일 표(연도별). 양력 고정 공휴일(신정·삼일절·어린이날·현충일·광복절·개천절·
// 한글날·크리스마스)은 매년 같지만, 설날·추석·부처님오신날은 음력이라 해마다 다르고
// 대체공휴일도 그 해 요일에 따라 달라진다. 그래서 표로 직접 넣어둔다.
//
// ⚠️ 음력(설날·추석·부처님오신날)과 대체휴일 날짜는 해마다 관보로 확정되므로, 자동
//   등록 후 실제 달력과 한 번 맞춰보길 권장한다(특히 2025·2027).
export interface KoreanHoliday {
  date: ISODate;
  name: string;
  kind: HolidayKind; // public_holiday | substitute_holiday
}

export const KOREAN_HOLIDAYS: Record<number, KoreanHoliday[]> = {
  2025: [
    { date: '2025-01-01', name: '신정', kind: 'public_holiday' },
    { date: '2025-01-28', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2025-01-29', name: '설날', kind: 'public_holiday' },
    { date: '2025-01-30', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2025-03-01', name: '삼일절', kind: 'public_holiday' },
    { date: '2025-03-03', name: '삼일절 대체휴일', kind: 'substitute_holiday' },
    { date: '2025-05-05', name: '어린이날·부처님오신날', kind: 'public_holiday' },
    { date: '2025-05-06', name: '대체휴일', kind: 'substitute_holiday' },
    { date: '2025-06-06', name: '현충일', kind: 'public_holiday' },
    { date: '2025-08-15', name: '광복절', kind: 'public_holiday' },
    { date: '2025-10-03', name: '개천절', kind: 'public_holiday' },
    { date: '2025-10-05', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2025-10-06', name: '추석', kind: 'public_holiday' },
    { date: '2025-10-07', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2025-10-08', name: '추석 대체휴일', kind: 'substitute_holiday' },
    { date: '2025-10-09', name: '한글날', kind: 'public_holiday' },
    { date: '2025-12-25', name: '크리스마스', kind: 'public_holiday' },
  ],
  2026: [
    { date: '2026-01-01', name: '신정', kind: 'public_holiday' },
    { date: '2026-02-16', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2026-02-17', name: '설날', kind: 'public_holiday' },
    { date: '2026-02-18', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2026-03-01', name: '삼일절', kind: 'public_holiday' },
    { date: '2026-03-02', name: '삼일절 대체휴일', kind: 'substitute_holiday' },
    { date: '2026-05-05', name: '어린이날', kind: 'public_holiday' },
    { date: '2026-05-24', name: '부처님오신날', kind: 'public_holiday' },
    { date: '2026-05-25', name: '부처님오신날 대체휴일', kind: 'substitute_holiday' },
    { date: '2026-06-06', name: '현충일', kind: 'public_holiday' },
    { date: '2026-08-15', name: '광복절', kind: 'public_holiday' },
    { date: '2026-08-17', name: '광복절 대체휴일', kind: 'substitute_holiday' },
    { date: '2026-09-24', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2026-09-25', name: '추석', kind: 'public_holiday' },
    { date: '2026-09-26', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2026-09-28', name: '추석 대체휴일', kind: 'substitute_holiday' },
    { date: '2026-10-03', name: '개천절', kind: 'public_holiday' },
    { date: '2026-10-05', name: '개천절 대체휴일', kind: 'substitute_holiday' },
    { date: '2026-10-09', name: '한글날', kind: 'public_holiday' },
    { date: '2026-12-25', name: '크리스마스', kind: 'public_holiday' },
  ],
  2027: [
    { date: '2027-01-01', name: '신정', kind: 'public_holiday' },
    { date: '2027-02-06', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2027-02-07', name: '설날', kind: 'public_holiday' },
    { date: '2027-02-08', name: '설날 연휴', kind: 'public_holiday' },
    { date: '2027-02-09', name: '설날 대체휴일', kind: 'substitute_holiday' },
    { date: '2027-03-01', name: '삼일절', kind: 'public_holiday' },
    { date: '2027-05-05', name: '어린이날', kind: 'public_holiday' },
    { date: '2027-05-13', name: '부처님오신날', kind: 'public_holiday' },
    { date: '2027-06-06', name: '현충일', kind: 'public_holiday' },
    { date: '2027-08-15', name: '광복절', kind: 'public_holiday' },
    { date: '2027-08-16', name: '광복절 대체휴일', kind: 'substitute_holiday' },
    { date: '2027-09-14', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2027-09-15', name: '추석', kind: 'public_holiday' },
    { date: '2027-09-16', name: '추석 연휴', kind: 'public_holiday' },
    { date: '2027-10-03', name: '개천절', kind: 'public_holiday' },
    { date: '2027-10-04', name: '개천절 대체휴일', kind: 'substitute_holiday' },
    { date: '2027-10-09', name: '한글날', kind: 'public_holiday' },
    { date: '2027-10-11', name: '한글날 대체휴일', kind: 'substitute_holiday' },
    { date: '2027-12-25', name: '크리스마스', kind: 'public_holiday' },
    { date: '2027-12-27', name: '크리스마스 대체휴일', kind: 'substitute_holiday' },
  ],
};

export const KOREAN_HOLIDAY_YEARS = Object.keys(KOREAN_HOLIDAYS)
  .map(Number)
  .sort((a, b) => a - b);
