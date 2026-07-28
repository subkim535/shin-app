import { supabase } from './client';
import { AppState } from '@/lib/domain/types';

export const SITE_KEY = 'default';

// Postgres의 jsonb는 객체 key 순서를 보존하지 않는다. 그래서 저장 전 로컬 상태를
// JSON.stringify한 값과, DB에서 되돌아온(realtime echo 포함) 값을 그냥 JSON.stringify로
// 비교하면 내용이 같아도 문자열이 달라져서 "내가 방금 저장한 에코"를 놓치게 된다.
// key를 재귀적으로 정렬한 뒤 비교해야 안정적으로 같은 문자열이 나온다.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export interface LoadedState {
  state: AppState;
  updatedAt: string;
}

export async function loadState(siteKey: string): Promise<LoadedState | null> {
  const { data, error } = await supabase
    .from('schedule_state')
    .select('data, updated_at')
    .eq('site_key', siteKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { state: data.data as AppState, updatedAt: data.updated_at as string };
}

/** 저장에 사용한 updated_at을 반환한다 — 실시간으로 되돌아오는 이벤트가 이보다 오래됐으면 무시하기 위함. */
export async function saveState(siteKey: string, state: AppState): Promise<string> {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from('schedule_state')
    .upsert({ site_key: siteKey, data: state, updated_at: updatedAt }, { onConflict: 'site_key' });
  if (error) throw error;
  return updatedAt;
}

export function subscribeState(
  siteKey: string,
  onChange: (state: AppState, updatedAt: string) => void,
): () => void {
  const channel = supabase
    .channel(`schedule_state:${siteKey}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'schedule_state', filter: `site_key=eq.${siteKey}` },
      (payload) => {
        const next = payload.new as { data: AppState; updated_at: string } | undefined;
        if (next?.data) onChange(next.data, next.updated_at);
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
