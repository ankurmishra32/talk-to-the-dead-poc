import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/auth/useAuth";
import type { AuthUser } from "../lib/auth";
import { getUserProfile } from "../lib/users";
import PersonaSelection from "../components/PersonaSelection";
import Chat from "../components/Chat";
import { strings } from "../lib/strings";
import { createLogger } from "../lib/logger";

const logger = createLogger("Dashboard");

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

  useEffect(() => {
    if (loading || !user) return;
    getUserProfile(user.uid)
      .then((profile) => {
        if (!profile) router.replace("/signup");
      })
      .catch((err) => {
        // Don't bounce the user on a transient read failure; the guard
        // re-runs on the next auth change / page load.
        logger.error("Profile lookup failed", err);
      });
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--color-surface)" }}>
        <p style={{ color: "var(--color-text-muted)" }}>{strings.dashboard.loading}</p>
      </div>
    );
  }

  if (!persona) {
    return (
      <div className="min-h-screen py-8" style={{ background: "var(--color-surface)" }}>
        <PersonaSelection onSelect={setPersona} />
      </div>
    );
  }

  return (
    <div className="min-h-screen py-6 px-4" style={{ background: "var(--color-surface)" }}>
      {/* key: a fresh Chat per persona, so in-flight state (e.g. a stopped
          reply) can't leak into the next persona's conversation. */}
      <Chat
        key={persona.id}
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
