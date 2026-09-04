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

const logger = createLogger("PersonaSelection");

const RELATIONSHIPS = [
  "Mother",
  "Father",
  "Grandparent",
  "Sibling",
  "Friend",
  "Partner",
  "Other",
] as const;

const LANGUAGES = ["Hindi", "English", "Hinglish", "Other"] as const;

const SPEECH_STYLES = [
  "Quiet",
  "Talkative",
  "Direct",
  "Playful",
  "Sarcastic",
  "Formal",
  "Emotional",
  "Blunt",
] as const;

const STEP_LABELS = ["Who they were", "How they spoke", "What they said", "A memory"];

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
      setError("You must be signed in to save a persona.");
      return;
    }
    setError(null);

    for (const item of speechExamples) {
      const p = item.phrase.trim();
      const c = item.context.trim();
      if (p && !c) {
        setError(`Please specify when they would say "${p}" (the situation or trigger).`);
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

  const renderStep0 = () => (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          What did you call them?
        </label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mom, Grandpa, Alex"
          className="w-full border border-gray-300 p-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Who were they to you?
        </label>
        <select
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          className="w-full border border-gray-300 p-2.5 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="">Choose...</option>
          {RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          What did they call you?
        </label>
        <input
          type="text"
          value={theyCalledYou}
          onChange={(e) => setTheyCalledYou(e.target.value)}
          placeholder="e.g. sweetie, kiddo, buddy"
          className="w-full border border-gray-300 p-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
    </div>
  );

  const renderStep1 = () => (
    <div className="space-y-6">
      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">
          Languages they spoke
        </span>
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map((lang) => {
            const on = languages.includes(lang);
            return (
              <button
                type="button"
                key={lang}
                onClick={() => setLanguages(toggleFromArray(languages, lang))}
                className={`px-4 py-1.5 rounded-full border text-sm transition-colors ${
                  on
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:border-gray-400"
                }`}
              >
                {lang}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">
          How did they usually speak?
        </span>
        <div className="flex flex-wrap gap-2">
          {SPEECH_STYLES.map((style) => {
            const on = howTheySpoke.includes(style);
            return (
              <button
                type="button"
                key={style}
                onClick={() => setHowTheySpoke(toggleFromArray(howTheySpoke, style))}
                className={`px-4 py-1.5 rounded-full border text-sm transition-colors ${
                  on
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:border-gray-400"
                }`}
              >
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
      <p className="text-xs text-gray-500">
        Share phrases they used and the specific situations when they said them.
        This helps the AI respond authentically instead of repeating catchphrases out of place.
      </p>

      <div className="space-y-4">
        {speechExamples.map((ex, i) => (
          <div
            key={i}
            className="p-4 border border-gray-200 rounded-lg bg-gray-50/75 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Example {i + 1}
              </span>
              {speechExamples.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setSpeechExamples(speechExamples.filter((_, idx) => idx !== i));
                    setShowOptional((prev) => prev.filter((_, idx) => idx !== i));
                  }}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove
                </button>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                What is something they used to say?
              </label>
              <input
                type="text"
                value={ex.phrase}
                onChange={(e) => {
                  const next = [...speechExamples];
                  next[i] = { ...next[i], phrase: e.target.value };
                  setSpeechExamples(next);
                }}
                placeholder={
                  i === 0
                    ? "e.g. \"That's too expensive — who's paying for that?\""
                    : "e.g. \"Have you eaten yet?\""
                }
                className="w-full border border-gray-300 p-2 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                When would they say it?
              </label>
              <input
                type="text"
                value={ex.context}
                onChange={(e) => {
                  const next = [...speechExamples];
                  next[i] = { ...next[i], context: e.target.value };
                  setSpeechExamples(next);
                }}
                placeholder={
                  i === 0
                    ? "e.g. \"When I mentioned buying something expensive\""
                    : "e.g. \"Whenever I came home from work\""
                }
                className="w-full border border-gray-300 p-2 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Optional details — collapsed by default */}
            <button
              type="button"
              onClick={() => toggleOptional(i)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              {showOptional[i] ? "Less details" : "More details"}
            </button>

            {showOptional[i] && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    What did they mean?{" "}
                    <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={ex.meaning}
                    onChange={(e) => {
                      const next = [...speechExamples];
                      next[i] = { ...next[i], meaning: e.target.value };
                      setSpeechExamples(next);
                    }}
                    placeholder={
                      i === 0
                        ? "e.g. Disapproval: they thought I was wasting money"
                        : "e.g. Care: they wanted to know I was okay"
                    }
                    className="w-full border border-gray-300 p-2 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    How did they sound?{" "}
                    <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={ex.tone}
                    onChange={(e) => {
                      const next = [...speechExamples];
                      next[i] = { ...next[i], tone: e.target.value };
                      setSpeechExamples(next);
                    }}
                    placeholder={
                      i === 0
                        ? "e.g. Frustrated, direct"
                        : "e.g. Warm, caring"
                    }
                    className="w-full border border-gray-300 p-2 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    What would they typically do/say next?{" "}
                    <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={ex.reaction}
                    onChange={(e) => {
                      const next = [...speechExamples];
                      next[i] = { ...next[i], reaction: e.target.value };
                      setSpeechExamples(next);
                    }}
                    placeholder={
                      i === 0
                        ? "e.g. \"Scolds me for wasting money, asks what I needed it for\""
                        : "e.g. \"Insists I sit down and rest before doing anything else\""
                    }
                    className="w-full border border-gray-300 p-2 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() => {
            setSpeechExamples([
              ...speechExamples,
              { phrase: "", context: "", meaning: "", tone: "", reaction: "" },
            ]);
            setShowOptional((prev) => [...prev, false]);
          }}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium"
        >
          + Add another example
        </button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        A moment, a habit, or anything that made them who they were.
        This helps the AI understand their personality beyond words.
      </p>
      <textarea
        value={distinctiveStory}
        onChange={(e) => setDistinctiveStory(e.target.value)}
        placeholder="Tell us something you remember about them..."
        className="w-full border border-gray-300 p-2.5 rounded-lg h-28 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  );

  const stepRenderers = [renderStep0, renderStep1, renderStep2, renderStep3];

  // ---- Render ------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-xl shadow-lg space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Remember someone</h2>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Sign out
        </button>
      </div>

      {/* Existing personas list */}
      <section>
        <h3 className="text-sm font-semibold text-gray-600 mb-2">Your people</h3>
        {listLoading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : existing.length === 0 ? (
          <p className="text-gray-500 text-sm">No one remembered yet. Create one below.</p>
        ) : (
          <ul className="divide-y border border-gray-200 rounded-lg overflow-hidden">
            {existing.map((p) => (
              <li key={p.id} className="flex items-center justify-between p-3 bg-white hover:bg-gray-50">
                <div>
                  <div className="font-medium text-gray-900">{p.name}</div>
                  {p.relationship && (
                    <div className="text-xs text-gray-500">{p.relationship}</div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => startEdit(p)}
                    className="text-sm border border-gray-300 text-gray-700 px-2.5 py-1 rounded-lg hover:bg-gray-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(p)}
                    className="text-sm border border-red-200 text-red-600 px-2.5 py-1 rounded-lg hover:bg-red-50"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelect(p)}
                    className="bg-blue-600 text-white text-sm px-3 py-1 rounded-lg hover:bg-blue-700 font-medium"
                  >
                    Talk
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Form with steps */}
      <section ref={formRef} className="pt-4 border-t">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-gray-900">
            {editingId ? `Edit ${name ? `"${name}"` : "Persona"}` : "Remember someone new"}
          </h3>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel edit
            </button>
          )}
        </div>
        <p className="mb-5 text-gray-500 text-sm">
          {editingId
            ? "Update their details below."
            : "The more you share, the closer their voice will feel."}
        </p>

        {/* Progress indicator */}
        <div className="flex items-center justify-between mb-6 px-2">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex flex-col items-center flex-1">
              <div className="flex items-center w-full">
                {i > 0 && (
                  <div className={`flex-1 h-0.5 ${i <= currentStep ? "bg-blue-600" : "bg-gray-200"}`} />
                )}
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                    i < currentStep
                      ? "bg-blue-600 text-white"
                      : i === currentStep
                        ? "bg-blue-600 text-white ring-2 ring-blue-200"
                        : "bg-gray-200 text-gray-500"
                  }`}
                >
                  {i < currentStep ? "\u2713" : i + 1}
                </div>
                {i < STEP_LABELS.length - 1 && (
                  <div className={`flex-1 h-0.5 ${i < currentStep ? "bg-blue-600" : "bg-gray-200"}`} />
                )}
              </div>
              <span className={`text-[10px] mt-1.5 text-center ${i === currentStep ? "text-blue-600 font-medium" : "text-gray-400"}`}>
                {label}
              </span>
            </div>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Step content */}
          <div className="min-h-[200px]">
            {stepRenderers[currentStep]()}
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              {error}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            <div>
              {currentStep > 0 && (
                <button
                  type="button"
                  onClick={prevStep}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
                >
                  Back
                </button>
              )}
            </div>
            <div className="flex items-center space-x-3">
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  disabled={loading}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
                >
                  Cancel
                </button>
              )}
              {currentStep < 3 ? (
                <button
                  type="button"
                  onClick={nextStep}
                  className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 font-medium text-sm transition-colors"
                >
                  {loading ? "Saving..." : editingId ? "Save changes" : "Remember them"}
                </button>
              )}
            </div>
          </div>
        </form>
      </section>

      <Confirm
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.name ?? "persona"}"?`}
        message="This persona and its conversation history will be removed and cannot be undone."
        onConfirm={() => {
          if (pendingDelete) handleDelete(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
