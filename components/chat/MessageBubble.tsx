import { strings } from "../../lib/strings";
import type { ChatMessage } from "../../lib/types";

type Props = {
  m: ChatMessage;
  index: number;
  isEditing: boolean;
  canEdit: boolean;
  canDelete: boolean;
  editingDraft: string;
  onDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export default function MessageBubble({
  m,
  index,
  isEditing,
  canEdit,
  canDelete,
  editingDraft,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  onEdit,
  onDelete,
}: Props) {
  const isUser = m.role === "user";

  return (
    <div
      key={m.id ?? `local-${index}`}
      className={`group flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      {isEditing ? (
        <div className="max-w-[80%] w-full rounded-2xl border p-3 space-y-3"
          style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)" }}
        >
          <textarea
            value={editingDraft}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={3}
            className="w-full border rounded-xl p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
            aria-label={strings.messageBubble.editAria}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="px-4 py-1.5 rounded-xl text-sm font-medium border hover:bg-stone-50"
              style={{ color: "var(--color-text-secondary)", borderColor: "var(--color-border)" }}
            >
              {strings.common.cancel}
            </button>
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={!editingDraft.trim()}
              className="px-4 py-1.5 rounded-xl text-sm font-medium text-white disabled:opacity-40"
              style={{ background: "var(--color-brand)" }}
            >
              {strings.common.save}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative max-w-[80%]">
          <div
            className={`px-4 py-3 text-sm leading-relaxed ${
              isUser
                ? "text-white rounded-2xl rounded-br-md shadow-md"
                : "rounded-2xl rounded-bl-md border shadow-sm"
            }`}
            style={
              isUser
                ? { background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)" }
                : { background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }
            }
          >
            {m.content}
          </div>
          {(canEdit || canDelete) && (
            <div
              className={`absolute -top-3 ${isUser ? "left-0" : "right-0"} flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150`}
            >
              {canEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label={strings.messageBubble.editAria}
                  className="text-xs px-2.5 py-1 rounded-lg shadow-sm border font-medium hover:bg-stone-50"
                  style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
                >
                  {strings.common.edit}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label={strings.messageBubble.deleteAria}
                  className="text-xs px-2.5 py-1 rounded-lg shadow-sm border font-medium"
                  style={{ background: "var(--color-surface-raised)", borderColor: "rgba(220, 38, 38, 0.15)", color: "var(--color-danger)" }}
                >
                  {strings.common.delete}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
