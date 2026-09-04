import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase/config";

export type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  phone: string | null;
  onboardingHint: string | null;
  createdAt: unknown;
};

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

export async function createUserProfile(data: {
  uid: string;
  email: string;
  displayName: string;
  phone?: string;
  onboardingHint?: string;
}): Promise<void> {
  await setDoc(doc(db, "users", data.uid), {
    uid: data.uid,
    email: data.email,
    displayName: data.displayName,
    phone: data.phone || null,
    onboardingHint: data.onboardingHint || null,
    createdAt: serverTimestamp(),
  } satisfies UserProfile);
}
