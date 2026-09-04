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

/**
 * A single message row in the chat, covering both the edit mode (inline
 * textarea) and the display mode (bubble + hover-revealed Edit/Delete
 * actions). Pure presentational — all state and mutation handlers are
 * lifted to the parent.
 */
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
  return (
    <div
      key={m.id ?? `local-${index}`}
      className={`group flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
    >
      {isEditing ? (
        <div className="max-w-[80%] w-full bg-white border rounded shadow-sm p-2 space-y-2">
          <textarea
            value={editingDraft}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={3}
            className="w-full border p-2 rounded resize-none"
            aria-label="Edit message"
          />
          <div className="flex justify-end space-x-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="text-sm border px-3 py-1 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={!editingDraft.trim()}
              className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 disabled:bg-gray-400"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="relative max-w-[80%]">
          <div
            className={`px-3 py-2 rounded shadow-sm ${
              m.role === "user"
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-900 border"
            }`}
          >
            {m.content}
          </div>
          {/* Hover-revealed action row. We use group-hover so the
              affordances appear together. Buttons are always present in
              the DOM (just hidden) so keyboard users can tab to them —
              focus-visible shows them too. */}
          {(canEdit || canDelete) && (
            <div
              className={`absolute -top-2 ${m.role === "user" ? "left-0" : "right-0"} flex space-x-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity`}
            >
              {canEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label="Edit message"
                  className="bg-white border text-gray-700 text-xs px-2 py-0.5 rounded shadow-sm hover:bg-gray-50 focus:opacity-100"
                >
                  Edit
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Delete message"
                  className="bg-white border text-red-600 text-xs px-2 py-0.5 rounded shadow-sm hover:bg-red-50 focus:opacity-100"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
