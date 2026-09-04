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
          ? query(collection(db, "memories"), where("userId", "==", user.uid), where("personaId", "==", persona.id), orderBy("createdAt", "desc"), limit(50))
          : query(collection(db, "memories"), where("userId", "==", user.uid), orderBy("createdAt", "desc"), limit(50));
        const snap = await getDocs(q);
        if (cancelled) return;
        const items: MemoryItem[] = snap.docs.map((d) => {
          const data = d.data();
          return { id: d.id, text: (data.text as string) || "", createdAt: data.createdAt ?? null, userId: (data.userId as string) || "", personaId: (data.personaId as string) || null };
        });
        setMemories(items);
      } catch (err) {
        if (!cancelled) logger.error("Failed to load memories", err);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }

    loadMemories();
    return () => { cancelled = true; };
  }, [persona?.id, user.uid]);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);

    try {
      const docRef = await addDoc(collection(db, "memories"), {
        userId: user.uid, personaId: persona?.id ?? null, text: trimmed, createdAt: Timestamp.now(),
      });
      setMemories((prev) => [{ id: docRef.id, userId: user.uid, personaId: persona?.id ?? null, text: trimmed, createdAt: new Date() }, ...prev]);
      setText("");
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      logger.error("Failed to save memory", err);
      setError(strings.memoryInput.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (m: MemoryItem) => { setEditingId(m.id); setEditingText(m.text); };
  const cancelEdit = () => { setEditingId(null); setEditingText(""); };

  const handleSaveEdit = async (id: string) => {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await updateDoc(doc(db, "memories", id), { text: trimmed, updatedAt: Timestamp.now() });
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: trimmed } : m)));
      setEditingId(null);
      setEditingText("");
    } catch (err) {
      logger.error("Failed to update memory", err);
      setError(strings.memoryInput.updateFailed);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setError(null);
    try {
      await deleteDoc(doc(db, "memories", id));
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (editingId === id) { setEditingId(null); setEditingText(""); }
    } catch (err) {
      logger.error("Failed to delete memory", err);
      setError(strings.memoryInput.deleteFailed);
    }
  };

  const inputCls = "w-full px-4 py-3 rounded-2xl text-sm border resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 placeholder:text-stone-400";
  const inputStyle = { background: "var(--color-surface-raised)", color: "var(--color-text-primary)", borderColor: "var(--color-border)" };

  return (
    <div className="space-y-4">
      <form onSubmit={handleAddMemory} className="space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="memory-text" className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-secondary)" }}>
            {strings.memoryInput.addMemoryAction}{persona?.name ? ` ${strings.memoryInput.addMemoryFor(persona.name)}` : ""}
          </label>
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{strings.memoryInput.helper}</span>
        </div>
        <textarea id="memory-text" className={inputCls} style={{ ...inputStyle, minHeight: "5rem" }}
          placeholder={persona?.name ? strings.memoryInput.textareaPlaceholderFor(persona.name) : strings.memoryInput.textareaPlaceholder}
          value={text} onChange={(e) => setText(e.target.value)} disabled={saving}
        />
        <div className="flex items-center justify-between">
          <button type="submit" disabled={!text.trim() || saving}
            className="px-5 py-2.5 rounded-2xl text-sm font-semibold text-white shadow-lg shadow-indigo-200/40 disabled:opacity-40 active:scale-[0.97]"
            style={{ background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)" }}>
            {saving ? strings.memoryInput.saving : strings.memoryInput.saveMemory}
          </button>
          {savedSuccess && (
            <span className="text-xs font-medium px-3 py-1 rounded-xl border"
              style={{ color: "var(--color-success)", background: "var(--color-success-light)", borderColor: "rgba(22,163,74,0.15)" }}>
              {strings.memoryInput.savedSuccess}
            </span>
          )}
        </div>
      </form>

      {error && (
        <div className="text-xs rounded-2xl px-4 py-3 border" style={{ color: "var(--color-danger)", background: "var(--color-danger-light)", borderColor: "rgba(220,38,38,0.15)" }}>
          {error}
        </div>
      )}

      <div className="pt-4 border-t space-y-3" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
          {strings.memoryInput.savedMemoriesHeading(memories.length)}
        </span>

        {listLoading ? (
          <p className="text-xs italic py-2" style={{ color: "var(--color-text-muted)" }}>{strings.memoryInput.loadingList}</p>
        ) : memories.length === 0 ? (
          <p className="text-xs italic py-2" style={{ color: "var(--color-text-muted)" }}>{strings.memoryInput.emptyList}</p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {memories.map((m) => (
              <div key={m.id} className="p-3 rounded-2xl border text-xs shadow-sm relative group" style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}>
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <textarea value={editingText} onChange={(e) => setEditingText(e.target.value)} rows={3} aria-label={strings.memoryInput.editMemoryAria}
                      className="w-full border p-2 rounded-xl text-xs bg-white resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20" style={{ borderColor: "var(--color-border)" }} />
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={cancelEdit} className="px-3 py-1 rounded-xl text-xs font-medium border hover:bg-stone-50"
                        style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>{strings.common.cancel}</button>
                      <button type="button" onClick={() => handleSaveEdit(m.id)} disabled={!editingText.trim()}
                        className="px-3 py-1 rounded-xl text-xs font-semibold text-white disabled:opacity-40"
                        style={{ background: "var(--color-brand)" }}>{strings.common.save}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex-1 whitespace-pre-wrap leading-relaxed">{m.text}</p>
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                      <button type="button" onClick={() => startEdit(m)} className="text-xs px-2 py-0.5 rounded-lg border font-medium"
                        style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>{strings.common.edit}</button>
                      <button type="button" onClick={() => setPendingDeleteId(m.id)} className="text-xs px-2 py-0.5 rounded-lg border font-medium"
                        style={{ borderColor: "rgba(220,38,38,0.15)", color: "var(--color-danger)" }}>{strings.common.delete}</button>
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
        onConfirm={() => { if (pendingDeleteId) handleDeleteMemory(pendingDeleteId); setPendingDeleteId(null); }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
