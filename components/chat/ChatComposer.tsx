type Props = {
  input: string;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSend: (e: React.FormEvent) => void;
  onCancel: () => void;
};

/**
 * The message composer (textarea + Send / Cancel) at the bottom of the
 * chat. Pure presentational — Enter without Shift sends, Shift+Enter
 * inserts a newline, matching the original behavior lifted to the parent.
 */
export default function ChatComposer({
  input,
  loading,
  onInputChange,
  onSend,
  onCancel,
}: Props) {
  return (
    <form onSubmit={onSend} className="p-4 border-t flex space-x-2">
      <textarea
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend(e as unknown as React.FormEvent);
          }
        }}
        placeholder="Type a message…"
        rows={2}
        maxLength={4000}
        className="flex-1 border p-2 rounded resize-none"
        disabled={loading}
      />
      {loading ? (
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-700 text-white px-4 rounded hover:bg-gray-800"
        >
          Cancel
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim()}
          className="bg-blue-600 text-white px-4 rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          Send
        </button>
      )}
    </form>
  );
}
