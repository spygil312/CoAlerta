/* =========================================================
   COALERTA - PERFIL.JS
========================================================= */
import {
    EmailAuthProvider, GoogleAuthProvider, onAuthStateChanged, reauthenticateWithCredential,
    reauthenticateWithPopup, sendEmailVerification, signOut, updateEmail, updateProfile, updatePassword
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const formPerfil = document.getElementById("formPerfil");
    const formPassword = document.getElementById("formPassword");
    const formContactos = document.getElementById("formContactos");
    const formDesactivarCuenta = document.getElementById("formDesactivarCuenta");
    const mensajePerfil = document.getElementById("mensajePerfil");
    const mensajePassword = document.getElementById("mensajePassword");
    const mensajeContactos = document.getElementById("mensajeContactos");
    const mensajeDesactivacion = document.getElementById("mensajeDesactivacion");
    const inputTelefono = document.getElementById("telefono");
    const botonFoto = document.getElementById("btnCambiarFoto");
    const inputFoto = document.getElementById("inputFoto");
    const botonCerrarSesion = document.getElementById("btnCerrarSesion");
    const botonCerrarSesionLateral = document.getElementById("btnCerrarSesionLateral");
    const botonesMostrarPassword = document.querySelectorAll(".ver-password");
    const usuarioGuardado = leerUsuarioGuardado();

    mostrarUsuario(usuarioGuardado);
    configurarPreferencias();
    configurarMostrarContrasenas();
    configurarCierreSesion();

    if (inputTelefono) {
        inputTelefono.addEventListener("input", function () {
            this.value = this.value.replace(/\D/g, "").slice(0, 9);
        });
    }

    if (botonFoto && inputFoto) {
        botonFoto.addEventListener("click", function () {
            inputFoto.click();
        });
        inputFoto.addEventListener("change", guardarFotoPerfil);
    }

    if (formPerfil) {
        formPerfil.addEventListener("submit", guardarPerfil);
    }

    if (formPassword) {
        formPassword.addEventListener("submit", cambiarContrasena);
    }
    if (formContactos) {
        formContactos.addEventListener("submit", guardarContactosEmergencia);
    }
    if (formDesactivarCuenta) {
        formDesactivarCuenta.addEventListener("submit", desactivarCuenta);
    }

    ["contacto1Telefono", "contacto2Telefono", "dniDesactivacion"].forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.addEventListener("input", function () {
            this.value = this.value.replace(/\D/g, "").slice(0, id === "dniDesactivacion" ? 8 : 9);
        });
    });

    onAuthStateChanged(auth, cargarUsuarioAutenticado);

    function leerUsuarioGuardado() {
        try {
            const usuario = JSON.parse(localStorage.getItem("coalerta_usuario") || "{}");
            return usuario && typeof usuario === "object" && !Array.isArray(usuario) ? usuario : {};
        } catch (error) {
            console.error("No se pudieron leer los datos de perfil:", error);
            mostrarMensaje(mensajePerfil, "No se pudieron leer tus datos guardados. Recarga la página para intentarlo nuevamente.", "error");
            return {};
        }
    }

    function guardarUsuarioEnNavegador(usuario) {
        try {
            const perfilLocal = { ...usuario };
            delete perfilLocal.dni;
            delete perfilLocal.respuestaSeguridadHash;
            delete perfilLocal.respuestaSeguridadSalt;
            localStorage.setItem("coalerta_usuario", JSON.stringify(perfilLocal));
        } catch (error) {
            console.error("No se pudieron guardar los datos de perfil:", error);
            throw new Error("No se pudieron guardar los cambios en este navegador. Comprueba el espacio disponible.");
        }
    }

    async function cargarUsuarioAutenticado(usuarioAuth) {
        if (!usuarioAuth) return;

        try {
            const documento = await getDoc(doc(db, "usuarios", usuarioAuth.uid));
            if (!documento.exists()) {
                throw new Error("No se encontró tu perfil en Firebase. Completa el registro antes de continuar.");
            }
            const datosFirestore = documento.data();
            if (datosFirestore.activo === false) {
                await signOut(auth);
                localStorage.removeItem("coalerta_usuario");
                localStorage.removeItem("coalertaSesion");
                window.location.replace("login.html");
                return;
            }
            const usuarioLocalGuardado = leerUsuarioGuardado();
            const correoLocal = String(usuarioLocalGuardado.correo || usuarioLocalGuardado.email || "").trim().toLowerCase();
            const correoAuth = String(usuarioAuth.email || "").trim().toLowerCase();
            const usuarioLocal = usuarioLocalGuardado.uid === usuarioAuth.uid ||
                (correoAuth && correoLocal === correoAuth)
                ? usuarioLocalGuardado
                : {};
            const usuarioActualizado = {
                ...usuarioLocal,
                ...datosFirestore,
                uid: usuarioAuth.uid,
                correo: usuarioAuth.email || datosFirestore.correo || ""
            };

            guardarUsuarioEnNavegador(usuarioActualizado);
            mostrarUsuario(usuarioActualizado);

        } catch (error) {
            console.error("No se pudo sincronizar el perfil con Firebase:", error);
            mostrarMensaje(mensajePerfil, "No se pudieron cargar los datos más recientes desde Firebase. Puedes revisar tu conexión e intentarlo de nuevo.", "error");
        }
    }

    function mostrarUsuario(usuario) {
        const nombres = usuario.nombres || "";
        const apellidos = usuario.apellidos || "";
        const nombreCompleto = usuario.nombre ||
            [nombres, apellidos].filter(Boolean).join(" ") ||
            (usuario.correo ? usuario.correo.split("@")[0] : "Usuario");
        const correo = usuario.correo || usuario.email || "";
        const telefono = usuario.telefono || "";
        const zona = usuario.direccion || usuario.zona || usuario.distrito || "";
        const rol = String(usuario.rol || "vecino").toLowerCase() === "vecino" &&
            usuario.estadoSolicitudRol === "pendiente" && usuario.rolSolicitud
            ? `${mostrarRol(usuario.rolSolicitud)} (pendiente)`
            : mostrarRol(usuario.rol);
        const solicitud = String(usuario.rol || "vecino").toLowerCase() === "vecino" &&
            usuario.estadoSolicitudRol === "pendiente" && usuario.rolSolicitud
            ? "Solicitud pendiente de aprobación. Hasta entonces, tus permisos siguen siendo de vecino."
            : usuario.estadoSolicitudRol === "rechazada"
                ? "Tu solicitud de cambio de rol fue rechazada. Conservas los permisos de vecino."
                : "Usuario registrado en CoAlerta";

        establecerValor("nombres", nombres);
        establecerValor("apellidos", apellidos);
        establecerValor("correo", correo);
        establecerValor("telefono", telefono);
        establecerValor("zona", zona);
        establecerTexto("sidebarNombre", `Hola, ${nombreCompleto.trim().split(/\s+/)[0]}`);
        establecerTexto("sidebarRol", rol);
        establecerTexto("resumenNombre", nombreCompleto);
        establecerTexto("resumenCorreo", correo || "Sin correo registrado");
        establecerTexto("resumenTelefono", telefono || "Sin teléfono registrado");
        establecerTexto("resumenZona", zona || "Sin zona registrada");
        establecerTexto("estadoSolicitudRol", solicitud);
        establecerRol(rol);
        mostrarContactosEmergencia(usuario.contactosEmergencia);
        establecerTexto(
            "preguntaSeguridadActual",
            "El acceso a la cuenta se valida con Firebase usando tu correo y contraseña."
        );
        establecerValor("dniDesactivacion", usuario.dni || "");

        const imagen = usuario.fotoBase64 || usuario.fotoURL || usuario.photoURL;
        if (imagen) mostrarFoto(imagen);
    }

    function mostrarContactosEmergencia(contactos) {
        const lista = Array.isArray(contactos) ? contactos : [];
        [1, 2].forEach((numero, indice) => {
            const contacto = lista[indice] || {};
            establecerValor(`contacto${numero}Nombre`, contacto.nombre || "");
            establecerValor(`contacto${numero}Telefono`, contacto.telefono || "");
        });
    }

    function mostrarRol(rol) {
        const roles = {
            vecino: "Vecino",
            residente: "Vecino",
            "vecino/residente": "Vecino",
            seguridad: "Personal de seguridad",
            coordinador: "Coordinador vecinal",
            administrador: "Administrador",
            admin: "Administrador"
        };
        const valor = String(rol || "Vecino").trim();
        const normalizado = valor.toLocaleLowerCase().replace(/\s*\/\s*/g, "/");
        return roles[normalizado] || valor;
    }

    function establecerValor(id, valor) {
        const campo = document.getElementById(id);
        if (campo) campo.value = valor;
    }

    function establecerTexto(id, texto) {
        const elemento = document.getElementById(id);
        if (elemento) elemento.textContent = texto;
    }

    function establecerRol(rol) {
        const selector = document.getElementById("rol");
        const resumen = document.getElementById("resumenRol");
        if (selector) {
            selector.replaceChildren(new Option(rol, rol, true, true));
        }
        if (resumen) {
            resumen.replaceChildren();
            const icono = document.createElement("i");
            icono.className = "fa-solid fa-user-shield";
            icono.setAttribute("aria-hidden", "true");
            resumen.append(icono, document.createTextNode(` ${rol}`));
        }
    }

    function mostrarFoto(url) {
        [
            ["perfilAvatarImg", "perfilAvatarIcon"],
            ["sidebarAvatarImg", "sidebarAvatarIcon"]
        ].forEach(([imagenId, iconoId]) => {
            const imagen = document.getElementById(imagenId);
            const icono = document.getElementById(iconoId);
            if (!imagen) return;
            imagen.onerror = function () {
                imagen.hidden = true;
                if (icono) icono.hidden = false;
            };
            imagen.src = url;
            imagen.hidden = false;
            if (icono) icono.hidden = true;
        });
    }

    function guardarFotoPerfil(evento) {
        const archivo = evento.target.files && evento.target.files[0];
        if (!archivo) return;
        evento.target.value = "";

        if (!archivo.type.startsWith("image/")) {
            mostrarMensaje(mensajePerfil, "Selecciona un archivo de imagen válido.", "error");
            return;
        }
        if (archivo.size > 1024 * 1024) {
            mostrarMensaje(mensajePerfil, "La foto debe pesar menos de 1 MB para poder guardarse en este dispositivo.", "error");
            return;
        }

        const lector = new FileReader();
        lector.onerror = function () {
            mostrarMensaje(mensajePerfil, "No se pudo leer la foto seleccionada.", "error");
        };
        lector.onload = function () {
            if (typeof lector.result !== "string") {
                mostrarMensaje(mensajePerfil, "El archivo de imagen no se pudo procesar.", "error");
                return;
            }

            const imagen = new Image();
            imagen.onerror = function () {
                mostrarMensaje(mensajePerfil, "No se pudo procesar la imagen seleccionada.", "error");
            };
            imagen.onload = async function () {
                let fotoComprimida;
                try {
                    const lienzo = document.createElement("canvas");
                    const escala = Math.min(1, 360 / Math.max(imagen.naturalWidth, imagen.naturalHeight));
                    lienzo.width = Math.max(1, Math.round(imagen.naturalWidth * escala));
                    lienzo.height = Math.max(1, Math.round(imagen.naturalHeight * escala));
                    const contexto = lienzo.getContext("2d");
                    if (!contexto) throw new Error("El navegador no pudo procesar la foto seleccionada.");
                    contexto.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
                    fotoComprimida = lienzo.toDataURL("image/jpeg", 0.72);
                } catch (error) {
                    console.error("No se pudo comprimir la foto de perfil:", error);
                    mostrarMensaje(mensajePerfil, "El navegador no pudo procesar la foto seleccionada.", "error");
                    return;
                }
                if (fotoComprimida.length > 700000) {
                    mostrarMensaje(mensajePerfil, "La foto no se pudo comprimir a un tamaño seguro. Elige otra imagen.", "error");
                    return;
                }

                const usuario = leerUsuarioGuardado();
                usuario.fotoBase64 = fotoComprimida;
                const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
                if (usuarioAuth) usuario.uid = usuarioAuth.uid;
                let guardadaLocalmente = false;
                try {
                    guardarUsuarioEnNavegador(usuario);
                    guardadaLocalmente = true;
                    if (usuarioAuth) {
                        const perfilActual = window.coalertaData && window.coalertaData.getProfile();
                        if (!perfilActual || !window.coalertaData.isReady()) {
                            throw new Error("El perfil todavía se está conectando con Firebase. Inténtalo nuevamente.");
                        }
                        await updateDoc(doc(db, "usuarios", usuarioAuth.uid), {
                            fotoBase64: fotoComprimida
                        });
                    }
                    mostrarFoto(fotoComprimida);
                    mostrarMensaje(
                        mensajePerfil,
                        usuarioAuth
                            ? "Foto de perfil guardada y sincronizada con tu cuenta."
                            : "Foto de perfil guardada en este dispositivo.",
                        "correcto"
                    );
                } catch (error) {
                    console.error("No se pudo guardar o sincronizar la foto de perfil:", error);
                    mostrarFoto(fotoComprimida);
                    mostrarMensaje(
                        mensajePerfil,
                        guardadaLocalmente
                            ? "La foto quedó guardada en este dispositivo, pero no se pudo sincronizar con tu cuenta. Inténtalo nuevamente con conexión."
                            : "No se pudo guardar la foto en este dispositivo. Comprueba el espacio disponible e inténtalo nuevamente.",
                        "error"
                    );
                }
            };
            imagen.src = lector.result;
        };
        lector.readAsDataURL(archivo);
    }

    async function guardarPerfil(evento) {
        evento.preventDefault();
        limpiarMensaje(mensajePerfil);

        const nombres = document.getElementById("nombres").value.trim();
        const apellidos = document.getElementById("apellidos").value.trim();
        const correo = document.getElementById("correo").value.trim();
        const telefono = document.getElementById("telefono").value.trim();
        const zona = document.getElementById("zona").value.trim();

        if (!nombres || !apellidos || !correo || !telefono || !zona) {
            mostrarMensaje(mensajePerfil, "Completa todos los campos.", "error");
            return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
            mostrarMensaje(mensajePerfil, "Ingresa un correo electrónico válido.", "error");
            return;
        }
        if (!/^\d{9}$/.test(telefono)) {
            mostrarMensaje(mensajePerfil, "El número de celular debe tener 9 dígitos.", "error");
            return;
        }

        const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
        if (!usuarioAuth) {
            mostrarMensaje(mensajePerfil, "Inicia sesión para actualizar tu perfil y sincronizar los cambios con tu cuenta.", "error");
            return;
        }
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            mostrarMensaje(mensajePerfil, "Espera a que el perfil termine de conectarse con Firebase antes de guardar.", "error");
            return;
        }

        const perfilActual = window.coalertaData.getProfile();
        const usuarioAnterior = perfilActual || leerUsuarioGuardado();
        const usuario = {
            ...usuarioAnterior,
            nombres,
            apellidos,
            nombre: `${nombres} ${apellidos}`,
            correo,
            telefono,
            zona,
            direccion: zona,
            distrito: zona
        };
        const correoAnterior = usuarioAuth ? usuarioAuth.email : (usuarioAnterior.correo || usuarioAnterior.email || "");
        let correoAuthActualizado = false;
        let falloVerificacionCorreo = false;
        let falloSincronizacionContactoComunidad = false;

        establecerCargando(formPerfil, true);
        try {
            if (usuarioAuth && correo !== correoAnterior) {
                await reautenticarParaCambioCorreo(usuarioAuth);
                await updateEmail(usuarioAuth, correo);
                await usuarioAuth.getIdToken(true);
                correoAuthActualizado = true;
                try {
                    await sendEmailVerification(usuarioAuth);
                } catch (error) {
                    console.error("No se pudo enviar la verificación del nuevo correo:", error);
                    falloVerificacionCorreo = true;
                }
            }

            if (usuarioAuth) {
                await updateProfile(usuarioAuth, { displayName: usuario.nombre });
                await updateDoc(doc(db, "usuarios", usuarioAuth.uid), {
                    nombres,
                    apellidos,
                    nombre: usuario.nombre,
                    telefono,
                    correo: usuarioAuth.email,
                    direccion: zona,
                    zona,
                    distrito: zona
                });
                usuario.uid = usuarioAuth.uid;
                try {
                    await window.coalertaData.synchronizeCurrentCommunityMemberProfile(usuario);
                } catch (error) {
                    console.error("No se pudo actualizar el contacto del miembro en su comunidad:", error);
                    falloSincronizacionContactoComunidad = true;
                }
            }

            guardarUsuarioEnNavegador(usuario);
            mostrarUsuario(usuario);
            let mensaje = "Tus datos se actualizaron correctamente.";
            if (falloSincronizacionContactoComunidad) {
                mensaje += " El teléfono de tu perfil se guardó, pero no se pudo actualizar en la lista de tu comunidad.";
            }
            if (falloVerificacionCorreo) {
                mensaje += " No se pudo enviar el correo de verificación; solicita uno nuevo desde tu cuenta.";
            }
            mostrarMensaje(
                mensajePerfil,
                mensaje,
                falloVerificacionCorreo || falloSincronizacionContactoComunidad ? "aviso" : "correcto"
            );
        } catch (error) {
            console.error("No se pudieron actualizar los datos de perfil:", error);
            if (correoAuthActualizado && usuarioAuth) {
                usuario.correo = usuarioAuth.email;
                try {
                    guardarUsuarioEnNavegador(usuario);
                } catch (errorLocal) {
                    console.error("No se pudo guardar localmente el correo actualizado:", errorLocal);
                }
                mostrarMensaje(mensajePerfil, "Firebase Auth actualizó el correo, pero no se pudo sincronizar el resto de los datos. Vuelve a intentarlo con conexión.", "error");
                return;
            }
            mostrarMensaje(mensajePerfil, obtenerMensajeErrorPerfil(error), "error");
        } finally {
            establecerCargando(formPerfil, false);
        }
    }

    async function guardarContactosEmergencia(evento) {
        evento.preventDefault();
        limpiarMensaje(mensajeContactos);
        const contactos = [1, 2].map((numero) => ({
            nombre: document.getElementById(`contacto${numero}Nombre`).value.trim(),
            telefono: document.getElementById(`contacto${numero}Telefono`).value.trim()
        }));
        for (const contacto of contactos) {
            if (!contacto.nombre && !contacto.telefono) continue;
            if (!contacto.nombre || !/^\d{9}$/.test(contacto.telefono)) {
                mostrarMensaje(mensajeContactos, "Ingrese nombre y un número celular válido de 9 dígitos para cada contacto.", "error");
                return;
            }
        }
        const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
        if (!usuarioAuth || !window.coalertaData || !window.coalertaData.isReady()) {
            mostrarMensaje(mensajeContactos, "Inicia sesión y espera la conexión con Firebase para guardar los contactos.", "error");
            return;
        }
        const guardados = contactos.filter((contacto) => contacto.nombre && contacto.telefono);
        try {
            await window.coalertaData.saveEmergencyContacts(guardados);
            const usuario = leerUsuarioGuardado();
            usuario.contactosEmergencia = guardados;
            guardarUsuarioEnNavegador(usuario);
            mostrarMensaje(
                mensajeContactos,
                "Contactos guardados. No se envió un SMS de asignación; la integración de mensajería está pendiente.",
                "correcto"
            );
        } catch (error) {
            console.error("No se pudieron guardar los contactos de emergencia:", error);
            mostrarMensaje(mensajeContactos, error.message || "No se pudieron guardar los contactos. Revisa tu conexión e inténtalo nuevamente.", "error");
        }
    }

    async function desactivarCuenta(evento) {
        evento.preventDefault();
        limpiarMensaje(mensajeDesactivacion);
        const dni = document.getElementById("dniDesactivacion").value.trim();
        const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
        if (!/^\d{8}$/.test(dni)) {
            mostrarMensaje(mensajeDesactivacion, "Ingresa un DNI válido de 8 dígitos para confirmar la desactivación.", "error");
            return;
        }
        if (!usuarioAuth || !window.coalertaData || !window.coalertaData.isReady()) {
            mostrarMensaje(mensajeDesactivacion, "Inicia sesión y espera la conexión con Firebase para desactivar la cuenta.", "error");
            return;
        }
        if (!window.confirm("¿Confirmas la desactivación de esta cuenta? La operación cerrará esta sesión.")) return;
        establecerCargando(formDesactivarCuenta, true);
        try {
            await window.coalertaData.deactivateAccount(dni);
            localStorage.removeItem("coalerta_usuario");
            localStorage.removeItem("coalertaSesion");
            await signOut(auth);
            window.location.replace("login.html");
        } catch (error) {
            console.error("No se pudo desactivar la cuenta:", error);
            mostrarMensaje(mensajeDesactivacion, error.message || "No se pudo desactivar la cuenta.", "error");
        } finally {
            establecerCargando(formDesactivarCuenta, false);
        }
    }

    async function reautenticarParaCambioCorreo(usuarioAuth) {
        const proveedores = (usuarioAuth.providerData || []).map((proveedor) => proveedor.providerId);
        if (proveedores.includes("password")) {
            const contrasena = window.prompt("Por seguridad, ingresa tu contraseña actual para cambiar el correo.");
            if (contrasena === null) throw new Error("Cambio de correo cancelado.");
            if (!contrasena) throw new Error("Debes ingresar tu contraseña actual para cambiar el correo.");
            const credential = EmailAuthProvider.credential(usuarioAuth.email, contrasena);
            await reauthenticateWithCredential(usuarioAuth, credential);
            return;
        }
        if (proveedores.includes("google.com")) {
            await reauthenticateWithPopup(usuarioAuth, new GoogleAuthProvider());
            return;
        }
        throw new Error("Tu proveedor de inicio de sesión no permite cambiar el correo desde esta página.");
    }

    function configurarMostrarContrasenas() {
        const ids = ["passwordActual", "passwordNueva", "passwordConfirmar"];
        botonesMostrarPassword.forEach((boton, indice) => {
            const idCampo = boton.dataset.password || ids[indice];
            const campo = document.getElementById(idCampo);
            if (!campo) return;

            boton.dataset.password = idCampo;
            boton.addEventListener("click", function () {
                const mostrar = campo.type === "password";
                campo.type = mostrar ? "text" : "password";
                boton.setAttribute("aria-pressed", String(mostrar));
                boton.setAttribute("aria-label", `${mostrar ? "Ocultar" : "Mostrar"} ${etiquetaContrasena(idCampo)}`);
                const icono = boton.querySelector("i");
                if (icono) {
                    icono.classList.toggle("fa-eye", !mostrar);
                    icono.classList.toggle("fa-eye-slash", mostrar);
                }
            });
        });
    }

    function etiquetaContrasena(id) {
        const etiquetas = {
            passwordActual: "contraseña actual",
            passwordNueva: "nueva contraseña",
            passwordConfirmar: "confirmación de contraseña"
        };
        return etiquetas[id] || "contraseña";
    }

    async function cambiarContrasena(evento) {
        evento.preventDefault();
        limpiarMensaje(mensajePassword);

        const actual = document.getElementById("passwordActual").value;
        const nueva = document.getElementById("passwordNueva").value;
        const confirmar = document.getElementById("passwordConfirmar").value;
        if (!actual || !nueva || !confirmar) {
            mostrarMensaje(mensajePassword, "Completa todos los campos.", "error");
            return;
        }
        if (nueva.length < 8) {
            mostrarMensaje(mensajePassword, "La nueva contraseña debe tener mínimo 8 caracteres.", "error");
            return;
        }
        if (nueva !== confirmar) {
            mostrarMensaje(mensajePassword, "Las nuevas contraseñas no coinciden.", "error");
            return;
        }
        if (actual === nueva) {
            mostrarMensaje(mensajePassword, "La nueva contraseña debe ser diferente a la actual.", "error");
            return;
        }

        const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
        if (!usuarioAuth) {
            mostrarMensaje(mensajePassword, "Inicia sesión con tu cuenta para cambiar la contraseña.", "error");
            return;
        }
        const usaContrasena = (usuarioAuth.providerData || [])
            .some((proveedor) => proveedor.providerId === "password");
        if (!usaContrasena) {
            mostrarMensaje(mensajePassword, "Esta cuenta usa un proveedor externo para iniciar sesión. Cambia la contraseña desde ese proveedor.", "error");
            return;
        }

        establecerCargando(formPassword, true);
        try {
            const credential = EmailAuthProvider.credential(usuarioAuth.email, actual);
            await reauthenticateWithCredential(usuarioAuth, credential);
            await updatePassword(usuarioAuth, nueva);
            formPassword.reset();
            restablecerIconosContrasena();
            mostrarMensaje(mensajePassword, "Contraseña actualizada correctamente.", "correcto");
        } catch (error) {
            console.error("No se pudo cambiar la contraseña:", error);
            mostrarMensaje(mensajePassword, obtenerMensajeErrorContrasena(error), "error");
        } finally {
            establecerCargando(formPassword, false);
        }
    }

    function restablecerIconosContrasena() {
        botonesMostrarPassword.forEach((boton) => {
            const campo = document.getElementById(boton.dataset.password);
            const icono = boton.querySelector("i");
            if (campo) campo.type = "password";
            if (icono) {
                icono.classList.add("fa-eye");
                icono.classList.remove("fa-eye-slash");
            }
            boton.setAttribute("aria-pressed", "false");
        });
    }

    function configurarPreferencias() {
        const controles = {
            alertas: document.getElementById("preferenciaAlertas"),
            sonido: document.getElementById("preferenciaSonido"),
            ubicacion: document.getElementById("preferenciaUbicacion"),
            temaOscuro: document.getElementById("preferenciaTemaOscuro")
        };
        const uid = typeof auth !== "undefined" && auth.currentUser ? auth.currentUser.uid : "";
        const guardadas = uid ? leerPreferenciasLocales(uid) : {};

        const aplicarPreferencias = function (preferencias) {
            Object.entries(controles).forEach(([clave, control]) => {
                if (control && typeof preferencias[clave] === "boolean") {
                    control.checked = preferencias[clave];
                }
            });
        };
        window.addEventListener("coalerta:preferencias-cargadas", (evento) => {
            aplicarPreferencias(evento.detail || {});
        });
        const preferenciasSinTema = { ...guardadas };
        delete preferenciasSinTema.temaOscuro;
        aplicarPreferencias(preferenciasSinTema);

        Object.entries(controles).forEach(([clave, control]) => {
            if (!control) return;
            control.setAttribute("aria-label", {
                alertas: "Activar notificaciones de alertas",
                sonido: "Activar sonido de emergencia",
                ubicacion: "Permitir uso de ubicación",
                temaOscuro: "Activar modo oscuro"
            }[clave]);
            control.addEventListener("change", async function () {
                let guardadasLocalmente = false;
                try {
                    const usuarioAuth = typeof auth !== "undefined" ? auth.currentUser : null;
                    if (!usuarioAuth) throw new Error("Inicia sesión para guardar tus preferencias en tu cuenta.");
                    const actualizadas = leerPreferenciasLocales(usuarioAuth.uid);
                    actualizadas[clave] = control.checked;
                    guardarPreferenciasLocales(usuarioAuth.uid, actualizadas);
                    guardadasLocalmente = true;
                    window.dispatchEvent(new CustomEvent("coalerta:preferencias-cambiadas", {
                        detail: actualizadas
                    }));
                    if (clave === "sonido" && control.checked &&
                        window.coalertaSonidoEmergencia) {
                        window.coalertaSonidoEmergencia.unlock();
                    }
                    if (!window.coalertaData) throw new Error("El servicio de cuenta no está disponible.");
                    await window.coalertaData.savePreferences(actualizadas);
                } catch (error) {
                    console.error("No se pudieron guardar las preferencias:", error);
                    mostrarMensaje(
                        mensajePerfil,
                        guardadasLocalmente
                            ? "Las preferencias se guardaron en este dispositivo, pero no se pudieron sincronizar con tu cuenta."
                            : "No se pudieron guardar tus preferencias en este dispositivo.",
                        "error"
                    );
                }
            });
        });

        const probarSonido = document.getElementById("probarSonidoEmergencia");
        const estadoSonido = document.getElementById("estadoSonidoEmergencia");
        if (probarSonido) {
            probarSonido.addEventListener("click", async () => {
                if (!controles.sonido || !controles.sonido.checked) {
                    if (estadoSonido) estadoSonido.textContent = "Activa el sonido de emergencia para probarlo.";
                    return;
                }
                try {
                    const reproducido = window.coalertaSonidoEmergencia &&
                        await window.coalertaSonidoEmergencia.play();
                    if (estadoSonido) {
                        estadoSonido.textContent = reproducido
                            ? "Sonido de prueba reproducido."
                            : "El navegador no pudo reproducir audio. Revisa el volumen y vuelve a probar.";
                    }
                } catch (error) {
                    console.error("No se pudo reproducir el sonido de prueba:", error);
                    if (estadoSonido) {
                        estadoSonido.textContent =
                            "No se pudo reproducir el sonido. Revisa los permisos y el volumen del navegador.";
                    }
                }
            });
        }
    }

    function preferenceStorageKey(uid) {
        return `coalertaPreferencias:${uid}`;
    }

    function leerPreferenciasLocales(uid) {
        try {
            const raw = localStorage.getItem(preferenceStorageKey(uid)) || "{}";
            const preferences = JSON.parse(raw);
            if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
                throw new Error("Las preferencias guardadas tienen un formato inesperado.");
            }
            return preferences;
        } catch (error) {
            console.error("No se pudieron leer las preferencias guardadas:", error);
            return {};
        }
    }

    function guardarPreferenciasLocales(uid, preferences) {
        localStorage.setItem(preferenceStorageKey(uid), JSON.stringify(preferences));
    }

    function configurarCierreSesion() {
        [botonCerrarSesion, botonCerrarSesionLateral].forEach((boton) => {
            if (!boton) return;
            boton.addEventListener("click", async function () {
                if (!window.confirm("¿Seguro que deseas cerrar sesión?")) return;
                boton.disabled = true;
                try {
                    if (typeof auth !== "undefined" && auth.currentUser) {
                        await signOut(auth);
                    }
                    localStorage.removeItem("coalerta_usuario");
                    localStorage.removeItem("coalertaSesion");
                    window.location.href = "login.html";
                } catch (error) {
                    console.error("No se pudo cerrar la sesión:", error);
                    window.alert("No se pudo cerrar la sesión. Inténtalo nuevamente.");
                    boton.disabled = false;
                }
            });
        });
    }

    function mostrarMensaje(elemento, texto, tipo) {
        if (!elemento) return;
        elemento.replaceChildren();
        elemento.className = `mensaje-perfil ${tipo}`;
        const icono = document.createElement("i");
        icono.className = tipo === "correcto"
            ? "fa-solid fa-circle-check"
            : tipo === "aviso"
                ? "fa-solid fa-circle-info"
                : "fa-solid fa-circle-exclamation";
        icono.setAttribute("aria-hidden", "true");
        elemento.append(icono, document.createTextNode(` ${texto}`));
    }

    function limpiarMensaje(elemento) {
        if (!elemento) return;
        elemento.replaceChildren();
        elemento.className = "mensaje-perfil";
    }

    function establecerCargando(formulario, cargando) {
        if (!formulario) return;
        const boton = formulario.querySelector('button[type="submit"]');
        if (!boton) return;
        if (cargando) {
            boton.dataset.textoOriginal = boton.textContent.trim();
            boton.disabled = true;
            boton.setAttribute("aria-busy", "true");
        } else {
            boton.disabled = false;
            boton.removeAttribute("aria-busy");
        }
    }

    function obtenerMensajeErrorPerfil(error) {
        const mensajeError = String(error.message || "");
        if (mensajeError === "Cambio de correo cancelado." ||
            mensajeError === "Debes ingresar tu contraseña actual para cambiar el correo." ||
            mensajeError.startsWith("Tu proveedor de inicio de sesión")) {
            return mensajeError;
        }
        const mensajes = {
            "auth/wrong-password": "La contraseña actual es incorrecta.",
            "auth/invalid-credential": "No se pudo verificar tu contraseña actual.",
            "auth/email-already-in-use": "Ese correo ya está asociado a otra cuenta.",
            "auth/invalid-email": "El correo electrónico no es válido.",
            "auth/requires-recent-login": "Vuelve a iniciar sesión para cambiar el correo.",
            "auth/network-request-failed": "No se pudo conectar con Firebase. Revisa tu conexión e inténtalo nuevamente.",
            "auth/user-token-expired": "Tu sesión expiró. Vuelve a iniciar sesión e inténtalo nuevamente.",
            "unauthenticated": "Tu sesión expiró. Vuelve a iniciar sesión e inténtalo nuevamente.",
            "permission-denied": "Firebase no permitió actualizar el perfil. Verifica que tu cuenta esté activa y que las reglas de Firestore estén actualizadas.",
            "invalid-argument": mensajeError || "Revisa los datos del perfil e inténtalo nuevamente.",
            "failed-precondition": mensajeError || "No se cumplen los requisitos para actualizar el perfil.",
            "not-found": "No se encontró el perfil o alguno de los datos necesarios para guardar los cambios.",
            "unavailable": "Firebase no está disponible en este momento. Inténtalo nuevamente más tarde.",
            "deadline-exceeded": "Firebase tardó demasiado en guardar los cambios. Revisa tu conexión e inténtalo nuevamente."
        };
        if (mensajes[error.code]) return mensajes[error.code];
        const codigo = String(error.code || "").trim();
        return codigo
            ? `No se pudieron guardar los cambios. Código de error: ${codigo}.`
            : "No se pudieron guardar los cambios. Revisa tu conexión e inténtalo nuevamente.";
    }

    function obtenerMensajeErrorContrasena(error) {
        const mensajes = {
            "auth/wrong-password": "La contraseña actual es incorrecta.",
            "auth/invalid-credential": "La contraseña actual es incorrecta.",
            "auth/weak-password": "La nueva contraseña es demasiado débil.",
            "auth/requires-recent-login": "Vuelve a iniciar sesión y prueba nuevamente.",
            "auth/too-many-requests": "Hubo demasiados intentos. Espera un momento y vuelve a intentarlo."
        };
        return mensajes[error.code] || "No se pudo cambiar la contraseña. Revisa tu conexión e inténtalo nuevamente.";
    }
});
