import {
    GoogleAuthProvider,
    browserLocalPersistence,
    browserSessionPersistence,
    setPersistence,
    signInWithEmailAndPassword,
    signInWithPopup,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const MAX_FAILED_ATTEMPTS = 3;
    const LOCK_DURATION_MS = 3 * 60 * 1000;
    const form = document.getElementById("formLogin");
    const identifierField = document.getElementById("correo");
    const passwordField = document.getElementById("password");
    const rememberCheckbox = document.getElementById("recordarme");
    const loginButton = document.getElementById("btnIniciarSesion");

    restoreRememberedIdentifier();
    configurePasswordVisibility();
    rememberCheckbox.addEventListener("change", function () {
        if (rememberCheckbox.checked) return;
        try {
            localStorage.removeItem("coalerta_correo_recordado");
        } catch (error) {
            console.error("No se pudo borrar el correo recordado:", error);
        }
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        clearMessage();

        const identifier = identifierField.value.trim().toLowerCase();
        const password = passwordField.value;
        if (!identifier || !password) {
            showMessage("Ingresa tu correo electrónico y contraseña.", "error");
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
            showMessage("Para iniciar sesión, ingresa el correo electrónico de tu cuenta.", "error");
            return;
        }

        const lock = getLock(identifier);
        if (lock) {
            showMessage(`Acceso bloqueado por intentos fallidos. Vuelve a intentarlo en ${lock} minuto(s).`, "error");
            return;
        }

        setBusy(true, "Iniciando sesión...");
        let credentialAccepted = false;
        let accountIdentifier = identifier;
        try {
            await configurePersistence();
            const credential = await signInWithEmailAndPassword(auth, identifier, password);
            credentialAccepted = true;
            clearFailedAttempts(identifier);
            const profile = await loadProfile(credential.user);
            if (profile.registrationIncomplete) {
                await signOut(auth);
                showMessage("La cuenta existe, pero no tiene un perfil completado. Completa tu registro desde el formulario de crear cuenta.", "error");
                return;
            }
            if (profile.activo === false) {
                await signOut(auth);
                showMessage("Esta cuenta está inactiva. Contacta con soporte municipal para solicitar su reactivación.", "error");
                return;
            }
            await completeLogin(credential.user, profile);
        } catch (error) {
            console.error("Error al iniciar sesión:", error);
            if (credentialAccepted && auth.currentUser) {
                try {
                    await signOut(auth);
                } catch (signOutError) {
                    console.error("No se pudo cerrar la sesión tras fallar la carga del perfil:", signOutError);
                }
            }
            const failedCredential = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"]
                .includes(error.code);
            const lockMessage = !credentialAccepted && failedCredential
                ? registerFailedAttempt(accountIdentifier)
                : "";
            showMessage(lockMessage || getAuthErrorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    });

    document.getElementById("btnGoogle").addEventListener("click", async function () {
        clearMessage();
        setBusy(true, "Conectando con Google...");
        try {
            await configurePersistence();
            const provider = new GoogleAuthProvider();
            provider.setCustomParameters({ prompt: "select_account" });
            const credential = await signInWithPopup(auth, provider);
            const profileDocument = await getDoc(doc(db, "usuarios", credential.user.uid));
            if (!profileDocument.exists()) {
                window.location.replace("registro.html?origen=google");
                return;
            }
            const googleProfile = profileDocument.data();
            if (!googleProfile.dni) {
                window.location.replace("registro.html?origen=google");
                return;
            }
            const profile = await loadProfile(credential.user);
            if (profile.activo !== true) {
                await signOut(auth);
                showMessage("Esta cuenta está inactiva. Contacta con soporte municipal.", "error");
                return;
            }
            await completeLogin(credential.user, profile);
        } catch (error) {
            if (error.code !== "auth/popup-closed-by-user" &&
                error.code !== "auth/cancelled-popup-request") {
                console.error("Error al iniciar sesión con Google:", error);
                showMessage(getAuthErrorMessage(error), "error");
            }
        } finally {
            setBusy(false);
        }
    });

    async function loadProfile(user) {
        const document = await getDoc(doc(db, "usuarios", user.uid));
        if (!document.exists()) {
            return {
                uid: user.uid,
                correo: user.email || "",
                rol: "vecino",
                registrationIncomplete: true
            };
        }
        const remote = document.exists() ? document.data() : {};
        let local = {};
        try {
            const saved = JSON.parse(localStorage.getItem("coalerta_usuario") || "{}");
            if (saved && saved.uid === user.uid) local = saved;
        } catch (error) {
            console.error("No se pudo leer el perfil local:", error);
        }
        const name = remote.nombre ||
            [remote.nombres, remote.apellidos].filter(Boolean).join(" ") ||
            local.nombre ||
            [local.nombres, local.apellidos].filter(Boolean).join(" ") ||
            user.displayName ||
            (user.email ? user.email.split("@")[0] : "Usuario");
        return {
            ...local,
            ...remote,
            uid: user.uid,
            nombre: name,
            nombres: remote.nombres || local.nombres || name,
            apellidos: remote.apellidos || local.apellidos || "",
            correo: remote.correo || remote.email || user.email || "",
            rol: String(remote.rol || "vecino").trim().toLowerCase()
        };
    }

    function isOperatorRole(role) {
        return ["coordinador", "seguridad", "agente", "administrador", "admin"].includes(
            String(role || "").trim().toLowerCase()
        );
    }

    async function completeLogin(user, profile) {
        try {
            const displayName = profile.nombre || user.displayName || "Usuario";
            if (user.displayName !== displayName) await updateProfile(user, { displayName });
            const localProfile = { ...profile, uid: user.uid };
            delete localProfile.dni;
            delete localProfile.respuestaSeguridadHash;
            delete localProfile.respuestaSeguridadSalt;
            localStorage.setItem("coalerta_usuario", JSON.stringify(localProfile));
            localStorage.setItem("coalertaSesion", "activa");
            if (rememberCheckbox.checked) {
                localStorage.setItem("coalerta_correo_recordado", identifierField.value.trim());
            } else {
                localStorage.removeItem("coalerta_correo_recordado");
            }
        } catch (error) {
            console.error("No se pudo guardar el perfil de sesión:", error);
            throw new Error("La autenticación fue válida, pero no se pudo guardar la sesión en este navegador.");
        }

        const role = String(profile.rol || "").toLowerCase();
        const isOperator = isOperatorRole(role);
        const destination = role === "coordinador"
            ? "coordinador_vecinal.html"
            : isOperator ? "personal_seguridad.html" : "mapa.html";
        window.location.replace(destination);
    }

    function getLock(identifier) {
        try {
            const state = JSON.parse(localStorage.getItem(lockKey(identifier)) || "null");
            if (!state || !state.blockedUntil) return 0;
            const remaining = state.blockedUntil - Date.now();
            if (remaining <= 0) {
                localStorage.removeItem(lockKey(identifier));
                return 0;
            }
            return Math.max(1, Math.ceil(remaining / 60000));
        } catch (error) {
            console.error("No se pudo verificar el bloqueo local de inicio de sesión:", error);
            return 0;
        }
    }

    function registerFailedAttempt(identifier) {
        try {
            const key = lockKey(identifier);
            const state = JSON.parse(localStorage.getItem(key) || '{"failures":0}');
            state.failures = (Number(state.failures) || 0) + 1;
            if (state.failures >= MAX_FAILED_ATTEMPTS) {
                state.blockedUntil = Date.now() + LOCK_DURATION_MS;
                state.failures = 0;
                localStorage.setItem(key, JSON.stringify(state));
                return "Se bloquearon los intentos en este navegador durante 3 minutos tras 3 intentos fallidos.";
            }
            localStorage.setItem(key, JSON.stringify(state));
        } catch (error) {
            console.error("No se pudo guardar el contador local de intentos:", error);
            return "No se pudo verificar el bloqueo de acceso local. Firebase podría aplicar sus propios límites.";
        }
        return "";
    }

    function clearFailedAttempts(identifier) {
        localStorage.removeItem(lockKey(identifier));
    }

    function lockKey(identifier) {
        return `coalertaLoginBloqueo:v2:${String(identifier || "").trim().toLowerCase()}`;
    }

    async function configurePersistence() {
        const persistence = rememberCheckbox.checked
            ? browserLocalPersistence
            : browserSessionPersistence;
        await setPersistence(auth, persistence);
    }

    function restoreRememberedIdentifier() {
        try {
            const saved = localStorage.getItem("coalerta_correo_recordado");
            if (!saved) return;
            identifierField.value = saved;
            rememberCheckbox.checked = true;
        } catch (error) {
            console.error("No se pudo recuperar el usuario recordado:", error);
        }
    }

    function configurePasswordVisibility() {
        document.querySelectorAll(".ver-password").forEach((button) => {
            button.addEventListener("click", function () {
                const show = passwordField.type === "password";
                passwordField.type = show ? "text" : "password";
                button.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
                button.setAttribute("aria-pressed", String(show));
                const icon = button.querySelector("i");
                if (icon) {
                    icon.classList.toggle("fa-eye", !show);
                    icon.classList.toggle("fa-eye-slash", show);
                }
            });
        });
    }

    function setBusy(busy, text) {
        loginButton.disabled = busy;
        loginButton.setAttribute("aria-busy", String(busy));
        const label = loginButton.querySelector("span");
        if (busy) {
            loginButton.dataset.originalText = label.textContent;
            label.textContent = text || "Procesando...";
        } else if (loginButton.dataset.originalText) {
            label.textContent = loginButton.dataset.originalText;
            delete loginButton.dataset.originalText;
        }
        document.getElementById("btnGoogle").disabled = busy;
    }

    function showMessage(text, type) {
        const element = document.getElementById("mensajeLogin");
        element.textContent = text;
        element.classList.remove("error", "correcto");
        element.classList.add(type);
        element.hidden = false;
    }

    function clearMessage() {
        const element = document.getElementById("mensajeLogin");
        element.textContent = "";
        element.classList.remove("error", "correcto");
        element.hidden = true;
    }
});

function getAuthErrorMessage(error) {
    const messages = {
        "auth/invalid-email": "El correo electrónico no tiene un formato válido.",
        "auth/user-disabled": "Esta cuenta está deshabilitada. Contacta con soporte.",
        "auth/user-not-found": "El usuario o la contraseña son incorrectos.",
        "auth/wrong-password": "El usuario o la contraseña son incorrectos.",
        "auth/invalid-credential": "El usuario o la contraseña son incorrectos.",
        "auth/too-many-requests": "Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.",
        "auth/network-request-failed": "No se pudo conectar. Verifica tu conexión a internet.",
        "auth/popup-blocked": "El navegador bloqueó la ventana de Google. Permite ventanas emergentes e inténtalo nuevamente.",
        "auth/popup-closed-by-user": "Se cerró la ventana de Google antes de completar el inicio de sesión.",
        "auth/cancelled-popup-request": "Ya hay una ventana de inicio de sesión abierta. Completa esa solicitud o inténtalo nuevamente.",
        "auth/account-exists-with-different-credential": "Este correo ya está registrado con otro método. Inicia sesión con ese método para acceder a tu cuenta.",
        "auth/operation-not-allowed": "Este método de inicio de sesión no está habilitado en Firebase.",
        "auth/unauthorized-domain": "Este dominio no está autorizado en la configuración de Firebase.",
        "unauthenticated": "La sesión de Firebase expiró. Vuelve a iniciar sesión.",
        "permission-denied": "El perfil no está activo o no tiene permisos. Si el registro quedó incompleto, complétalo desde «Crear cuenta».",
        "unavailable": "Firebase no pudo consultar el perfil por el momento. Revisa tu conexión e inténtalo nuevamente."
    };
    return messages[error.code] || error.message || "No se pudo completar el inicio de sesión. Inténtalo nuevamente.";
}
