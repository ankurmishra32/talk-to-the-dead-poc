import { initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

// Client-side Firebase configuration, loaded from NEXT_PUBLIC_* env vars.
//
// These values are shipped to the browser in the JS bundle, so this is
// deliberately NOT secret material — a Firebase browser API key is public
// by design (the deployed bundle serves it to every visitor). The real
// protection is restricting that key by HTTP referrer in Google Cloud
// Console (see README.md). The server half reads FIREBASE_API_KEY from
// process.env separately in lib/firestore.ts / lib/auth/firebase.server.ts.
//
// The projectId / databaseId defaults mirror lib/firestore.ts so client and
// server stay in sync; override any of them in .env.local to deviate.

const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "be-right-back-b47be.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "be-right-back-b47be",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "be-right-back-b47be.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
};

// During SSR / prerender (typeof window === "undefined") or when the env var
// is not configured (CI builds without .env.local), Firebase is not
// initialized.  Consuming code only accesses auth/db inside useEffect or
// event handlers — never on the server — so null is safe here.  The type
// assertion keeps the export contract unchanged so no downstream files need
// to be updated.
const shouldInit =
  typeof window !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const app = shouldInit ? initializeApp(firebaseConfig) : null;

// Use a named database ("talk-to-the-dead") instead of the default "(default)".
// Must match the database the server-side wrapper in lib/firestore.ts queries.
const DATABASE_ID = "talk-to-the-dead";

// Both `auth` and `db` are exported from this single Firebase app
// initialization. They are imported by the client auth adapter (via
// lib/auth/firebase.client.ts) and by the Firestore-touching components.
// The server bundle never reaches this file because lib/auth/server.ts
// only imports the REST-based server half.
export const auth = (app ? getAuth(app) : null) as Auth;
export const db = (app ? getFirestore(app, DATABASE_ID) : null) as Firestore;
