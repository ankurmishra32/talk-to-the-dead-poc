// Client-side auth factory. Imported by React components and pages.
// Pulls in the Firebase JS SDK via firebase.config.ts and
// firebase.client.ts. The server bundle does not load this file.
//
// Selection is env-var driven. NEXT_PUBLIC_AUTH_PROVIDER must be set
// in the build environment. Default: "firebase".

import type { AuthAdapter } from "./types";
import { firebaseAuthClient } from "./firebase.client";

const PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER || "firebase";

function getAuthClient(): AuthAdapter {
  switch (PROVIDER) {
    case "firebase":
      return firebaseAuthClient;
    default:
      throw new Error(
        `Unknown NEXT_PUBLIC_AUTH_PROVIDER: "${PROVIDER}". ` +
          `Supported values: firebase.`
      );
  }
}

export const authAdapter: AuthAdapter = getAuthClient();
