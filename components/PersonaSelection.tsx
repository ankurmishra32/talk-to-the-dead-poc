import { useEffect, useRef, useState } from "react";
import { db } from "../firebase/config";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from "firebase/firestore";
import { useAuth } from "../lib/auth/useAuth";
import { mapPersonaDoc, reconcilePersonas } from "../lib/personas";
import type { PersonaItem, PersonaReference } from "../lib/types";
import { createLogger } from "../lib/logger";
import Confirm from "./Confirm";
import { strings } from "../lib/strings";

const logger = createLogger("PersonaSelection");

const STEP_LABELS = [
  strings.persona.steps.identity,
  strings.persona.steps.speech,
  strings.persona.steps.evidence,
  strings.persona.steps.memory,
];

type SpeechExampleInput = {
  phrase: string;
  context: string;
  meaning: string;
  tone: string;
  reaction: string;
};

export default function PersonaSelection({ onSelect }: { onSelect: (personaData: PersonaReference) => void }) {
  const [existing, setExisting] = useState<PersonaItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const { user, signOut } = useAuth();
  const userId = user?.uid ?? null;

  // Form state.
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState<string>("");
  const [theyCalledYou, setTheyCalledYou] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [howTheySpoke, setHowTheySpoke] = useState<string[]>([]);
  const [speechExamples, setSpeechExamples] = useState<SpeechExampleInput[]>([
    { phrase: "", context: "", meaning: "", tone: "", reaction: "" },
  ]);
  const [distinctiveStory, setDistinctiveStory] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<PersonaItem | null>(null);

  // Step navigation state.
  const [currentStep, setCurrentStep] = useState(0);
  // Per-entry toggle for optional speech example fields (meaning/tone/reaction).
  const [showOptional, setShowOptional] = useState<boolean[]>([false]);

  // Live subscription to this user's personas.
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    setListLoading(true);
    const personasQuery = query(
      collection(db, "personas"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
      limit(50)
    );
    let isFirstSnap = true;
    const unsubscribe = onSnapshot(
      personasQuery,
      (snap) => {
        if (cancelled) return;
        if (isFirstSnap) {
          isFirstSnap = false;
          const items = snap.docs
            .map((d) => mapPersonaDoc(d, userId))
            .filter((p): p is PersonaItem => p !== null);
          setExisting(items);
          setListLoading(false);
          return;
        }
        setExisting((prev) => reconcilePersonas(prev, snap.docChanges(), userId));
      },
      (err) => {
        if (cancelled) return;
        logger.error("Persona subscription failed", err);
        setListLoading(false);
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  const toggleFromArray = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setRelationship("");
    setTheyCalledYou("");
    setLanguages([]);
    setHowTheySpoke([]);
    setSpeechExamples([{ phrase: "", context: "", meaning: "", tone: "", reaction: "" }]);
    setDistinctiveStory("");
    setError(null);
    setCurrentStep(0);
    setShowOptional([false]);
  };

  const startEdit = (p: PersonaItem) => {
    setEditingId(p.id);
    setName(p.name || "");
    setRelationship(p.relationship || "");
    setTheyCalledYou(p.theyCalledYou || "");
    setLanguages(p.languages || []);
    setHowTheySpoke(p.howTheySpoke || []);

    if (p.speechExamples && p.speechExamples.length > 0) {
      setSpeechExamples(
        p.speechExamples.map((ex) => ({
          phrase: ex.phrase || "",
          context: ex.context || "",
          meaning: ex.meaning || "",
          tone: ex.tone || "",
          reaction: ex.reaction || "",
        }))
      );
      setShowOptional(p.speechExamples.map(() => false));
    } else if (p.oftenSaid && p.oftenSaid.length > 0) {
      setSpeechExamples(
        p.oftenSaid.map((phrase) => ({
          phrase: phrase || "",
          context: "",
          meaning: "",
          tone: "",
          reaction: "",
        }))
      );
      setShowOptional(p.oftenSaid.map(() => false));
    } else {
      setSpeechExamples([{ phrase: "", context: "", meaning: "", tone: "", reaction: "" }]);
      setShowOptional([false]);
    }

    setDistinctiveStory(p.distinctiveStory || "");
    setError(null);
    setCurrentStep(0);
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleDelete = async (p: PersonaItem) => {
    try {
      await deleteDoc(doc(db, "personas", p.id));
      setExisting((prev) => prev.filter((item) => item.id !== p.id));
      if (editingId === p.id) resetForm();
    } catch (err) {
      logger.error("Error deleting persona", err);
      setError(err instanceof Error ? err.message : "Failed to delete persona.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) {
      setError(strings.persona.signOutRequired);
      return;
    }
    setError(null);

    for (const item of speechExamples) {
      const p = item.phrase.trim();
      const c = item.context.trim();
      if (p && !c) {
        setError(strings.persona.missingContext(p));
        return;
      }
    }

    setLoading(true);

    type CleanExample = {
      phrase: string;
      context: string;
      meaning?: string;
      tone?: string;
      reaction?: string;
    };
    const cleanSpeechExamples: CleanExample[] = speechExamples
      .map((item): CleanExample => {
        const entry: CleanExample = {
          phrase: item.phrase.trim(),
          context: item.context.trim(),
        };
        if (item.meaning.trim()) entry.meaning = item.meaning.trim();
        if (item.tone.trim()) entry.tone = item.tone.trim();
        if (item.reaction.trim()) entry.reaction = item.reaction.trim();
        return entry;
      })
      .filter((item) => item.phrase.length > 0 && item.context.length > 0);

    const legacyOftenSaid = cleanSpeechExamples.map((item) => item.phrase);

    const personaPayload = {
      name: name.trim(),
      relationship: relationship || null,
      theyCalledYou: theyCalledYou.trim() || null,
      languages,
      howTheySpoke,
      speechExamples: cleanSpeechExamples,
      oftenSaid: legacyOftenSaid,
      distinctiveStory: distinctiveStory.trim() || null,
      traits: "",
      userId,
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, "personas", editingId), {
          ...personaPayload,
          updatedAt: new Date(),
        });
        setExisting((prev) =>
          prev.map((item) =>
            item.id === editingId
              ? { ...item, ...personaPayload, ownerId: userId }
              : item
          )
        );
        resetForm();
      } else {
        const docRef = await addDoc(collection(db, "personas"), {
          ...personaPayload,
          createdAt: new Date(),
        });
        onSelect({ id: docRef.id, name: name.trim() });
      }
    } catch (err) {
      logger.error("Error saving persona", err);
      setError(err instanceof Error ? err.message : "Failed to save persona.");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (err) {
      logger.error("Sign out failed", err);
    }
  };

  // Step navigation.
  const nextStep = () => setCurrentStep((s) => Math.min(s + 1, 3));
  const prevStep = () => setCurrentStep((s) => Math.max(s - 1, 0));

  // Toggle optional fields for a speech example entry.
  const toggleOptional = (index: number) => {
    setShowOptional((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  // ---- Step content renderers ----------------------------------------

  const inputCls = "w-full px-4 py-3 text-sm rounded-2xl border focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 placeholder:text-stone-400";
  const inputStyle = { background: "var(--color-surface-raised)", color: "var(--color-text-primary)", borderColor: "var(--color-border)" };

  const renderStep0 = () => (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
          {strings.persona.identity.nameLabel}
        </label>
        <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder={strings.persona.identity.namePlaceholder} className={inputCls} style={inputStyle} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
          {strings.persona.identity.relationshipLabel}
        </label>
        <select value={relationship} onChange={(e) => setRelationship(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">{strings.persona.relationshipsEmptyOption}</option>
          {strings.persona.relationships.map((r) => (<option key={r} value={r}>{r}</option>))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
          {strings.persona.identity.theyCalledYouLabel}
        </label>
        <input type="text" value={theyCalledYou} onChange={(e) => setTheyCalledYou(e.target.value)} placeholder={strings.persona.identity.theyCalledYouPlaceholder} className={inputCls} style={inputStyle} />
      </div>
    </div>
  );

  const tagCls = (on: boolean) => `px-4 py-2 rounded-xl text-sm font-medium border transition-all duration-150 ${on ? "shadow-sm" : "hover:border-stone-300"}`;
  const tagStyle = (on: boolean) => ({
    background: on ? "var(--color-brand)" : "var(--color-surface-raised)",
    color: on ? "var(--color-text-on-brand)" : "var(--color-text-secondary)",
    borderColor: on ? "var(--color-brand)" : "var(--color-border)",
  });

  const renderStep1 = () => (
    <div className="space-y-6">
      <div>
        <span className="block text-sm font-medium mb-3" style={{ color: "var(--color-text-secondary)" }}>
          {strings.persona.speech.languagesLabel}
        </span>
        <div className="flex flex-wrap gap-2">
          {strings.persona.languages.map((lang) => {
            const on = languages.includes(lang);
            return (
              <button type="button" key={lang} onClick={() => setLanguages(toggleFromArray(languages, lang))} className={tagCls(on)} style={tagStyle(on)}>
                {lang}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <span className="block text-sm font-medium mb-3" style={{ color: "var(--color-text-secondary)" }}>
          {strings.persona.speech.mannerLabel}
        </span>
        <div className="flex flex-wrap gap-2">
          {strings.persona.speechStyles.map((style) => {
            const on = howTheySpoke.includes(style);
            return (
              <button type="button" key={style} onClick={() => setHowTheySpoke(toggleFromArray(howTheySpoke, style))} className={tagCls(on)} style={tagStyle(on)}>
                {style}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        {strings.persona.evidence.intro}
      </p>
      <div className="space-y-4">
        {speechExamples.map((ex, i) => (
          <div key={i} className="p-5 rounded-2xl border space-y-4" style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                {strings.persona.evidence.exampleHeading(i + 1)}
              </span>
              {speechExamples.length > 1 && (
                <button type="button" onClick={() => { setSpeechExamples(speechExamples.filter((_, idx) => idx !== i)); setShowOptional((prev) => prev.filter((_, idx) => idx !== i)); }} className="text-xs font-medium" style={{ color: "var(--color-danger)" }}>
                  {strings.persona.evidence.remove}
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>{strings.persona.evidence.phraseLabel}</label>
              <input type="text" value={ex.phrase} onChange={(e) => { const next = [...speechExamples]; next[i] = { ...next[i], phrase: e.target.value }; setSpeechExamples(next); }} placeholder={i === 0 ? strings.persona.evidence.phrasePlaceholderPrimary : strings.persona.evidence.phrasePlaceholderSecondary} className={inputCls} style={inputStyle} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>{strings.persona.evidence.contextLabel}</label>
              <input type="text" value={ex.context} onChange={(e) => { const next = [...speechExamples]; next[i] = { ...next[i], context: e.target.value }; setSpeechExamples(next); }} placeholder={i === 0 ? strings.persona.evidence.contextPlaceholderPrimary : strings.persona.evidence.contextPlaceholderSecondary} className={inputCls} style={inputStyle} />
            </div>
            <button type="button" onClick={() => toggleOptional(i)} className="text-xs font-medium" style={{ color: "var(--color-brand)" }}>
              {showOptional[i] ? strings.persona.evidence.lessDetails : strings.persona.evidence.moreDetails}
            </button>
            {showOptional[i] && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>{strings.persona.evidence.meaningLabel} <span style={{ color: "var(--color-text-muted)" }} className="font-normal">{strings.persona.evidence.optionalSuffix}</span></label>
                  <input type="text" value={ex.meaning} onChange={(e) => { const next = [...speechExamples]; next[i] = { ...next[i], meaning: e.target.value }; setSpeechExamples(next); }} placeholder={i === 0 ? strings.persona.evidence.meaningPlaceholderPrimary : strings.persona.evidence.meaningPlaceholderSecondary} className={inputCls} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>{strings.persona.evidence.toneLabel} <span style={{ color: "var(--color-text-muted)" }} className="font-normal">{strings.persona.evidence.optionalSuffix}</span></label>
                  <input type="text" value={ex.tone} onChange={(e) => { const next = [...speechExamples]; next[i] = { ...next[i], tone: e.target.value }; setSpeechExamples(next); }} placeholder={i === 0 ? strings.persona.evidence.tonePlaceholderPrimary : strings.persona.evidence.tonePlaceholderSecondary} className={inputCls} style={inputStyle} />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>{strings.persona.evidence.reactionLabel} <span style={{ color: "var(--color-text-muted)" }} className="font-normal">{strings.persona.evidence.optionalSuffix}</span></label>
                  <input type="text" value={ex.reaction} onChange={(e) => { const next = [...speechExamples]; next[i] = { ...next[i], reaction: e.target.value }; setSpeechExamples(next); }} placeholder={i === 0 ? strings.persona.evidence.reactionPlaceholderPrimary : strings.persona.evidence.reactionPlaceholderSecondary} className={inputCls} style={inputStyle} />
                </div>
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={() => { setSpeechExamples([...speechExamples, { phrase: "", context: "", meaning: "", tone: "", reaction: "" }]); setShowOptional((prev) => [...prev, false]); }} className="text-sm font-medium" style={{ color: "var(--color-brand)" }}>
          {strings.persona.evidence.addAnother}
        </button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        {strings.persona.memory.intro}
      </p>
      <textarea
        value={distinctiveStory}
        onChange={(e) => setDistinctiveStory(e.target.value)}
        placeholder={strings.persona.memory.textareaPlaceholder}
        className="w-full px-4 py-3 rounded-2xl h-32 text-sm border resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 placeholder:text-stone-400"
        style={{ background: "var(--color-surface-raised)", color: "var(--color-text-primary)", borderColor: "var(--color-border)" }}
      />
    </div>
  );

  const stepRenderers = [renderStep0, renderStep1, renderStep2, renderStep3];

  // ---- Render ------------------------------------------------------

  const btnPrimary = "px-5 py-2.5 rounded-2xl text-sm font-semibold text-white shadow-lg shadow-indigo-200/40 active:scale-[0.97]";
  const btnSecondary = "px-4 py-2.5 rounded-2xl text-sm font-medium border active:scale-[0.97]";

  return (
    <div className="max-w-2xl mx-auto p-8 rounded-3xl space-y-8" style={{ background: "var(--color-surface-raised)", boxShadow: "0 8px 40px -8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.03)" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold" style={{ color: "var(--color-text-primary)" }}>{strings.persona.heading}</h2>
        <button onClick={handleSignOut} className="text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>
          {strings.common.signOut}
        </button>
      </div>

      {/* Existing personas list */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>{strings.persona.yourPeople}</h3>
        {listLoading ? (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{strings.persona.loadingList}</p>
        ) : existing.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{strings.persona.emptyList}</p>
        ) : (
          <div className="space-y-2">
            {existing.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-4 rounded-2xl border" style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}>
                <div>
                  <div className="font-semibold" style={{ color: "var(--color-text-primary)" }}>{p.name}</div>
                  {p.relationship && <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>{p.relationship}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => startEdit(p)} className={btnSecondary} style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                    {strings.common.edit}
                  </button>
                  <button type="button" onClick={() => setPendingDelete(p)} className={btnSecondary} style={{ borderColor: "rgba(220,38,38,0.15)", color: "var(--color-danger)" }}>
                    {strings.common.delete}
                  </button>
                  <button type="button" onClick={() => onSelect(p)} className={btnPrimary} style={{ background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)" }}>
                    {strings.persona.talk}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Form with steps */}
      <section ref={formRef} className="pt-6 border-t" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {editingId ? (name ? strings.persona.editHeading(name) : strings.persona.editHeadingGeneric) : strings.persona.createNew}
          </h3>
          {editingId && (
            <button type="button" onClick={resetForm} className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
              {strings.persona.cancelEdit}
            </button>
          )}
        </div>
        <p className="mb-6 text-sm" style={{ color: "var(--color-text-muted)" }}>
          {editingId ? strings.persona.editSubtitle : strings.persona.createSubtitle}
        </p>

        {/* Progress indicator */}
        <div className="flex items-center justify-between mb-8 px-2">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex flex-col items-center flex-1">
              <div className="flex items-center w-full">
                {i > 0 && <div className="flex-1 h-0.5" style={{ background: i <= currentStep ? "var(--color-brand)" : "var(--color-border)" }} />}
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-all duration-200"
                  style={{
                    background: i <= currentStep ? "var(--color-brand)" : "var(--color-surface)",
                    color: i <= currentStep ? "var(--color-text-on-brand)" : "var(--color-text-muted)",
                    border: i <= currentStep ? "none" : "1px solid var(--color-border)",
                    boxShadow: i === currentStep ? "0 0 0 4px var(--color-brand-muted)" : "none",
                  }}>
                  {i < currentStep ? "\u2713" : i + 1}
                </div>
                {i < STEP_LABELS.length - 1 && <div className="flex-1 h-0.5" style={{ background: i < currentStep ? "var(--color-brand)" : "var(--color-border)" }} />}
              </div>
              <span className="text-[10px] mt-2 text-center font-medium" style={{ color: i === currentStep ? "var(--color-brand)" : "var(--color-text-muted)" }}>
                {label}
              </span>
            </div>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="min-h-[200px]">{stepRenderers[currentStep]()}</div>

          {error && (
            <div className="text-sm rounded-2xl px-4 py-3 border" style={{ color: "var(--color-danger)", background: "var(--color-danger-light)", borderColor: "rgba(220,38,38,0.15)" }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <div>
              {currentStep > 0 && (
                <button type="button" onClick={prevStep} className={btnSecondary} style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                  {strings.common.back}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {editingId && (
                <button type="button" onClick={resetForm} disabled={loading} className={btnSecondary} style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                  {strings.common.cancel}
                </button>
              )}
              {currentStep < 3 ? (
                <button type="button" onClick={nextStep} className={btnPrimary} style={{ background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)" }}>
                  {strings.common.next}
                </button>
              ) : (
                <button type="submit" disabled={loading} className={`${btnPrimary} disabled:opacity-40`} style={{ background: "linear-gradient(135deg, var(--color-brand) 0%, #7c3aed 100%)" }}>
                  {loading ? strings.persona.saving : editingId ? strings.persona.saveChangesButton : strings.persona.rememberThemButton}
                </button>
              )}
            </div>
          </div>
        </form>
      </section>

      <Confirm
        open={pendingDelete !== null}
        title={pendingDelete ? strings.persona.confirmDeleteTitle(pendingDelete.name) : ""}
        message={strings.persona.confirmDeleteMessage}
        onConfirm={() => { if (pendingDelete) handleDelete(pendingDelete); setPendingDelete(null); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
