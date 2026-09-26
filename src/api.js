// Supabase 연결. 모든 읽기·쓰기는 supabase/schema.sql의 함수(RPC)로만 한다.
import { createClient } from '@supabase/supabase-js';

// Supabase 설정 화면의 Data API 주소는 끝에 /rest/v1/ 이 붙어 있어서, 그대로 넣어도 되게 떼어 낸다
const url = (import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const configured = Boolean(url && key);
const sb = configured ? createClient(url, key, { auth: { persistSession: false } }) : null;

// 서버 함수를 부른다. 실패하면 서버가 보낸 한국어 메시지를 담은 Error를 던진다.
export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    const e = new Error(error.message || '서버와 연결하지 못했어요');
    e.code = error.code;
    throw e;
  }
  return data;
}

// 누군가 데이터를 바꾸면 app_version이 갱신되고, 그 알림을 받아 cb를 부른다.
export function onChange(cb) {
  if (!sb) return;
  sb.channel('jabong')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_version' }, cb)
    .subscribe();
}

const SESSION_KEY = 'jabong-session';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function setSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // 저장소를 못 쓰는 브라우저에서는 새로고침하면 로그아웃된다
  }
}
