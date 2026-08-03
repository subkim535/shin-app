import type { NextConfig } from "next";

// Vercel 대시보드의 환경변수 UI가 이 프로젝트에서 편집이 안 되는 문제가 있어서
// (Environments 드롭다운이 비활성화됨), 배포 환경별로 다른 Supabase 프로젝트를 쓰는
// 걸 여기서 대신 결정한다. VERCEL_ENV는 Vercel이 빌드마다 자동으로 채워주는 값이라
// 별도 설정 없이도 항상 정확하다 — "production"이면 main(실제 서비스), 그 외(preview,
// 로컬 npm run dev 등)면 전부 별도 dev용 Supabase를 쓴다. (대시보드 값이 비어도
// 빌드가 깨지지 않도록, main도 이 방식으로 프로덕션 값을 직접 채워서 고친 적이 있다 —
// 커밋 846aa29.)
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
  // 배포 후에도 "고정 주소"가 옛 화면을 계속 보여주는 문제 대응: HTML 문서는 캐시하지
  // 않고 매 요청마다 새로 받아오게 한다. (해시가 붙은 /_next/static 자산은 그대로
  // 영구 캐시되므로 성능 영향은 없다.) 새 배포가 나오면 새로고침만으로 최신이 뜬다.
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
