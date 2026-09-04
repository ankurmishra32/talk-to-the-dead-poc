import { strings } from "../../lib/strings";

type Props = {
  input: string;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSend: (e: React.FormEvent) => void;
  onCancel: () => void;
};

export default function ChatComposer({
  input,
  loading,
  onInputChange,
  onSend,
  onCancel,
}: Props) {
  return (
    <form
      onSubmit={onSend}
      className="p-4 border-t flex gap-3 items-end"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-raised)" }}
    >
      <label htmlFor="chat-message" className="sr-only">
        {strings.chat.composeAria}
      </label>
      <textarea
        id="chat-message"
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend(e as unknown as React.FormEvent);
          }
        }}
        placeholder={strings.chat.composePlaceholder}
        rows={1}
        maxLength={4000}
        className="flex-1 border rounded-2xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
        style={{
          borderColor: "var(--color-border)",
          color: "var(--color-text-primary)",
          background: "var(--color-surface)",
        }}
        disabled={loading}
      />
      {loading ? (
        <button
          type="button"
          onClick={onCancel}
          className="px-5 py-3 rounded-2xl text-sm font-semibold text-white shrink-0 active:scale-[0.97]"
          style={{ background: "var(--color-text-secondary)" }}
        >
          {strings.chat.cancel}
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim()}
          className="px-5 py-3 rounded-2xl text-sm font-semibold text-white shrink-0 disabled:opacity-40 active:scale-[0.97] shadow-lg shadow-indigo-200/40"
          style={{
            background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)",
          }}
        >
          {strings.chat.send}
        </button>
      )}
    </form>
  );
}
