export type ISODate = string; // 'YYYY-MM-DD'

export function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: ISODate, days: number): ISODate {
  const d = parseISODate(s);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function diffDays(a: ISODate, b: ISODate): number {
  const da = parseISODate(a).getTime();
  const db = parseISODate(b).getTime();
  return Math.round((db - da) / 86400000);
}

export function dayOfWeek(s: ISODate): number {
  return parseISODate(s).getDay(); // 0=Sun ... 6=Sat
}

export function mondayOfWeek(s: ISODate): ISODate {
  const dow = dayOfWeek(s);
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(s, offset);
}

export function todayISO(): ISODate {
  return toISODate(new Date());
}

export function addMonths(s: ISODate, months: number): ISODate {
  const d = parseISODate(s);
  const next = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  return toISODate(next);
}

export function endOfMonth(s: ISODate): ISODate {
  const d = parseISODate(s);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); // 0일 = 이번 달 마지막 날
  return toISODate(end);
}

export function datesInRange(start: ISODate, count: number): ISODate[] {
  const out: ISODate[] = [];
  let cur = start;
  for (let i = 0; i < count; i += 1) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function formatMonthDay(s: ISODate): string {
  const d = parseISODate(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export function weekdayLabelKo(s: ISODate): string {
  return WEEKDAY_KO[dayOfWeek(s)];
}
