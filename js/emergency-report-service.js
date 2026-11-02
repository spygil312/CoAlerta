import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection, doc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

export async function submitEmergencyReport(lat, lng) {
    let user = auth.currentUser;
    if (!user) {
        const credential = await signInAnonymously(auth);
        user = credential.user;
    }

    const batch = writeBatch(db);
    const alertRef = doc(collection(db, "alertas"));
    const throttleRef = doc(db, "limites_alertas_abiertas", user.uid);
    batch.set(alertRef, {
        tipo: "alerta_abierta",
        comunidadId: null,
        ubicacion: { lat, lng },
        creadorId: user.uid,
        timestamp: serverTimestamp(),
        estado: "pendiente"
    });
    batch.set(throttleRef, {
        uid: user.uid,
        ultimaAlertaAt: serverTimestamp()
    });
    await batch.commit();
}
