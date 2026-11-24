import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });

export const gmailAuthProvider = new GoogleAuthProvider();
gmailAuthProvider.addScope(GMAIL_SEND_SCOPE);
gmailAuthProvider.setCustomParameters({
  prompt: 'consent select_account',
});
