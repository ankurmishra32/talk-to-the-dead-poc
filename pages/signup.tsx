import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/auth/useAuth";
import { createUserProfile, getUserProfile } from "../lib/users";
import { createLogger } from "../lib/logger";
import { strings } from "../lib/strings";

const logger = createLogger("Signup");

const STEP_LABELS = [strings.auth.signup.stepAccount, strings.auth.signup.stepProfile];

const inputClass =
  "w-full px-4 py-3.5 text-sm rounded-2xl border transition-all duration-200 placeholder:text-stone-400";
const inputStyle = {
  background: "var(--color-surface-raised)",
  color: "var(--color-text-primary)",
  borderColor: "var(--color-border)",
};
const focusHandlers = {
  onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--color-brand)";
    e.currentTarget.style.boxShadow = "0 0 0 3px var(--color-brand-muted)";
  },
  onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--color-border)";
    e.currentTarget.style.boxShadow = "none";
  },
};

export default function SignupPage() {
  const router = useRouter();
  const { user, loading: authLoading, signUp, signOut } = useAuth();

  // The step is derived from auth state rather than stored: once a Firebase
  // user exists, the account step is done. This covers both a fresh signup
  // (signUp() flips `user` via onAuthChange) and a signed-in user without a
  // profile who was redirected here from /dashboard to finish onboarding.
  const currentStep = user ? 1 : 0;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [onboardingHint, setOnboardingHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return;
    getUserProfile(user.uid)
      .then((profile) => {
        if (profile) router.replace("/dashboard");
      })
      .catch((err) => {
        // Stay on the profile step; saving it will surface a friendly error.
        logger.error("Profile lookup failed", err);
      });
  }, [user, authLoading, router]);

  // The account already exists at the profile step, so "Back" can't
  // re-run account creation. Signing out is the way to switch accounts.
  const handleUseDifferentAccount = async () => {
    setError(null);
    try {
      await signOut();
    } catch (err) {
      logger.error("Sign out failed", err);
      setError(strings.auth.genericError);
    }
  };

  const handleAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(strings.auth.signup.passwordsMismatch);
      return;
    }
    if (password.length < 8) {
      setError(strings.auth.passwordTooShort);
      return;
    }

    setLoading(true);
    try {
      // onAuthChange sets `user`, which advances to the profile step.
      await signUp(email, password);
    } catch (err) {
      logger.error("Sign up failed", err);
      setError(strings.auth.genericError);
    } finally {
      setLoading(false);
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const name = displayName.trim();
    if (!name) return;

    setLoading(true);
    setError(null);
    try {
      await createUserProfile({
        uid: user.uid,
        email: user.email || email,
        displayName: name,
        phone: phone.trim() || undefined,
        onboardingHint: onboardingHint.trim() || undefined,
      });
      router.push("/dashboard");
    } catch (err) {
      logger.error("Profile save failed", err);
      setError(strings.auth.genericError);
    } finally {
      setLoading(false);
    }
  };

  // Until auth state is known, don't flash the account step at a user who is
  // already signed in (they belong on the profile step).
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--color-surface)" }}>
        <p style={{ color: "var(--color-text-muted)" }}>{strings.dashboard.loading}</p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #faf9f7 0%, #eef2ff 40%, #f5f3ff 70%, #fdf4ff 100%)",
      }}
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-indigo-200/30 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-violet-200/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-amber-100/20 blur-3xl" />
      </div>

      <div className="w-full max-w-md relative z-10">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 mb-5 shadow-lg shadow-indigo-200">
            <span className="text-4xl" role="img" aria-label="heart">
              &#x2764;&#xFE0F;
            </span>
          </div>
          <h1
            className="text-4xl font-bold tracking-tight"
            style={{ color: "var(--color-text-primary)" }}
          >
            {strings.common.appName}
          </h1>
          <p className="mt-2 text-base" style={{ color: "var(--color-text-secondary)" }}>
            {strings.common.tagline}
          </p>
        </div>

        <div
          className="rounded-3xl p-8 shadow-xl border"
          style={{
            background: "var(--color-surface-overlay)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderColor: "var(--color-border)",
            boxShadow:
              "0 20px 60px -12px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.5) inset",
          }}
        >
          <h2
            className="text-2xl font-semibold mb-1"
            style={{ color: "var(--color-text-primary)" }}
          >
            {currentStep === 0
              ? strings.auth.signup.createYourAccount
              : strings.auth.signup.buildYourProfile}
          </h2>
          <p className="text-sm mb-8" style={{ color: "var(--color-text-secondary)" }}>
            {currentStep === 0
              ? strings.auth.signup.signupSubtitle
              : strings.auth.signup.profileSubtitle}
          </p>

          {/* Step indicator */}
          <div className="flex items-center justify-between mb-8 px-2">
            {STEP_LABELS.map((label, i) => (
              <div key={i} className="flex flex-col items-center flex-1">
                <div className="flex items-center w-full">
                  {i > 0 && (
                    <div
                      className="flex-1 h-0.5"
                      style={{
                        background:
                          i <= currentStep ? "var(--color-brand)" : "var(--color-border)",
                      }}
                    />
                  )}
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-all duration-200"
                    style={{
                      background:
                        i <= currentStep ? "var(--color-brand)" : "var(--color-surface)",
                      color:
                        i <= currentStep
                          ? "var(--color-text-on-brand)"
                          : "var(--color-text-muted)",
                      border: i <= currentStep ? "none" : "1px solid var(--color-border)",
                      boxShadow:
                        i === currentStep ? "0 0 0 4px var(--color-brand-muted)" : "none",
                    }}
                  >
                    {i < currentStep ? "\u2713" : i + 1}
                  </div>
                  {i < STEP_LABELS.length - 1 && (
                    <div
                      className="flex-1 h-0.5"
                      style={{
                        background:
                          i < currentStep ? "var(--color-brand)" : "var(--color-border)",
                      }}
                    />
                  )}
                </div>
                <span
                  className="text-[10px] mt-2 text-center font-medium"
                  style={{
                    color:
                      i === currentStep ? "var(--color-brand)" : "var(--color-text-muted)",
                  }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Step 0: Account */}
          {currentStep === 0 && (
            <form onSubmit={handleAccountSubmit} className="space-y-5">
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
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={strings.auth.emailPlaceholder}
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
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
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={strings.auth.passwordPlaceholder}
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block text-sm font-medium mb-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {strings.auth.signup.confirmPasswordLabel}
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={strings.auth.signup.confirmPasswordPlaceholder}
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              {error && (
                <div
                  className="text-sm rounded-2xl px-4 py-3 border"
                  style={{
                    color: "var(--color-danger)",
                    background: "var(--color-danger-light)",
                    borderColor: "rgba(220, 38, 38, 0.15)",
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-2xl font-semibold text-sm text-white shadow-lg shadow-indigo-200/50 hover:shadow-indigo-300/50 active:scale-[0.98] disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)",
                }}
              >
                {loading ? "..." : strings.auth.signup.nextButton}
              </button>
            </form>
          )}

          {/* Step 1: Profile */}
          {currentStep === 1 && (
            <form onSubmit={handleProfileSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="displayName"
                  className="block text-sm font-medium mb-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {strings.auth.signup.nameLabel}
                </label>
                <input
                  id="displayName"
                  name="displayName"
                  type="text"
                  required
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={strings.auth.signup.namePlaceholder}
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              <div>
                <label
                  htmlFor="phone"
                  className="block text-sm font-medium mb-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {strings.auth.signup.phoneLabel}
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={strings.auth.signup.phonePlaceholder}
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              <div>
                <label
                  htmlFor="onboardingHint"
                  className="block text-sm font-medium mb-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {strings.auth.signup.hintLabel}
                </label>
                <textarea
                  id="onboardingHint"
                  name="onboardingHint"
                  rows={3}
                  value={onboardingHint}
                  onChange={(e) => setOnboardingHint(e.target.value)}
                  placeholder={strings.auth.signup.hintPlaceholder}
                  className={`${inputClass} resize-none`}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              {error && (
                <div
                  className="text-sm rounded-2xl px-4 py-3 border"
                  style={{
                    color: "var(--color-danger)",
                    background: "var(--color-danger-light)",
                    borderColor: "rgba(220, 38, 38, 0.15)",
                  }}
                >
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={handleUseDifferentAccount}
                  disabled={loading}
                  className="px-5 py-3 rounded-2xl text-sm font-semibold border transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                  style={{
                    color: "var(--color-text-secondary)",
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface)",
                  }}
                >
                  {strings.auth.signup.useDifferentAccount}
                </button>
                <button
                  type="submit"
                  disabled={loading || !displayName.trim()}
                  className="px-6 py-3 rounded-2xl font-semibold text-sm text-white shadow-lg shadow-indigo-200/50 hover:shadow-indigo-300/50 active:scale-[0.98] disabled:opacity-50"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)",
                  }}
                >
                  {loading ? "..." : strings.auth.signup.completeButton}
                </button>
              </div>
            </form>
          )}

          {/* Only before the account exists; on the profile step the user is
              already signed in ("Use a different account" signs out). */}
          {currentStep === 0 && (
            <div className="mt-8 text-center">
              <button
                onClick={() => router.push("/")}
                className="text-sm font-medium"
                style={{ color: "var(--color-brand)" }}
              >
                {strings.auth.signup.alreadyHaveAccount}
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs mt-8" style={{ color: "var(--color-text-muted)" }}>
          {strings.common.privacyNote}
        </p>
      </div>
    </div>
  );
}
