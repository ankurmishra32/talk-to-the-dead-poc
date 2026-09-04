import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/auth/useAuth";
import type { AuthUser } from "../lib/auth";
import PersonaSelection from "../components/PersonaSelection";
import Chat from "../components/Chat";

type Persona = {
  id: string;
  name: string;
};

export default function Dashboard() {
  const { user, loading } = useAuth();
  const [persona, setPersona] = useState<Persona | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [user, loading, router]);

  if (loading || !user) {
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
        user={toChatUser(user)}
        onBack={() => setPersona(null)}
      />
    </div>
  );
}

// Chat expects { uid: string }. useAuth returns an AuthUser with the
// same shape plus an optional email. Map it down so the component's
// prop contract is preserved.
function toChatUser(u: AuthUser): { uid: string } {
  return { uid: u.uid };
}
