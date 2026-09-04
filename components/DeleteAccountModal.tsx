import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { deleteAccount } from "../lib/account";
import { strings } from "../lib/strings";

type Props = {
  open: boolean;
  user: User;
  onClose: () => void;
  onDeleted: () => void;
};

export default function DeleteAccountModal({ open, user, onClose, onDeleted }: Props) {
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    passwordRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = password.length > 0 && confirmText === "DELETE" && !loading;

  const handleDelete = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await deleteAccount(user, password);
      onDeleted();
    } catch (err) {
      setLoading(false);
      if (err instanceof Error && err.message.includes("auth/wrong-password")) {
        setError(strings.account.authError);
      } else if (err instanceof Error && err.message.includes("auth/requires-recent-login")) {
        setError(strings.account.authError);
      } else {
        setError(err instanceof Error ? err.message : strings.account.authError);
      }
    }
  };

  const inputClass =
    "w-full px-4 py-3 text-sm rounded-2xl border transition-all duration-200 placeholder:text-stone-400";
  const inputStyle = {
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    borderColor: "var(--color-border)",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div
        className="absolute inset-0"
        style={{
          background: "rgba(28, 25, 23, 0.4)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="relative w-full max-w-sm p-6 rounded-3xl shadow-2xl space-y-5"
        style={{ background: "var(--color-surface-raised)" }}
      >
        <h2
          id="delete-account-title"
          className="text-lg font-semibold"
          style={{ color: "var(--color-danger)" }}
        >
          {strings.account.deleteTitle}
        </h2>
        <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
          {strings.account.deleteWarning}
        </p>

        <div>
          <label
            htmlFor="delete-password"
            className="block text-sm font-medium mb-2"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {strings.account.passwordLabel}
          </label>
          <input
            id="delete-password"
            ref={passwordRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={strings.account.passwordPlaceholder}
            className={inputClass}
            style={inputStyle}
          />
        </div>

        <div>
          <label
            htmlFor="delete-confirm"
            className="block text-sm font-medium mb-2"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {strings.account.confirmLabel}
          </label>
          <input
            id="delete-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={strings.account.confirmPlaceholder}
            className={inputClass}
            style={inputStyle}
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

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-5 py-2.5 rounded-2xl text-sm font-medium border active:scale-[0.97] disabled:opacity-50"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            {strings.common.cancel}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!canSubmit}
            className="px-5 py-2.5 rounded-2xl text-sm font-semibold text-white active:scale-[0.97] shadow-lg disabled:opacity-50"
            style={{ background: "var(--color-danger)" }}
          >
            {loading ? strings.account.deleting : strings.account.deleteButton}
          </button>
        </div>
      </div>
    </div>
  );
}
