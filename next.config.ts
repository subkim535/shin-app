import type { NextConfig } from "next";

// Vercel 대시보드의 Environment Variables 편집 화면이 이 프로젝트에서 고장나 있어서
// (Environments 드롭다운이 편집/추가 둘 다 안 열림), 그걸 손보다가 결국 프로덕션용
// NEXT_PUBLIC_SUPABASE_* 값이 아예 비어버려서 빌드가 "supabaseUrl is required"로
// 실패하는 사고가 났다. 대시보드에 더 이상 의존하지 않도록 여기서 직접 값을 채운다.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://twhnnebqnwnjmfkgsogn.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_WyVw0f8Gq5JpWu7kDLwUIA_AFNMb_ZU",
  },
};

export default nextConfig;
