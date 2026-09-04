import { useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/auth/useAuth";
import { strings } from "../lib/strings";

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { signIn, signUp } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (isLogin) {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      router.push("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : strings.auth.genericError;
      setError(message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #faf9f7 0%, #eef2ff 40%, #f5f3ff 70%, #fdf4ff 100%)",
      }}
    >
      {/* Decorative background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-indigo-200/30 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-violet-200/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-amber-100/20 blur-3xl" />
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Branding */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 mb-5 shadow-lg shadow-indigo-200">
            <span className="text-4xl" role="img" aria-label="heart">
              &#x2764;&#xFE0F;
            </span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight" style={{ color: "var(--color-text-primary)" }}>
            {strings.common.appName}
          </h1>
          <p className="mt-2 text-base" style={{ color: "var(--color-text-secondary)" }}>
            {strings.common.tagline}
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-3xl p-8 shadow-xl border"
          style={{
            background: "var(--color-surface-overlay)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderColor: "var(--color-border)",
            boxShadow: "0 20px 60px -12px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.5) inset",
          }}
        >
          <h2 className="text-2xl font-semibold mb-1" style={{ color: "var(--color-text-primary)" }}>
            {isLogin ? strings.auth.welcomeBack : strings.auth.createAccount}
          </h2>
          <p className="text-sm mb-8" style={{ color: "var(--color-text-secondary)" }}>
            {isLogin ? strings.auth.signInSubtitle : strings.auth.createAccountSubtitle}
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium mb-2"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {strings.auth.emailLabel}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={strings.auth.emailPlaceholder}
                className="w-full px-4 py-3.5 text-sm rounded-2xl border transition-all duration-200 placeholder:text-stone-400"
                style={{
                  background: "var(--color-surface-raised)",
                  color: "var(--color-text-primary)",
                  borderColor: "var(--color-border)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-brand)";
                  e.currentTarget.style.boxShadow = "0 0 0 3px var(--color-brand-muted)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium mb-2"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {strings.auth.passwordLabel}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete={isLogin ? "current-password webauthn" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={strings.auth.passwordPlaceholder}
                className="w-full px-4 py-3.5 text-sm rounded-2xl border transition-all duration-200 placeholder:text-stone-400"
                style={{
                  background: "var(--color-surface-raised)",
                  color: "var(--color-text-primary)",
                  borderColor: "var(--color-border)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-brand)";
                  e.currentTarget.style.boxShadow = "0 0 0 3px var(--color-brand-muted)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
            </div>

            {error && (
              <div
                className="text-sm rounded-2xl px-4 py-3 border"
                style={{ color: "var(--color-danger)", background: "var(--color-danger-light)", borderColor: "rgba(220, 38, 38, 0.15)" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-3.5 rounded-2xl font-semibold text-sm text-white shadow-lg shadow-indigo-200/50 hover:shadow-indigo-300/50 active:scale-[0.98]"
              style={{
                background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)",
              }}
            >
              {isLogin ? strings.auth.signInButton : strings.auth.createAccountButton}
            </button>
          </form>

          <div className="mt-8 text-center">
            <button
              onClick={() => setIsLogin(!isLogin)}
              className="text-sm font-medium"
              style={{ color: "var(--color-brand)" }}
            >
              {isLogin ? strings.auth.noAccount : strings.auth.alreadyHaveAccount}
            </button>
          </div>
        </div>

        <p className="text-center text-xs mt-8" style={{ color: "var(--color-text-muted)" }}>
          {strings.common.privacyNote}
        </p>
      </div>
    </div>
  );
}
