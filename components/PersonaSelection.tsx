import { useEffect, useState } from "react";
import { db } from "../firebase/config";
import { auth } from "../firebase/config";
import { collection, addDoc, getDocs, query, orderBy, limit } from "firebase/firestore";
import { signOut, onAuthStateChanged } from "firebase/auth";

type Persona = {
  id: string;
  name: string;
};

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

export default function PersonaSelection({ onSelect }: { onSelect: (personaData: Persona) => void }) {
  // Existing personas list (scoped to current user via client-side filter).
  const [existing, setExisting] = useState<Persona[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  // Form state.
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState<string>("");
  const [theyCalledYou, setTheyCalledYou] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [howTheySpoke, setHowTheySpoke] = useState<string[]>([]);
  const [oftenSaid, setOftenSaid] = useState<string[]>(["", ""]);
  const [distinctiveStory, setDistinctiveStory] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track current user so we can scope the persona list per-user.
  // (Firestore rules are the proper enforcement — this is just a UX filter.)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUserId(u?.uid ?? null));
    return () => unsub();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const q = query(collection(db, "personas"), orderBy("createdAt", "desc"), limit(50));
        const snap = await getDocs(q);
        if (cancelled) return;
        // Load with ownerId, filter to current user, then strip ownerId
        // before storing in state — we only need id/name for the UI list.
        type WithOwner = { id: string; name: string; ownerId: string | null };
        const items: Persona[] = snap.docs
          .map((d): WithOwner => {
            const data = d.data() as { name?: string; userId?: string };
            return {
              id: d.id,
              name: data.name ?? "(unnamed)",
              ownerId: data.userId ?? null,
            };
          })
          // Filter client-side to the current user. We do this rather than
          // a `where("userId","==",uid)` query because the composite index
          // it would require (userId, createdAt) isn't worth creating for a
          // PoC. The /api/chat route enforces ownership at the server; this
          // is just a UX filter.
          .filter((p) => userId !== null && p.ownerId === userId)
          .map(({ id, name }) => ({ id, name }));
        setExisting(items);
      } catch (err) {
        console.error("Error loading personas:", err);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }
    if (userId !== null) load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggleFromArray = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) {
      setError("You must be signed in to create a persona.");
      return;
    }
    setLoading(true);
    setError(null);

    // Clean up the "things they often said" array — drop empties, trim whitespace.
    const cleanOftenSaid = oftenSaid.map((s) => s.trim()).filter(Boolean);

    try {
      const docRef = await addDoc(collection(db, "personas"), {
        name: name.trim(),
        relationship: relationship || null,
        theyCalledYou: theyCalledYou.trim() || null,
        languages,
        howTheySpoke,
        oftenSaid: cleanOftenSaid,
        distinctiveStory: distinctiveStory.trim() || null,
        // Legacy field — empty for new personas. Kept so the prompt builder
        // and the older API contract don't break.
        traits: "",
        userId,
        createdAt: new Date(),
      });
      onSelect({ id: docRef.id, name: name.trim() });
    } catch (err) {
      console.error("Error creating persona:", err);
      setError(err instanceof Error ? err.message : "Failed to create persona.");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Sign out failed:", err);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded shadow space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Remember someone</h2>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 underline hover:text-gray-700"
        >
          Sign out
        </button>
      </div>

      <section>
        <h3 className="text-sm font-semibold text-gray-600 mb-2">Your people</h3>
        {listLoading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : existing.length === 0 ? (
          <p className="text-gray-500 text-sm">No one remembered yet. Create one below.</p>
        ) : (
          <ul className="divide-y border rounded">
            {existing.map((p) => (
              <li key={p.id} className="flex items-center justify-between p-3">
                <div className="font-medium truncate">{p.name}</div>
                <button
                  onClick={() => onSelect(p)}
                  className="ml-3 flex-shrink-0 bg-blue-600 text-white text-sm px-3 py-1 rounded hover:bg-blue-700"
                >
                  Talk →
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-gray-600 mb-2">Or remember someone new</h3>
        <p className="mb-4 text-gray-600 text-sm">
          Tell us about the person you want to talk to. The more you share, the closer their voice will feel.
        </p>
        <form onSubmit={handleCreate} className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1">What did you call them?</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Papa, Dadi, Joe"
              className="w-full border p-2 rounded"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Who were they to you?</label>
            <select
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              className="w-full border p-2 rounded bg-white"
            >
              <option value="">Choose…</option>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">What did they call you?</label>
            <input
              type="text"
              value={theyCalledYou}
              onChange={(e) => setTheyCalledYou(e.target.value)}
              placeholder="e.g. beta, bachcha, kid"
              className="w-full border p-2 rounded"
            />
          </div>

          <div>
            <span className="block text-sm font-medium mb-2">Languages they spoke</span>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => {
                const on = languages.includes(lang);
                return (
                  <button
                    type="button"
                    key={lang}
                    onClick={() => setLanguages(toggleFromArray(languages, lang))}
                    className={`px-3 py-1 rounded border text-sm ${
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
            <span className="block text-sm font-medium mb-2">How did they usually speak?</span>
            <div className="flex flex-wrap gap-2">
              {SPEECH_STYLES.map((style) => {
                const on = howTheySpoke.includes(style);
                return (
                  <button
                    type="button"
                    key={style}
                    onClick={() => setHowTheySpoke(toggleFromArray(howTheySpoke, style))}
                    className={`px-3 py-1 rounded border text-sm ${
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

          <div>
            <label className="block text-sm font-medium mb-1">What did they often say?</label>
            <div className="space-y-2">
              {oftenSaid.map((q, i) => (
                <input
                  key={i}
                  type="text"
                  value={q}
                  onChange={(e) => {
                    const next = [...oftenSaid];
                    next[i] = e.target.value;
                    setOftenSaid(next);
                  }}
                  placeholder={`e.g. ${i === 0 ? '"Khana kha liya?"' : '"Paise ped pe nahi ugte."'}`}
                  className="w-full border p-2 rounded"
                />
              ))}
              <button
                type="button"
                onClick={() => setOftenSaid([...oftenSaid, ""])}
                className="text-sm text-blue-600 hover:underline"
              >
                + Add another
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">A memory of them</label>
            <textarea
              value={distinctiveStory}
              onChange={(e) => setDistinctiveStory(e.target.value)}
              placeholder="Tell us something you remember about them — a moment, a habit, anything that made them who they were."
              className="w-full border p-2 rounded h-28"
            />
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {loading ? "Saving…" : "Remember them"}
          </button>
        </form>
      </section>
    </div>
  );
}
