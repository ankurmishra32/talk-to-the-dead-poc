import { strings } from "../../lib/strings";
import type { FullPersonaProfile } from "../../lib/types";

type Props = {
  personaName: string;
  profile: FullPersonaProfile | null;
  onClose: () => void;
};

export default function ProfilePanel({ personaName, profile, onClose }: Props) {
  const chip = (text: string, variant?: "default" | "accent") => (
    <span
      className="text-xs px-3 py-1 rounded-xl font-medium border"
      style={
        variant === "accent"
          ? { background: "var(--color-brand-light)", borderColor: "transparent", color: "var(--color-brand)" }
          : { background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }
      }
    >
      {text}
    </span>
  );

  const labelCls = "text-xs font-semibold uppercase tracking-wider block mb-1.5";

  return (
    <div className="px-6 py-5 border-b space-y-4 text-sm overflow-y-auto" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", maxHeight: "24rem" }}>
      <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--color-border)" }}>
        <h4 className="font-semibold" style={{ color: "var(--color-text-primary)" }}>
          {strings.profile.heading(personaName)}
        </h4>
        <button type="button" onClick={onClose} className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
          {strings.common.close}
        </button>
      </div>

      {!profile ? (
        <p className="text-xs italic" style={{ color: "var(--color-text-muted)" }}>{strings.profile.loading}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {profile.relationship && (
              <div className="p-3 rounded-2xl border" style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)" }}>
                <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.relationship}</span>
                <span className="font-medium" style={{ color: "var(--color-text-primary)" }}>{profile.relationship}</span>
              </div>
            )}
            {profile.theyCalledYou && (
              <div className="p-3 rounded-2xl border" style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)" }}>
                <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.theyCalledYou}</span>
                <span className="font-medium" style={{ color: "var(--color-text-primary)" }}>{profile.theyCalledYou}</span>
              </div>
            )}
          </div>

          {profile.languages && profile.languages.length > 0 && (
            <div>
              <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.languagesSpoken}</span>
              <div className="flex flex-wrap gap-1.5">{profile.languages.map((l) => chip(l))}</div>
            </div>
          )}

          {profile.howTheySpoke && profile.howTheySpoke.length > 0 && (
            <div>
              <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.generalSpeech}</span>
              <div className="flex flex-wrap gap-1.5">{profile.howTheySpoke.map((s) => chip(s, "accent"))}</div>
            </div>
          )}

          {profile.speechExamples && profile.speechExamples.length > 0 && (
            <div>
              <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.distinctiveSpeech}</span>
              <div className="space-y-2">
                {profile.speechExamples.map((ex, i) => (
                  <div key={i} className="p-3 rounded-2xl border space-y-1" style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)" }}>
                    <div className="font-semibold text-sm" style={{ color: "var(--color-text-primary)" }}>&ldquo;{ex.phrase}&rdquo;</div>
                    <div className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                      <span className="font-semibold" style={{ color: "var(--color-text-muted)" }}>{strings.profile.when}</span> {ex.context}
                    </div>
                    {ex.tone && (
                      <div className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                        <span className="font-semibold" style={{ color: "var(--color-text-muted)" }}>{strings.profile.tone}</span> {ex.tone}
                      </div>
                    )}
                    {ex.meaning && (
                      <div className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                        <span className="font-semibold" style={{ color: "var(--color-text-muted)" }}>{strings.profile.meaning}</span> {ex.meaning}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {profile.distinctiveStory && (
            <div>
              <span className={labelCls} style={{ color: "var(--color-text-muted)" }}>{strings.profile.memoryOfThem}</span>
              <p className="text-xs leading-relaxed p-3 rounded-2xl border whitespace-pre-wrap" style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                {profile.distinctiveStory}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
