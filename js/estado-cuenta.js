import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    let unsubscribe = null;

    onAuthStateChanged(auth, function (user) {
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        if (!user) return;

        unsubscribe = onSnapshot(doc(db, "usuarios", user.uid), async function (document) {
            if (!document.exists() || document.data().activo !== false) return;
            try {
                localStorage.removeItem("coalerta_usuario");
                localStorage.removeItem("coalertaSesion");
                await signOut(auth);
            } catch (error) {
                console.error("No se pudo cerrar la sesión de una cuenta inactiva:", error);
            } finally {
                window.location.replace("login.html");
            }
        }, function (error) {
            console.error("No se pudo comprobar el estado de la cuenta en Firebase:", error);
            mostrarAvisoEstadoCuenta();
        });
    });

    function mostrarAvisoEstadoCuenta() {
        if (document.getElementById("avisoEstadoCuenta")) return;
        const aviso = document.createElement("div");
        aviso.id = "avisoEstadoCuenta";
        aviso.setAttribute("role", "alert");
        aviso.textContent = "No se pudo confirmar el estado de tu cuenta con Firebase. Comprueba tu conexión antes de continuar.";
        Object.assign(aviso.style, {
            position: "fixed",
            left: "12px",
            right: "12px",
            bottom: "12px",
            zIndex: "20000",
            padding: "12px",
            borderRadius: "10px",
            background: "#fff1d6",
            color: "#62460f",
            fontSize: "13px",
            boxShadow: "0 4px 18px rgba(0,0,0,.15)"
        });
        document.body.append(aviso);
    }
});
