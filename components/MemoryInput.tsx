import { useState } from "react";
import { collection, addDoc, Timestamp } from "firebase/firestore";
import { db } from "../firebase/config";

type Persona = { id: string; name?: string };

export default function MemoryInput({
  user,
  persona,
}: {
  user: { uid: string };
  persona?: Persona;
}) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    await addDoc(collection(db, "memories"), {
      userId: user.uid,
      personaId: persona?.id ?? null,
      text,
      createdAt: Timestamp.now(),
    });

    setText("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <textarea
        className="w-full border p-2 rounded"
        placeholder={
          persona?.name
            ? `Write a memory for ${persona.name}…`
            : "Write a memory here…"
        }
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center justify-between">
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          type="submit"
        >
          Save Memory
        </button>
        {saved && <span className="text-sm text-green-600">Saved.</span>}
      </div>
    </form>
  );
}