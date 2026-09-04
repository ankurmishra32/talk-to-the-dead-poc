import { useEffect, useRef } from "react";
import { strings } from "../lib/strings";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function Confirm({
  open,
  title,
  message,
  confirmLabel = strings.confirm.delete,
  cancelLabel = strings.confirm.cancel,
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(28, 25, 23, 0.4)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="relative w-full max-w-sm p-6 rounded-3xl shadow-2xl space-y-5"
        style={{ background: "var(--color-surface-raised)" }}
      >
        <h2 id="confirm-title" className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
          {title}
        </h2>
        <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>{message}</p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-2.5 rounded-2xl text-sm font-medium border active:scale-[0.97]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            className="px-5 py-2.5 rounded-2xl text-sm font-semibold text-white active:scale-[0.97] shadow-lg"
            style={{ background: "var(--color-danger)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
