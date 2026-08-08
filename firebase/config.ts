import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDvpkcGA6TOGkmzd_7y88Hdk46Di3xfStk",
  authDomain: "be-right-back-b47be.firebaseapp.com",
  projectId: "be-right-back-b47be",
  storageBucket: "be-right-back-b47be.appspot.com",
  messaging_sender: "101066195788132532918",
  app_id: "be-right-back-b47be" // Replace with your full App ID from the Firebase Console
};

const app = initializeApp(firebaseConfig);

// Use a named database ("talk-to-the-dead") instead of the default "(default)".
// Must match the database the server-side wrapper in lib/firestore.ts queries.
const DATABASE_ID = "talk-to-the-dead";

export const auth = getAuth(app);
export const db = getFirestore(app, DATABASE_ID);