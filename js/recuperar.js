import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const form = document.getElementById("formRecuperar");
    const emailField = document.getElementById("correoRecuperacion");
    const button = document.getElementById("btnRecuperar");
    const message = document.getElementById("mensajeRecuperar");

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const correo = emailField.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
            showMessage("Ingresa un correo electrónico válido.", "error");
            return;
        }

        button.disabled = true;
        try {
            await sendPasswordResetEmail(auth, correo, {
                url: new URL("login.html", window.location.href).href,
                handleCodeInApp: false
            });
            showMessage("Si existe una cuenta con ese correo, recibirás un enlace para crear una contraseña nueva. Revisa tu correo.", "correcto");
        } catch (error) {
            console.error("No se pudo solicitar la recuperación de contraseña:", error);
            if (error.code === "auth/user-not-found") {
                showMessage("Si existe una cuenta con ese correo, recibirás un enlace para crear una contraseña nueva. Revisa tu correo.", "correcto");
            } else if (error.code === "auth/too-many-requests") {
                showMessage("Hubo demasiadas solicitudes. Espera un momento e inténtalo nuevamente.", "error");
            } else {
                showMessage(error.message || "No se pudo solicitar el enlace. Comprueba tu conexión e inténtalo nuevamente.", "error");
            }
        } finally {
            button.disabled = false;
        }
    });

    function showMessage(text, type) {
        message.textContent = text;
        message.classList.remove("error", "correcto");
        message.classList.add(type);
        message.hidden = false;
    }
});
