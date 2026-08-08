import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "../firebase/config";
import PersonaSelection from "../components/PersonaSelection";
import Chat from "../components/Chat";

type Persona = {
  id: string;
  name: string;
};

export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push("/");
      } else {
        setUser(currentUser);
      }
    });

    return () => unsubscribe();
  }, [router]);

  if (!user) {
    return (
      <div className="p-6">
        <p>Loading…</p>
      </div>
    );
  }

  if (!persona) {
    return (
      <div className="p-6">
        <PersonaSelection onSelect={setPersona} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <Chat
        persona={persona}
        user={{ uid: user.uid }}
        onBack={() => setPersona(null)}
      />
    </div>
  );
}
