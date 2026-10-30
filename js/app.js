import {
    GoogleAuthProvider,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signInWithPopup,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

/* =========================================================
   COALERTA - APP.JS (global)
========================================================= */
document.addEventListener("DOMContentLoaded", function () {

    /* =====================================================
       MENÚ MOBILE - INDEX
    ====================================================== */
    const btnMenu = document.getElementById("btnMenu");
    const menuMobile = document.getElementById("menuMobile");

    if (btnMenu && menuMobile) {
        btnMenu.addEventListener("click", function () {
            menuMobile.classList.toggle("mostrar");
        });

        const enlacesMenuMobile = menuMobile.querySelectorAll("a");
        enlacesMenuMobile.forEach(function (enlace) {
            enlace.addEventListener("click", function () {
                menuMobile.classList.remove("mostrar");
            });
        });
    }

    /* =====================================================
       MOSTRAR / OCULTAR CONTRASEÑAS
    ====================================================== */
    const botonesPassword = document.querySelectorAll(".ver-password");

    botonesPassword.forEach(function (boton) {
        boton.addEventListener("click", function (e) {
            e.preventDefault();
            let input = null;

            /* Para perfil.html */
            const idDesdeData = boton.dataset.password;

            if (idDesdeData) {
                input = document.getElementById(idDesdeData);
            }

            /* Para login.html y registro.html */
            if (!input) {
                const contenedor = boton.closest(".input-con-icono");
                if (contenedor) {
                    input = contenedor.querySelector( 
                        'input[type="password"], input[type="text"]');
                }
            }
            if (!input) return;

            const icono = boton.querySelector("i");

            if (input.type === "password") {
                input.type = "text";
                if (icono) {
                    icono.classList.remove("fa-eye");
                    icono.classList.add("fa-eye-slash");
                }
            } else {
                input.type = "password";
                if (icono) {
                    icono.classList.remove("fa-eye-slash");
                    icono.classList.add("fa-eye");
                }
            }
        });
    });

    /* =====================================================
       LOGIN
    ====================================================== */
    const formLogin = document.getElementById("formLogin");
        if (formLogin) {
            formLogin.addEventListener("submit", function (event) {
                event.preventDefault();

                const correo = document.getElementById("correo")?.value.trim();
                const password = document.getElementById("password")?.value.trim();

                if (!correo || !password) {
                    alert("Por favor completa todos los campos.");
                    return;
                }

                // Iniciar sesión formalmente en Firebase Auth
                signInWithEmailAndPassword(auth, correo, password)
                    .then(async (userCredential) => {
                        const user = userCredential.user;
                        
                        // Obtener los datos reales del usuario desde Firestore
                        const userDoc = await getDoc(doc(db, "usuarios", user.uid));
                        
                        if (userDoc.exists()) {
                            const datosUsuario = { uid: user.uid, ...userDoc.data() };
                            // Guardar en el localStorage con la clave unificada que lee comunidad.js
                            localStorage.setItem("coalerta_usuario", JSON.stringify(datosUsuario));
                        }

                        localStorage.setItem("coalertaSesion", "activa");
                        // Redirigir según sea el flujo
                        window.location.href = "../pages/mapa.html";
                    })
                    .catch((error) => {
                        console.error("Error al iniciar sesión:", error);
                        let mensajeError = "Correo o contraseña incorrectos.";
                        if (error.code === "auth/user-not-found") mensajeError = "No existe una cuenta registrada con este correo.";
                        if (error.code === "auth/wrong-password") mensajeError = "Contraseña incorrecta.";
                        alert(mensajeError);
                    });
            });
        }

    /* =====================================================
       REGISTRO
    ====================================================== */
    const formRegistro = document.getElementById("formRegistro");

    if (formRegistro) {
        formRegistro.addEventListener("submit", function (event) {
            event.preventDefault();

            const nombres = document.getElementById("nombres")?.value.trim();
            const apellidos = document.getElementById("apellidos")?.value.trim();
            const correo = document.getElementById("correo")?.value.trim();
            const telefono = document.getElementById("telefono")?.value.trim();
            const rol = document.getElementById("rol")?.value;
            const zona = document.getElementById("zona")?.value.trim();
            const password = document.getElementById("password")?.value;
            const confirmarPassword = document.getElementById("confirmarPassword")?.value;
            const terminos = document.getElementById("terminos")?.checked;
            const mensajeRegistro = document.getElementById("mensajeRegistro");
            limpiarMensaje(mensajeRegistro);

            if (!nombres || !apellidos || !correo || !telefono || !rol || !zona || 
                !password || !confirmarPassword) {
                mostrarMensaje(mensajeRegistro, "Por favor completa todos los campos.", "error");
                return;
            }

            if (!validarCorreo(correo)) {
                mostrarMensaje(mensajeRegistro, "Ingresa un correo electrónico válido.", "error");
                return;
            }

            if (!/^[0-9]{9}$/.test(telefono)) {
                mostrarMensaje(mensajeRegistro, "El número de celular debe tener 9 dígitos.", "error");
                return;
            }

            if (password.length < 8) {
                mostrarMensaje(mensajeRegistro, "La contraseña debe tener mínimo 8 caracteres.", "error");
                return;
            }

            if (password !== confirmarPassword) {
                mostrarMensaje(mensajeRegistro, "Las contraseñas no coinciden.", "error");
                return;
            }

            if (!terminos) {
                mostrarMensaje(mensajeRegistro, "Debes aceptar los términos y condiciones.", "error");
                return;
            }

            // CREAR CUENTA REAL EN FIREBASE AUTH
            createUserWithEmailAndPassword(auth, correo, password)
                .then(async (userCredential) => {
                    const user = userCredential.user;

                    const nuevoUsuario = {
                        uid: user.uid,
                        nombres: nombres,
                        apellidos: apellidos,
                        nombre: `${nombres} ${apellidos}`,
                        correo: correo,
                        telefono: telefono,
                        rol: rol,
                        distrito: zona,
                        comunidadId: "comunidad_general_1", // Asignación por defecto
                        fechaRegistro: serverTimestamp()
                    };

                    // Guardar los datos en la base de datos real (Firestore)
                    await setDoc(doc(db, "usuarios", user.uid), nuevoUsuario);

                    // Guardar también en localStorage para el flujo local
                    localStorage.setItem("coalerta_usuario", JSON.stringify(nuevoUsuario));

                    mostrarMensaje(mensajeRegistro, "Cuenta creada correctamente.", "correcto");

                    setTimeout(function () {
                        window.location.href = "login.html";
                    }, 1200);
                })
                .catch((error) => {
                    console.error("Error al registrar:", error);
                    let mensajeError = "Error al crear la cuenta.";
                    if (error.code === "auth/email-already-in-use") mensajeError = "El correo ya está registrado.";
                    mostrarMensaje(mensajeRegistro, mensajeError, "error");
                });
        });
    }

    /* =====================================================
       SOLO NÚMEROS EN TELÉFONO
    ====================================================== */
    const telefono = document.getElementById("telefono");

    if (telefono) {
        telefono.addEventListener("input", function () {
            this.value = this.value.replace(/[^0-9]/g, "");
        });
    }

    /* =====================================================
       CARGAR USUARIO EN PERFIL / SIDEBAR
    ====================================================== */
    cargarUsuarioGuardado();

    /* =====================================================
       PERFIL
    ====================================================== */
    const formPerfil = document.getElementById("formPerfil");

    if (formPerfil) {
        formPerfil.addEventListener("submit", function (event) {
            event.preventDefault();

            const nombres = document.getElementById("nombres")?.value.trim();
            const apellidos =document.getElementById("apellidos")?.value.trim();
            const correo = document.getElementById("correo")?.value.trim();
            const telefono = document.getElementById("telefono")?.value.trim();
            const zona = document.getElementById("zona")?.value.trim();

            if (!nombres || !apellidos || !correo || !telefono || !zona) {
                alert("Completa todos los campos.");
                return;
            }

            if (!validarCorreo(correo)) {
                alert("Ingresa un correo válido.");
                return;
            }

            if (!/^[0-9]{9}$/.test(telefono)) {
                alert("El celular debe tener 9 dígitos.");
                return;
            }

            let usuario = obtenerUsuarioGuardado();

            usuario = {
                ...usuario,
                nombres: nombres,
                apellidos: apellidos,
                correo: correo,
                telefono: telefono,
                zona: zona
            };

            guardarUsuarioGuardado(usuario);
            alert("Tus datos fueron actualizados.");
            cargarUsuarioGuardado();
        });
    }

    /* =====================================================
       CAMBIO DE CONTRASEÑA
    ====================================================== */
    const formPassword = document.getElementById("formPassword");

    if (formPassword) {
        formPassword.addEventListener("submit", function (event) {
            event.preventDefault();

            const actual = document.getElementById("passwordActual")?.value;
            const nueva = document.getElementById("passwordNueva")?.value;
            const confirmar = document.getElementById("passwordConfirmar")?.value;
            const mensaje = document.getElementById("mensajePassword");
            limpiarMensaje(mensaje);

            if (!actual || !nueva || !confirmar) {
                mostrarMensaje(mensaje, "Completa todos los campos.", "error");
                return;
            }

            if (nueva.length < 8) {
                mostrarMensaje(mensaje,"La nueva contraseña debe tener mínimo 8 caracteres.","error");
                return;
            }

            if (nueva !== confirmar) {
                mostrarMensaje(mensaje, "Las nuevas contraseñas no coinciden.", "error");
                return;
            }

            mostrarMensaje(mensaje, "Contraseña actualizada correctamente.", "correcto");
            formPassword.reset();
        });
    }

    /* =====================================================
       RECUPERAR CONTRASEÑA
    ====================================================== */
    const btnOlvidePassword = document.querySelector(".olvide-password");

    if (btnOlvidePassword) {
        btnOlvidePassword.addEventListener("click", function (e) {
            e.preventDefault();
            
            // Toma el correo que el usuario haya escrito en el input
            const correo = document.getElementById("correo")?.value.trim();

            if (!correo) {
                alert("Por favor, ingresa tu correo en el campo de arriba para enviarte el enlace de recuperación.");
                return;
            }

            // Enviar correo con Firebase
            sendPasswordResetEmail(auth, correo)
                .then(() => {
                    alert("Se ha enviado un enlace de recuperación a tu correo.");
                })
                .catch((error) => {
                    console.error("Error al recuperar:", error);
                    alert("Error: Asegúrate de que el correo esté registrado y bien escrito.");
                });
        });
    }

    /* =====================================================
       LOGIN CON GOOGLE
    ====================================================== */
    const btnGoogle = document.querySelector(".btn-google");

    if (btnGoogle) {
        btnGoogle.addEventListener("click", function () {
            // Proveedor de Google en Firebase
            const provider = new GoogleAuthProvider();

            signInWithPopup(auth, provider)
                .then(async (result) => {
                    const user = result.user;
                    
                    // Verificar si el usuario ya existe en Firestore
                    const userDoc = await getDoc(doc(db, "usuarios", user.uid));
                    
                    let datosUsuario;
                    if (!userDoc.exists()) {
                        // Si es la primera vez que entra con Google, lo registramos
                        datosUsuario = {
                            uid: user.uid,
                            nombres: user.displayName.split(" ")[0] || "",
                            apellidos: user.displayName.split(" ").slice(1).join(" ") || "",
                            nombre: user.displayName,
                            correo: user.email,
                            rol: "vecino", // Por defecto
                            fechaRegistro: serverTimestamp()
                        };
                        await setDoc(doc(db, "usuarios", user.uid), datosUsuario);
                    } else {
                        // Si ya existe, solo descargamos sus datos
                        datosUsuario = { uid: user.uid, ...userDoc.data() };
                    }

                    // Guardamos sesión y redirigimos
                    localStorage.setItem("coalerta_usuario", JSON.stringify(datosUsuario));
                    localStorage.setItem("coalertaSesion", "activa");
                    window.location.href = "../pages/mapa.html";
                })
                .catch((error) => {
                    console.error("Error con Google:", error);
                    alert("Hubo un problema al iniciar sesión con Google.");
                });
        });
    }

    /* =====================================================
       CERRAR SESIÓN
    ====================================================== */
    const btnCerrarSesion = document.getElementById("btnCerrarSesion");

    if (btnCerrarSesion) {
        btnCerrarSesion.addEventListener("click", function () {
            cerrarSesion();
        });
    }

    const cerrarSesionLinks = document.querySelectorAll(".cerrar-sesion");

    cerrarSesionLinks.forEach(function (enlace) {
        enlace.addEventListener("click", function (event) {
            event.preventDefault();
            cerrarSesion();
        });
    });

    /* =====================================================
       GEOLOCALIZACIÓN
    ====================================================== */
    const btnMiUbicacion = document.getElementById("btnMiUbicacion");

    if (btnMiUbicacion) {
        btnMiUbicacion.addEventListener("click", function () {
            obtenerUbicacionUsuario();
        });
    }

    /* =====================================================
       MODAL DE EMERGENCIA
    ====================================================== */
    const modalEmergencia = document.getElementById("modalEmergencia");
    const btnEmergencia = document.getElementById("btnEmergencia");
    const btnEmergenciaMobile = document.getElementById("btnEmergenciaMobile");
    const cerrarModal = document.getElementById("cerrarModal");

    function abrirModalEmergencia() {
        if (modalEmergencia) {
            modalEmergencia.classList.add("mostrar");
        }
    }

    function cerrarModalEmergencia() {
        if (modalEmergencia) {
            modalEmergencia.classList.remove("mostrar");
        }
    }

    if (btnEmergencia) {
        btnEmergencia.addEventListener("click", abrirModalEmergencia);
    }

    if (btnEmergenciaMobile) {
        btnEmergenciaMobile.addEventListener("click", abrirModalEmergencia);
    }

    if (cerrarModal) {
        cerrarModal.addEventListener("click", cerrarModalEmergencia);
    }

    if (modalEmergencia) {
        modalEmergencia.addEventListener("click",
            function (event) {
                if (event.target === modalEmergencia) {
                    cerrarModalEmergencia();
                }
            }
        );
    }

    /* =====================================================
       HISTORIAL - FILTROS
    ====================================================== */
    const buscarAlerta = document.getElementById("buscarAlerta");
    const filtroTipo = document.getElementById("filtroTipo");
    const filtroEstado = document.getElementById("filtroEstado");
    const filtroFecha = document.getElementById("filtroFecha");
    const btnLimpiarFiltros = document.getElementById("btnLimpiarFiltros");

    function filtrarHistorial() {
        const filas = document.querySelectorAll("#tablaHistorial tr");
        if (!filas.length) return;

        const texto = buscarAlerta? buscarAlerta.value.toLowerCase().trim(): "";
        const tipo = filtroTipo? filtroTipo.value: "todos";
        const estado = filtroEstado? filtroEstado.value: "todos";
        const fecha = filtroFecha? filtroFecha.value: "";
        let contador = 0;

        filas.forEach(function (fila) {
            const contenido = fila.innerText.toLowerCase();
            const tipoFila = fila.dataset.tipo;
            const estadoFila = fila.dataset.estado;
            const fechaFila = fila.dataset.fecha;
            const coincideTexto = contenido.includes(texto);
            const coincideTipo = tipo === "todos" || tipo === tipoFila;
            const coincideEstado = estado === "todos" || estado === estadoFila;
            const coincideFecha = fecha === "" || fecha === fechaFila;

            if (coincideTexto && coincideTipo && coincideEstado &&coincideFecha) {
                fila.style.display = "";
                contador++;
            } else {
                fila.style.display = "none";
            }
        });

        const cantidadResultados =document.getElementById("cantidadResultados");

        if (cantidadResultados) {
            cantidadResultados.textContent =
                contador === 1? "1 resultado": `${contador} resultados`;
        }

        const sinResultados =document.getElementById("sinResultados");

        if (sinResultados) {
            sinResultados.classList.toggle("mostrar",contador === 0);
        }
    }

    if (buscarAlerta) {
        buscarAlerta.addEventListener("input", filtrarHistorial
        );
    }

    if (filtroTipo) {
        filtroTipo.addEventListener("change", filtrarHistorial);
    }

    if (filtroEstado) {
        filtroEstado.addEventListener("change", filtrarHistorial);
    }

    if (filtroFecha) {
        filtroFecha.addEventListener("change", filtrarHistorial);
    }

    if (btnLimpiarFiltros) {
        btnLimpiarFiltros.addEventListener("click",
            function () {
                if (buscarAlerta) {
                    buscarAlerta.value = "";
                }

                if (filtroTipo) {
                    filtroTipo.value = "todos";
                }

                if (filtroEstado) {
                    filtroEstado.value = "todos";
                }

                if (filtroFecha) {
                    filtroFecha.value = "";
                }
                filtrarHistorial();
            }
        );
    }

    /* =====================================================
       MODAL DETALLE HISTORIAL
    ====================================================== */
    const modalDetalle = document.getElementById("modalDetalle");
    const botonesDetalle = document.querySelectorAll(".btn-detalle");

    botonesDetalle.forEach(function (boton) {
        boton.addEventListener("click", function () {
            const fila = boton.closest("tr");
            if (!fila || !modalDetalle) return;

            const celdas = fila.querySelectorAll("td");
            if (celdas.length < 5) return;

            actualizarTexto("detalleTitulo", celdas[0].innerText.trim());
            actualizarTexto("detalleUbicacion", celdas[1].innerText.trim());
            actualizarTexto("detalleFecha", celdas[2].innerText.trim());
            actualizarTexto("detalleHora", celdas[3].innerText.trim());
            actualizarTexto("detalleEstado", celdas[4].innerText.trim());

            modalDetalle.classList.add("mostrar");
        });
    });

    const cerrarDetalle = document.getElementById("cerrarDetalle");
    const btnCerrarDetalle = document.getElementById("btnCerrarDetalle");

    function cerrarModalDetalle() {
        if (modalDetalle) {
            modalDetalle.classList.remove("mostrar");
        }
    }

    if (cerrarDetalle) {
        cerrarDetalle.addEventListener("click", cerrarModalDetalle);
    }

    if (btnCerrarDetalle) {
        btnCerrarDetalle.addEventListener("click", cerrarModalDetalle);
    }

    if (modalDetalle) {
        modalDetalle.addEventListener("click",
            function (event) {
                if (event.target === modalDetalle) {
                    cerrarModalDetalle();
                }
            }
        );
    }

    /* =====================================================
       EXPORTAR HISTORIAL
    ====================================================== */
    const btnExportar = document.getElementById("btnExportar");

    if (btnExportar) {
        btnExportar.addEventListener("click", function() {
            alert("La exportación a PDF/Excel se conectará posteriormente con el backend.");
        });
    }
});

/* =========================================================
   FUNCIONES GLOBALES
========================================================= */

/* =========================================================
   VALIDAR CORREO
========================================================= */
function validarCorreo(correo) {
    const expresion = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return expresion.test(correo);
}

/* =========================================================
   MENSAJES
========================================================= */
function mostrarMensaje(elemento, mensaje, tipo) {
    if (!elemento) {
        alert(mensaje);
        return;
    }

    elemento.classList.remove("error","correcto");
    elemento.classList.add(tipo);

    const icono =
        tipo === "correcto"? "fa-circle-check": "fa-circle-exclamation";

    elemento.innerHTML = `
        <i class="fa-solid ${icono}"></i>
        ${mensaje}
    `;
}

function limpiarMensaje(elemento) {
    if (!elemento) return;
    elemento.innerHTML = "";
    elemento.classList.remove("error", "correcto");
}

/* =========================================================
   LOCALSTORAGE
========================================================= */
const STORAGE_KEY_USUARIO = "coalerta_usuario";
const STORAGE_KEY_USUARIO_LEGACY = "coalertaUsuario";

function guardarUsuarioGuardado(usuario) {
    const perfilSeguro = usuario && typeof usuario === "object" ? usuario : {};
    localStorage.setItem(STORAGE_KEY_USUARIO, JSON.stringify(perfilSeguro));
    localStorage.removeItem(STORAGE_KEY_USUARIO_LEGACY);
}

function obtenerUsuarioGuardado() {
    try {
        const datos = localStorage.getItem(STORAGE_KEY_USUARIO)
            || localStorage.getItem(STORAGE_KEY_USUARIO_LEGACY);

        if (!datos) {
            return {};
        }

        const usuario = JSON.parse(datos);
        if (usuario && typeof usuario === "object") {
            guardarUsuarioGuardado(usuario);
            return usuario;
        }

        return {};

    } catch (error) {
        console.error("Error leyendo usuario:", error);
        return {};
    }
}

/* =========================================================
   CARGAR USUARIO
========================================================= */
function cargarUsuarioGuardado() {
    const usuario = obtenerUsuarioGuardado();
    if (!usuario.nombres) return;

    const nombreCompleto = `${usuario.nombres || ""} ${usuario.apellidos || ""}`.trim();

    /* Sidebar */
    const nombresSidebar = document.querySelectorAll(".sidebar-usuario strong");

    nombresSidebar.forEach(function (elemento) {
        elemento.textContent = nombreCompleto;
    });

    /* Perfil */
    const tituloPerfil =document.querySelector(".perfil-resumen-card h2");

    if (tituloPerfil) {
        tituloPerfil.textContent = nombreCompleto;
    }

    /* Inputs del perfil */
    asignarValor("nombres", usuario.nombres);
    asignarValor("apellidos", usuario.apellidos);
    asignarValor("correo", usuario.correo);
    asignarValor("telefono", usuario.telefono);
    asignarValor("zona", usuario.zona);

    /* Información resumen */
    const resumen = document.querySelectorAll(".perfil-resumen-info span");

    if (resumen.length >= 3) {
        resumen[0].textContent = usuario.correo || "";
        resumen[1].textContent = usuario.telefono || "";
        resumen[2].textContent = usuario.zona || "";
    }
}

/* =========================================================
   ASIGNAR VALUE
========================================================= */
function asignarValor(id, valor) {
    if (!valor) return;

    const elemento = document.getElementById(id);

    if (elemento) {
        elemento.value = valor;
    }
}

/* =========================================================
   CERRAR SESIÓN
========================================================= */
function cerrarSesion() {
    const confirmar = confirm("¿Seguro que deseas cerrar sesión?");
    if (!confirmar) return;

    const cerrarSesionLocal = () => {
        localStorage.removeItem("coalertaSesion");
        localStorage.removeItem("coalerta_usuario");
        localStorage.removeItem(STORAGE_KEY_USUARIO_LEGACY);
        window.location.href = "login.html";
    };

    if (auth.currentUser) {
        signOut(auth).then(cerrarSesionLocal).catch(cerrarSesionLocal);
        return;
    }

    cerrarSesionLocal();
}

/* =========================================================
   GEOLOCALIZACIÓN
========================================================= */
function obtenerUbicacionUsuario() {
    if (!navigator.geolocation) {
        alert("Tu navegador no permite geolocalización.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function (position) {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            /*Si mapa.html creó una variable global llamada map.*/
            if (window.map) {
                window.map.setView([lat, lng], 17);

                if (window.L) {
                    L.marker([lat, lng]).addTo(window.map).bindPopup(
                        "<strong>Tu ubicación actual</strong>").openPopup();
                }
            } else {
                alert(`Ubicación obtenida:\n${lat}, ${lng}`);
            }
        },

        function (error) {
            let mensaje = "No se pudo obtener tu ubicación.";

            if (error.code ===error.PERMISSION_DENIED) {
                mensaje = "Debes permitir el acceso a tu ubicación.";
            }
            alert(mensaje);
        }
    );
}

/* =========================================================
   ACTUALIZAR TEXTO
========================================================= */
function actualizarTexto(id, texto) {
    const elemento = document.getElementById(id);

    if (elemento) {
        elemento.textContent = texto;
    }
}

/* =========================================================
   FUNCIONES DE SOPORTE
========================================================= */
function validarCorreo(correo) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

function mostrarMensaje(elemento, mensaje, tipo) {
    if (!elemento) {
        alert(mensaje);
        return;
    }
    elemento.classList.remove("error", "correcto");
    elemento.classList.add(tipo);
    const icono = tipo === "correcto" ? "fa-circle-check" : "fa-circle-exclamation";
    elemento.innerHTML = `<i class="fa-solid ${icono}"></i> ${mensaje}`;
}

function limpiarMensaje(elemento) {
    if (!elemento) return;
    elemento.innerHTML = "";
    elemento.classList.remove("error", "correcto");
}