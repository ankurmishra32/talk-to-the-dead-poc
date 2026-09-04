import { strings } from "../../lib/strings";
import type { FullPersonaProfile } from "../../lib/types";

type Props = {
  personaName: string;
  profile: FullPersonaProfile | null;
  onClose: () => void;
};

/**
 * The collapsible "View profile" panel shown in the chat header. Pure
 * presentational — it just renders a persona's stored attributes.
 */
export default function ProfilePanel({ personaName, profile, onClose }: Props) {
  return (
    <div className="p-4 border-b bg-gray-50 space-y-3.5 text-sm text-gray-800 max-h-96 overflow-y-auto">
      <div className="flex items-center justify-between border-b pb-2">
        <h4 className="font-semibold text-gray-900 flex items-center space-x-2">
          <span>{strings.profile.heading(personaName)}</span>
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-700 underline"
        >
          {strings.common.close}
        </button>
      </div>

      {!profile ? (
        <p className="text-gray-500 text-xs italic">{strings.profile.loading}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {profile.relationship && (
              <div className="bg-white p-2.5 rounded border">
                <span className="text-xs font-semibold text-gray-500 block uppercase tracking-wide">
                  {strings.profile.relationship}
                </span>
                <span className="text-gray-900 font-medium">{profile.relationship}</span>
              </div>
            )}
            {profile.theyCalledYou && (
              <div className="bg-white p-2.5 rounded border">
                <span className="text-xs font-semibold text-gray-500 block uppercase tracking-wide">
                  {strings.profile.theyCalledYou}
                </span>
                <span className="text-gray-900 font-medium">{profile.theyCalledYou}</span>
              </div>
            )}
          </div>

          {profile.languages && profile.languages.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-gray-500 block mb-1 uppercase tracking-wide">
                {strings.profile.languagesSpoken}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {profile.languages.map((l) => (
                  <span key={l} className="text-xs bg-white border px-2.5 py-0.5 rounded text-gray-700 shadow-sm">
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.howTheySpoke && profile.howTheySpoke.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-gray-500 block mb-1 uppercase tracking-wide">
                {strings.profile.generalSpeech}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {profile.howTheySpoke.map((s) => (
                  <span key={s} className="text-xs bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded text-blue-800 font-medium">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.speechExamples && profile.speechExamples.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-gray-500 block mb-1.5 uppercase tracking-wide">
                {strings.profile.distinctiveSpeech}
              </span>
              <div className="space-y-2">
                {profile.speechExamples.map((ex, i) => (
                  <div key={i} className="p-2.5 bg-white border rounded shadow-sm text-xs space-y-1">
                    <div className="font-semibold text-gray-900 text-sm">
                      &ldquo;{ex.phrase}&rdquo;
                    </div>
                    <div className="text-gray-600">
                      <span className="font-semibold text-gray-500">{strings.profile.when}</span> {ex.context}
                    </div>
                    {ex.tone && (
                      <div className="text-gray-600">
                        <span className="font-semibold text-gray-500">{strings.profile.tone}</span> {ex.tone}
                      </div>
                    )}
                    {ex.meaning && (
                      <div className="text-gray-600">
                        <span className="font-semibold text-gray-500">{strings.profile.meaning}</span> {ex.meaning}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {profile.distinctiveStory && (
            <div>
              <span className="text-xs font-semibold text-gray-500 block mb-1 uppercase tracking-wide">
                {strings.profile.memoryOfThem}
              </span>
              <p className="text-xs text-gray-700 bg-white p-2.5 rounded border whitespace-pre-wrap shadow-sm">
                {profile.distinctiveStory}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
