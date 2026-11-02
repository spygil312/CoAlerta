import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyAh_5tSY-dv--WXuFZk7NI7vJstWeqYSVA",
    authDomain: "coalerta.firebaseapp.com",
    projectId: "coalerta",
    storageBucket: "coalerta.firebasestorage.app",
    messagingSenderId: "209561734566",
    appId: "1:209561734566:web:cd9e5abf1e4f77e478d367"
};

export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

window.auth = auth;
