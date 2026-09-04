import type { NextConfig } from "next";

const securityHeaders = [
  // Prevents content-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Basic clickjacking protection. A full frame-ancestors CSP would be
  // stronger but would prevent embedding; for a grief-support app there
  // is no reason to be framed.
  { key: "X-Frame-Options", value: "DENY" },
  // Keeps user cookies/intent private across same-site navigations.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Only allow same-origin connections (we already connect to Firebase
  // at runtime; script/style/img/connect all stay on our origin).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js hydration + Tailwind set inline styles; allow inline styles.
      "style-src 'self' 'unsafe-inline'",
      // The Firebase JS SDK connects to Google's REST endpoints at runtime.
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://*.firebaseapp.com",
      "img-src 'self' data:",
      "font-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      // Next injects inline scripts for hydration and data preloading.
      "script-src 'self' 'unsafe-inline'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
