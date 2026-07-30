import type { NextConfig } from "next";

// Vercel 대시보드의 환경변수 UI가 이 프로젝트에서 편집이 안 되는 문제가 있어서
// (Environments 드롭다운이 비활성화됨), 배포 환경별로 다른 Supabase 프로젝트를 쓰는
// 걸 여기서 대신 결정한다. VERCEL_ENV는 Vercel이 빌드마다 자동으로 채워주는 값이라
// 별도 설정 없이도 항상 정확하다 — "production"이면 main(실제 서비스), 그 외(preview,
// 로컬 npm run dev 등)면 전부 별도 dev용 Supabase를 쓴다.
const isProduction = process.env.VERCEL_ENV === "production";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SUPABASE_URL: isProduction
      ? "https://twhnnebqnwnjmfkgsogn.supabase.co"
      : "https://ohnnktqylwhmsnxklhhb.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: isProduction
      ? "sb_publishable_WyVw0f8Gq5JpWu7kDLwUIA_AFNMb_ZU"
      : "sb_publishable_lulBXkkZyRgjwEmTWJsAHA_MGqLvHlb",
  },
};

export default nextConfig;
