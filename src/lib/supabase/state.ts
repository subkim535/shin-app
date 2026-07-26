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

export async function loadState(siteKey: string): Promise<AppState | null> {
  const { data, error } = await supabase.from('schedule_state').select('data').eq('site_key', siteKey).maybeSingle();
  if (error) throw error;
  return (data?.data as AppState | undefined) ?? null;
}

export async function saveState(siteKey: string, state: AppState): Promise<void> {
  const { error } = await supabase
    .from('schedule_state')
    .upsert({ site_key: siteKey, data: state, updated_at: new Date().toISOString() }, { onConflict: 'site_key' });
  if (error) throw error;
}

export function subscribeState(siteKey: string, onChange: (state: AppState) => void): () => void {
  const channel = supabase
    .channel(`schedule_state:${siteKey}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'schedule_state', filter: `site_key=eq.${siteKey}` },
      (payload) => {
        const next = payload.new as { data: AppState } | undefined;
        if (next?.data) onChange(next.data);
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
