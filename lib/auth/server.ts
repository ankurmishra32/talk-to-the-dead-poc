// Server-side auth factory. Imported by API routes. Does NOT pull in
// the Firebase JS SDK — only the REST-based server half.
//
// Selection is env-var driven. AUTH_PROVIDER (no NEXT_PUBLIC_ prefix
// because this is server-only) must be set in the deployment
// environment. Default: "firebase".

import type { AuthAdapter } from "./types";
import { firebaseAuthServer } from "./firebase.server";

const PROVIDER = process.env.AUTH_PROVIDER || "firebase";

function getAuthServer(): AuthAdapter {
  switch (PROVIDER) {
    case "firebase":
      return firebaseAuthServer;
    default:
      throw new Error(
        `Unknown AUTH_PROVIDER: "${PROVIDER}". Supported values: firebase.`
      );
  }
}

export const authAdapter: AuthAdapter = getAuthServer();
