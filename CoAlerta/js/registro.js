import {
    browserLocalPersistence,
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    setPersistence,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const form = document.getElementById("formRegistro");
    const message = document.getElementById("mensajeRegistro");
    const submitButton = form && form.querySelector('button[type="submit"]');

    if (!form) return;
    let activeGoogleUser = null;
    let resolveAuthReady;
    const authReady = new Promise((resolve) => {
        resolveAuthReady = resolve;
    });
    let unsubscribeAuth;
    unsubscribeAuth = onAuthStateChanged(auth, (user) => {
        activeGoogleUser = user && user.providerData.some((provider) => provider.providerId === "google.com")
            ? user
            : null;
        configureGoogleRegistration(activeGoogleUser);
        resolveAuthReady(user);
        if (unsubscribeAuth) unsubscribeAuth();
    }, (error) => {
        console.error("No se pudo comprobar la sesión antes del registro:", error);
        resolveAuthReady(null);
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        clearMessage();

        let data;
        try {
            await authReady;
            data = readAndValidateForm();
        } catch (error) {
            showMessage(error.message, "error");
            return;
        }

        setBusy(submitButton, true);
        try {
            const user = await ensureRegistrationUser(data, activeGoogleUser);
            const profile = createRegistrationProfile(user, data);
            await saveRegistrationProfile(user.uid, profile);
            const localProfile = { ...profile, uid: user.uid, fechaRegistro: new Date().toISOString() };
            delete localProfile.dni;
            localStorage.setItem("coalerta_usuario", JSON.stringify(localProfile));
            localStorage.setItem("coalertaSesion", "activa");

            if (profile.rolSolicitud) {
                const requestedRole = profile.rolSolicitud === "coordinador"
                    ? "Coordinador vecinal"
                    : "Personal de seguridad";
                showMessage(`Cuenta creada. Tu solicitud para ${requestedRole} quedó pendiente de aprobación; mientras tanto, tus permisos son de vecino.`, "correcto");
                window.setTimeout(() => window.location.replace("mapa.html"), 1800);
            } else {
                showMessage("Cuenta creada exitosamente.", "correcto");
                window.setTimeout(() => window.location.replace("mapa.html"), 700);
            }
        } catch (error) {
            console.error("No se pudo completar el registro:", error);
            showMessage(getRegistrationErrorMessage(error), "error");
        } finally {
            setBusy(submitButton, false);
        }
    });

    document.getElementById("telefono").addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, 9);
    });
    document.getElementById("dni").addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, 8);
    });

    document.querySelectorAll(".ver-password").forEach((button) => {
        button.addEventListener("click", function () {
            const field = button.closest(".input-con-icono")?.querySelector("input");
            if (!field) return;
            const show = field.type === "password";
            field.type = show ? "text" : "password";
            button.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
            const icon = button.querySelector("i");
            if (icon) {
                icon.classList.toggle("fa-eye", !show);
                icon.classList.toggle("fa-eye-slash", show);
            }
        });
    });

    function configureGoogleRegistration(user) {
        const googleRegistration = Boolean(user);
        const passwordFields = [
            document.getElementById("password"),
            document.getElementById("confirmarPassword")
        ];
        passwordFields.forEach((field) => {
            const group = field.closest(".grupo-formulario");
            if (group) group.hidden = googleRegistration;
            field.required = !googleRegistration;
            if (googleRegistration) field.value = "";
        });

        const email = document.getElementById("correo");
        if (googleRegistration) {
            email.value = user.email || "";
            email.readOnly = true;
            const nameParts = String(user.displayName || "").trim().split(/\s+/).filter(Boolean);
            const nombres = document.getElementById("nombres");
            const apellidos = document.getElementById("apellidos");
            if (!nombres.value && nameParts.length) nombres.value = nameParts.shift();
            if (!apellidos.value && nameParts.length) apellidos.value = nameParts.join(" ");
        } else {
            email.readOnly = false;
        }

        const googleHelp = document.getElementById("ayudaRegistroGoogle");
        if (googleHelp) googleHelp.hidden = !googleRegistration;
        if (submitButton) {
            const label = submitButton.querySelector("span");
            if (label) label.textContent = googleRegistration ? "Completar registro" : "Crear cuenta";
        }
    }

    async function ensureRegistrationUser(data, googleUser) {
        await setPersistence(auth, browserLocalPersistence);
        const currentUser = auth.currentUser;
        if (googleUser) {
            if (!currentUser || currentUser.uid !== googleUser.uid ||
                String(currentUser.email || "").toLowerCase() !== data.correo) {
                throw new Error("La sesión de Google expiró. Vuelve a iniciar sesión con Google para completar el registro.");
            }
            return currentUser;
        }
        if (currentUser && String(currentUser.email || "").toLowerCase() === data.correo) {
            return currentUser;
        }
        if (currentUser) await signOut(auth);
        try {
            return (await createUserWithEmailAndPassword(auth, data.correo, data.password)).user;
        } catch (error) {
            if (error.code !== "auth/email-already-in-use") throw error;
            return (await signInWithEmailAndPassword(auth, data.correo, data.password)).user;
        }
    }

    function createRegistrationProfile(user, data) {
        return {
            uid: user.uid,
            nombres: data.nombres,
            apellidos: data.apellidos,
            nombre: `${data.nombres} ${data.apellidos}`,
            correo: user.email,
            telefono: data.telefono,
            dni: data.dni,
            direccion: data.direccion,
            distrito: data.direccion,
            zona: data.direccion,
            rol: "vecino",
            ...(data.tipoUsuario !== "vecino"
                ? { rolSolicitud: data.tipoUsuario, estadoSolicitudRol: "pendiente" }
                : {}),
            comunidadId: null,
            activo: true,
            fechaRegistro: serverTimestamp()
        };
    }

    async function saveRegistrationProfile(uid, profile) {
        const userRef = doc(db, "usuarios", uid);
        const dniRef = doc(db, "dni_index", profile.dni);
        await runTransaction(db, async (transaction) => {
            const existingProfile = await transaction.get(userRef);
            if (existingProfile.exists() && existingProfile.data().dni) {
                const error = new Error("La cuenta ya tiene un perfil registrado.");
                error.code = "registration/account-already-exists";
                throw error;
            }
            transaction.set(dniRef, {
                uid,
                createdAt: serverTimestamp()
            });
            transaction.set(userRef, profile);
        });
    }

    function readAndValidateForm() {
        const data = {
            nombres: document.getElementById("nombres").value.trim(),
            apellidos: document.getElementById("apellidos").value.trim(),
            dni: document.getElementById("dni").value.trim(),
            correo: document.getElementById("correo").value.trim().toLowerCase(),
            telefono: document.getElementById("telefono").value.trim(),
            direccion: document.getElementById("zona").value.trim(),
            password: document.getElementById("password").value,
            confirmarPassword: document.getElementById("confirmarPassword").value,
            tipoUsuario: document.getElementById("tipoUsuario").value
        };
        if (!data.nombres || !data.apellidos || !data.dni || !data.correo || !data.telefono ||
            !data.direccion || (!activeGoogleUser && (!data.password || !data.confirmarPassword)) ||
            !data.tipoUsuario ||
            !document.getElementById("terminos").checked) {
            throw new Error("Completa todos los campos y acepta los términos.");
        }
        if (!/^\d{8}$/.test(data.dni)) throw new Error("El DNI debe tener exactamente 8 dígitos.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.correo)) throw new Error("Ingresa un correo válido.");
        if (!/^\d{9}$/.test(data.telefono)) throw new Error("El celular debe tener exactamente 9 dígitos.");
        if (!activeGoogleUser && data.password.length < 8) {
            throw new Error("La contraseña debe tener mínimo 8 caracteres.");
        }
        if (!activeGoogleUser && data.password !== data.confirmarPassword) {
            throw new Error("Las contraseñas no coinciden.");
        }
        return data;
    }

    function setBusy(button, busy) {
        if (button) button.disabled = busy;
    }

    function getRegistrationErrorMessage(error) {
        const messages = {
            "auth/email-already-in-use": "Ese correo ya tiene una cuenta. Inicia sesión o usa la recuperación de contraseña.",
            "auth/invalid-email": "El correo electrónico no tiene un formato válido.",
            "auth/weak-password": "La contraseña debe tener al menos 8 caracteres.",
            "already-exists": "El DNI ya está registrado o esta cuenta ya completó su perfil.",
            "registration/account-already-exists": "Esta cuenta ya tiene un perfil registrado. Inicia sesión con tu correo y contraseña.",
            "permission-denied": "No se pudo guardar el registro. Es posible que el DNI ya esté registrado o que las reglas de Firestore aún no estén actualizadas."
        };
        return messages[error.code] || error.message || "No se pudo completar el registro. Inténtalo nuevamente.";
    }

    function showMessage(text, type) {
        message.textContent = text;
        message.className = "mensaje-registro " + type;
    }

    function clearMessage() {
        message.textContent = "";
        message.className = "mensaje-registro";
    }
});
