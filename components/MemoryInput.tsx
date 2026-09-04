import { useEffect, useState } from "react";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { createLogger } from "../lib/logger";
import Confirm from "./Confirm";
import { strings } from "../lib/strings";

const logger = createLogger("MemoryInput");

type Persona = { id: string; name?: string };

type MemoryItem = {
  id: string;
  text: string;
  createdAt?: Timestamp | Date | null;
  userId: string;
  personaId?: string | null;
};

export default function MemoryInput({
  user,
  persona,
}: {
  user: { uid: string };
  persona?: Persona;
}) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setError(null);

    async function loadMemories() {
      try {
        const q = persona?.id
          ? query(
              collection(db, "memories"),
              where("userId", "==", user.uid),
              where("personaId", "==", persona.id),
              orderBy("createdAt", "desc"),
              limit(50)
            )
          : query(
              collection(db, "memories"),
              where("userId", "==", user.uid),
              orderBy("createdAt", "desc"),
              limit(50)
            );
        const snap = await getDocs(q);
        if (cancelled) return;
        const items: MemoryItem[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              text: (data.text as string) || "",
              createdAt: data.createdAt ?? null,
              userId: (data.userId as string) || "",
              personaId: (data.personaId as string) || null,
            };
          });
        setMemories(items);
      } catch (err) {
        if (!cancelled) {
          logger.error("Failed to load memories", err);
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }

    loadMemories();
    return () => {
      cancelled = true;
    };
  }, [persona?.id, user.uid]);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);

    try {
      const docRef = await addDoc(collection(db, "memories"), {
        userId: user.uid,
        personaId: persona?.id ?? null,
        text: trimmed,
        createdAt: Timestamp.now(),
      });

      const newMemory: MemoryItem = {
        id: docRef.id,
        userId: user.uid,
        personaId: persona?.id ?? null,
        text: trimmed,
        createdAt: new Date(),
      };
      setMemories((prev) => [newMemory, ...prev]);
      setText("");
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      logger.error("Failed to save memory", err);
      setError(err instanceof Error ? err.message : strings.memoryInput.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setEditingText(m.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };

  const handleSaveEdit = async (id: string) => {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    setError(null);

    try {
      await updateDoc(doc(db, "memories", id), {
        text: trimmed,
        updatedAt: Timestamp.now(),
      });
      setMemories((prev) =>
        prev.map((m) => (m.id === id ? { ...m, text: trimmed } : m))
      );
      setEditingId(null);
      setEditingText("");
    } catch (err) {
      logger.error("Failed to update memory", err);
      setError(err instanceof Error ? err.message : strings.memoryInput.updateFailed);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setError(null);

    try {
      await deleteDoc(doc(db, "memories", id));
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (editingId === id) {
        setEditingId(null);
        setEditingText("");
      }
    } catch (err) {
      logger.error("Failed to delete memory", err);
      setError(err instanceof Error ? err.message : strings.memoryInput.deleteFailed);
    }
  };

  const addMemoryAction = strings.memoryInput.addMemoryAction;
  const addMemoryFor = persona?.name
    ? ` ${strings.memoryInput.addMemoryFor(persona.name)}`
    : "";

  return (
    <div className="space-y-4">
      {/* Add New Memory Form */}
      <form onSubmit={handleAddMemory} className="space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="memory-text" className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {addMemoryAction}{addMemoryFor}
          </label>
          <span className="text-xs text-gray-500">
            {strings.memoryInput.helper}
          </span>
        </div>
        <textarea
          id="memory-text"
          className="w-full border p-2.5 rounded text-sm bg-white"
          placeholder={
            persona?.name
              ? strings.memoryInput.textareaPlaceholderFor(persona.name)
              : strings.memoryInput.textareaPlaceholder
          }
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={saving}
        />
        <div className="flex items-center justify-between">
          <button
            className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded hover:bg-blue-700 disabled:bg-gray-400 font-medium"
            type="submit"
            disabled={!text.trim() || saving}
          >
            {saving ? strings.memoryInput.saving : strings.memoryInput.saveMemory}
          </button>
          {savedSuccess && (
            <span className="text-xs text-green-700 font-medium bg-green-50 px-2 py-1 rounded border border-green-200">
              {strings.memoryInput.savedSuccess}
            </span>
          )}
        </div>
      </form>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}

      {/* Existing Memories List */}
      <div className="pt-3 border-t space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {strings.memoryInput.savedMemoriesHeading(memories.length)}
          </span>
        </div>

        {listLoading ? (
          <p className="text-xs text-gray-500 italic py-2">{strings.memoryInput.loadingList}</p>
        ) : memories.length === 0 ? (
          <p className="text-xs text-gray-500 italic py-2">
            {strings.memoryInput.emptyList}
          </p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {memories.map((m) => (
              <div
                key={m.id}
                className="p-2.5 bg-white border rounded text-xs text-gray-800 shadow-sm relative group"
              >
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      rows={3}
                      aria-label={strings.memoryInput.editMemoryAria}
                      className="w-full border p-2 rounded text-xs bg-white resize-none"
                    />
                    <div className="flex justify-end space-x-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="border px-2.5 py-1 rounded hover:bg-gray-50 text-gray-600"
                      >
                        {strings.common.cancel}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(m.id)}
                        disabled={!editingText.trim()}
                        className="bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700 disabled:bg-gray-400 font-medium"
                      >
                        {strings.common.save}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between space-x-2">
                    <p className="flex-1 whitespace-pre-wrap">{m.text}</p>
                    <div className="flex items-center space-x-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(m)}
                        className="text-gray-600 hover:text-gray-900 border px-1.5 py-0.5 rounded text-[11px] bg-gray-50 hover:bg-gray-100"
                      >
                        {strings.common.edit}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(m.id)}
                        className="text-red-600 hover:text-red-800 border border-red-200 px-1.5 py-0.5 rounded text-[11px] bg-red-50 hover:bg-red-100"
                      >
                        {strings.common.delete}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Confirm
        open={pendingDeleteId !== null}
        title={strings.memoryInput.confirmDeleteTitle}
        message={strings.memoryInput.confirmDeleteMessage}
        onConfirm={() => {
          if (pendingDeleteId) handleDeleteMemory(pendingDeleteId);
          setPendingDeleteId(null);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
