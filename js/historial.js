import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection, doc, getDoc, onSnapshot, orderBy, query, Timestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";
import {
    configurarCierreSesion,
    establecerTexto,
    formatearRolVisible
} from "./general.js?v=shared-core-20261106";

document.addEventListener("DOMContentLoaded", function () {
    const tablaHistorial = document.getElementById("tablaHistorial");
    const sinResultados = document.getElementById("sinResultados");
    const filtroBusqueda = document.getElementById("buscarAlerta");
    const filtroTipo = document.getElementById("filtroTipo");
    const filtroEstado = document.getElementById("filtroEstado");
    const filtroFecha = document.getElementById("filtroFecha");
    const filtroFechaFin = document.getElementById("filtroFechaFin");
    const cantidadResultados = document.getElementById("cantidadResultados");
    const modalDetalle = document.getElementById("modalDetalle");

    if (!tablaHistorial || !sinResultados || !cantidadResultados) {
        console.error("No se encontraron los elementos requeridos para mostrar el historial.");
        return;
    }

    configurarUsuario();
    configurarCierreSesion({
        auth,
        signOut,
        confirmationMessage: "¿Seguro que deseas cerrar sesión?",
        clearCachedSession: true
    });
    configurarModal(modalDetalle);
    if (filtroBusqueda) {
        filtroBusqueda.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void buscarAlertaPorCodigo(filtroBusqueda.value);
        });
    }

    let filas = [];
    let alertaBuscada = null;
    let incidentesComunidad = [];
    let consultaComunidadActual = "";
    let secuenciaConsultaComunidad = 0;
    let cancelarConsultaComunidad = null;
    let errorConsultaComunidad = null;
    configurarFiltros(() => filas);
    configurarExportacion(() => filas);
    window.addEventListener("coalerta:datos-listos", function (event) {
        configurarUsuario(event.detail.profile);
        renderHistorial();
    });
    window.addEventListener("coalerta:mis-alertas-actualizadas", renderHistorial);
    window.addEventListener("coalerta:alertas-actualizadas", renderHistorial);
    window.addEventListener("coalerta:sesion-cambiada", function (event) {
        configurarUsuario(event.detail && event.detail.profile || {});
        secuenciaConsultaComunidad += 1;
        if (cancelarConsultaComunidad) cancelarConsultaComunidad();
        cancelarConsultaComunidad = null;
        consultaComunidadActual = "";
        incidentesComunidad = [];
        errorConsultaComunidad = null;
        renderHistorial();
    });
    window.addEventListener("coalerta:error", function (event) {
        const detail = event.detail || {};
        if (!["perfil", "tus alertas", "incidentes historial"].includes(detail.area)) return;
        console.error("No se pudieron sincronizar los datos del historial:", detail.message || detail);
        if (detail.area === "incidentes historial") {
            errorConsultaComunidad = detail.message || "No se pudieron cargar cierres del sector.";
            actualizarEstadoHistorial("error");
            const operation = document.getElementById("estadoOperacionHistorial");
            const operationDetail = document.getElementById("detalleOperacionHistorial");
            if (operation) operation.textContent = "No se pudieron cargar cierres del sector";
            if (operationDetail) {
                operationDetail.textContent =
                    "Comprueba que tu rol tenga acceso a los incidentes de la comunidad e inténtalo nuevamente.";
            }
            return;
        }
        filas = [];
        tablaHistorial.replaceChildren();
        actualizarEstadisticas(filas);
        cantidadResultados.textContent = "0 resultados";
        actualizarEstadoHistorial("error");
        mostrarEstadoHistorial(
            "No se pudo cargar el historial",
            "No pudimos sincronizar tus reportes. Comprueba tu conexión e inténtalo nuevamente más tarde."
        );
    });
    renderHistorial();

    function renderHistorial() {
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            secuenciaConsultaComunidad += 1;
            if (cancelarConsultaComunidad) cancelarConsultaComunidad();
            cancelarConsultaComunidad = null;
            consultaComunidadActual = "";
            incidentesComunidad = [];
            errorConsultaComunidad = null;
            actualizarEstadoHistorial(
                window.coalertaData && window.coalertaData.getProfile() ? "connecting" : "disconnected"
            );
            filas = [];
            tablaHistorial.replaceChildren();
            actualizarEstadisticas(filas);
            cantidadResultados.textContent = "0 resultados";
            const profile = window.coalertaData && window.coalertaData.getProfile();
            const registrationIncomplete = window.coalertaData &&
                window.coalertaData.isRegistrationIncomplete();
            mostrarEstadoHistorial(
                registrationIncomplete
                    ? "Registro pendiente"
                    : profile ? "Conectando con el servidor" : "Inicia sesión",
                registrationIncomplete
                    ? "Esta cuenta aún no tiene un perfil terminado. Completa el registro para consultar el historial."
                    : profile
                    ? "Cargando tus reportes guardados en la nube."
                    : "Accede para consultar el historial de tus reportes."
            );
            return;
        }
        actualizarEstadoHistorial("connected");
        cargarIncidentesComunidad();
        const alertasRegistro = new Map(
            incidentesComunidad.map((alerta) => [String(alerta.id), alerta])
        );
        window.coalertaData.getMyAlerts()
            .forEach((alerta) => alertasRegistro.set(String(alerta.id), {
                ...alertasRegistro.get(String(alerta.id)),
                ...alerta
            }));
        if (alertaBuscada) {
            alertasRegistro.set(String(alertaBuscada.id), {
                ...alertasRegistro.get(String(alertaBuscada.id)),
                ...alertaBuscada
            });
        }
        filas = Array.from(alertasRegistro.values())
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
            .map((alerta) => crearFilaAlerta(alerta));
        tablaHistorial.replaceChildren(...filas.map((fila) => fila.elemento));
        actualizarEstadisticas(filas);
        mostrarEstadoHistorial("No encontramos alertas", "Prueba cambiando los filtros de búsqueda.");
        filtrarHistorial(filas);
        if (errorConsultaComunidad) {
            actualizarEstadoHistorial("error");
            const operation = document.getElementById("estadoOperacionHistorial");
            const operationDetail = document.getElementById("detalleOperacionHistorial");
            if (operation) operation.textContent = "No se pudieron cargar cierres del sector";
            if (operationDetail) {
                operationDetail.textContent =
                    "Comprueba que tu rol tenga acceso a los incidentes de la comunidad e inténtalo nuevamente.";
            }
        }
    }

    function cargarIncidentesComunidad() {
        const data = window.coalertaData;
        const profile = data.getProfile() || {};
        const communityId = String(profile.comunidadId || "").trim();
        if (!communityId) {
            secuenciaConsultaComunidad += 1;
            if (cancelarConsultaComunidad) cancelarConsultaComunidad();
            cancelarConsultaComunidad = null;
            incidentesComunidad = [];
            errorConsultaComunidad = null;
            consultaComunidadActual = `${auth.currentUser && auth.currentUser.uid || ""}:${communityId}:${role}:sin-acceso`;
            return;
        }

        const fechaInicio = filtroFecha ? filtroFecha.value : "";
        const fechaFin = filtroFechaFin ? filtroFechaFin.value : "";
        if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
            secuenciaConsultaComunidad += 1;
            if (cancelarConsultaComunidad) cancelarConsultaComunidad();
            cancelarConsultaComunidad = null;
            incidentesComunidad = [];
            errorConsultaComunidad = null;
            consultaComunidadActual = `${auth.currentUser && auth.currentUser.uid || ""}:${communityId}:rango-invalido`;
            establecerEstadoRangoInvalido();
            return;
        }

        const signature = [
            auth.currentUser && auth.currentUser.uid || "",
            communityId,
            fechaInicio,
            fechaFin
        ].join(":");
        if (signature === consultaComunidadActual) return;
        consultaComunidadActual = signature;
        if (cancelarConsultaComunidad) cancelarConsultaComunidad();
        cancelarConsultaComunidad = null;
        incidentesComunidad = [];
        errorConsultaComunidad = null;
        const sequence = ++secuenciaConsultaComunidad;
        const constraints = [where("comunidadId", "==", communityId)];
        if (fechaInicio) {
            constraints.push(where("timestamp", ">=", Timestamp.fromDate(fechaLocal(fechaInicio))));
        }
        if (fechaFin) {
            const fechaFinExclusiva = fechaLocal(fechaFin);
            fechaFinExclusiva.setDate(fechaFinExclusiva.getDate() + 1);
            constraints.push(where("timestamp", "<", Timestamp.fromDate(fechaFinExclusiva)));
        }
        constraints.push(orderBy("timestamp", "desc"));
        const queryCommunity = query(collection(db, "incidentes"), ...constraints);

        cancelarConsultaComunidad = onSnapshot(queryCommunity, (snapshot) => {
            if (sequence !== secuenciaConsultaComunidad) return;
            incidentesComunidad = snapshot.docs
                .map((document) => {
                    const incidente = document.data();
                    return {
                        ...incidente,
                        id: document.id,
                        timestamp: fechaAISO(incidente.timestamp),
                        enSitioAt: fechaAISO(incidente.enSitioAt),
                        closedAt: fechaAISO(incidente.closedAt)
                    };
                });
            renderHistorial();
        }, (error) => {
            if (sequence !== secuenciaConsultaComunidad) return;
            console.error("No se pudieron consultar los cierres de la comunidad:", error);
            window.dispatchEvent(new CustomEvent("coalerta:error", {
                detail: {
                    area: "incidentes historial",
                    message: error.message || "No se pudieron consultar los cierres de la comunidad."
                }
            }));
        });
    }

    function establecerEstadoRangoInvalido() {
        const operation = document.getElementById("estadoOperacionHistorial");
        const operationDetail = document.getElementById("detalleOperacionHistorial");
        if (operation) operation.textContent = "Rango de fechas no válido";
        if (operationDetail) operationDetail.textContent = "La fecha de inicio debe ser anterior o igual a la fecha de fin.";
    }

    function mostrarEstadoHistorial(titulo, mensaje) {
        const heading = sinResultados.querySelector("h3");
        const detail = sinResultados.querySelector("p");
        if (heading) heading.textContent = titulo;
        if (detail) detail.textContent = mensaje;
        sinResultados.classList.add("mostrar");
    }

    function actualizarEstadoHistorial(status) {
        const header = document.getElementById("estadoSistemaHistorial");
        const operation = document.getElementById("estadoOperacionHistorial");
        const detail = document.getElementById("detalleOperacionHistorial");
        const stateContainer = document.querySelector(".estado-sistema");
        const statusDot = document.querySelector(".estado-punto");
        const labels = {
            connected: ["Conectado a CoAlerta", "Historial sincronizado", "Tus reportes se actualizan en tiempo real."],
            connecting: ["Conectando…", "Conectando al servidor", "Esperando conexión y autenticación."],
            error: ["Error de sincronización", "Sin datos sincronizados", "Revisa tu conexión e inténtalo nuevamente."],
            disconnected: ["Sin sesión", "Conexión requerida", "Inicia sesión para consultar tus reportes."]
        };
        const [headerText, operationText, detailText] = labels[status] || labels.error;
        if (header) header.textContent = headerText;
        if (operation) operation.textContent = operationText;
        if (detail) detail.textContent = detailText;
        if (stateContainer) stateContainer.dataset.state = status;
        if (statusDot) {
            statusDot.style.backgroundColor = status === "connected"
                ? "#10b981"
                : status === "connecting"
                    ? "#d98b00"
                    : "#d92d20";
        }
    }

    function configurarFiltros(obtenerFilas) {
        [filtroBusqueda, filtroTipo, filtroEstado, filtroFecha, filtroFechaFin].forEach((control) => {
            if (!control) return;
            control.addEventListener(
                control === filtroBusqueda ? "input" : "change",
                () => {
                    if (control === filtroFecha || control === filtroFechaFin) {
                        consultaComunidadActual = "";
                        renderHistorial();
                    } else if (control === filtroBusqueda) {
                        alertaBuscada = null;
                        renderHistorial();
                    } else {
                        filtrarHistorial(obtenerFilas());
                    }
                }
            );
        });

        const botonLimpiar = document.getElementById("btnLimpiarFiltros");
        if (botonLimpiar) {
            botonLimpiar.addEventListener("click", function () {
                if (filtroBusqueda) filtroBusqueda.value = "";
                if (filtroTipo) filtroTipo.value = "todos";
                if (filtroEstado) filtroEstado.value = "todos";
                if (filtroFecha) filtroFecha.value = "";
                if (filtroFechaFin) filtroFechaFin.value = "";
                alertaBuscada = null;
                consultaComunidadActual = "";
                renderHistorial();
            });
        }
    }

    function filtrarHistorial(alertasFilas) {
        const texto = normalizarTexto(filtroBusqueda ? filtroBusqueda.value : "");
        const tipo = filtroTipo ? filtroTipo.value : "todos";
        const estado = filtroEstado ? filtroEstado.value : "todos";
        const fechaInicio = filtroFecha ? filtroFecha.value : "";
        const fechaFin = filtroFechaFin ? filtroFechaFin.value : "";
        let visibles = 0;

        alertasFilas.forEach(({ elemento, datos }) => {
            const coincideTexto = normalizarTexto(elemento.textContent).includes(texto) ||
                normalizarTexto(datos.alerta && datos.alerta.id).includes(texto);
            const coincideTipo = tipo === "todos" || datos.tipoClase === tipo;
            const coincideEstado = estado === "todos" || datos.estadoClase === estado;
            const coincideFechaInicio = !fechaInicio || datos.fechaISO >= fechaInicio;
            const coincideFechaFin = !fechaFin || datos.fechaISO <= fechaFin;
            const mostrar = coincideTexto && coincideTipo && coincideEstado &&
                coincideFechaInicio && coincideFechaFin;

            elemento.hidden = !mostrar;
            if (mostrar) visibles++;
        });

        cantidadResultados.textContent = `${visibles} ${visibles === 1 ? "resultado" : "resultados"}`;
        sinResultados.classList.toggle("mostrar", visibles === 0);
    }

    async function buscarAlertaPorCodigo(codigo) {
        const id = String(codigo || "").trim();
        if (!id) return;

        try {
            const snapshot = await getDoc(doc(db, "incidentes", id));
            if (!snapshot.exists()) {
                alertaBuscada = null;
                renderHistorial();
                window.alert("No se encontró una alerta con ese código.");
                return;
            }

            if (filtroTipo) filtroTipo.value = "todos";
            if (filtroEstado) filtroEstado.value = "todos";
            if (filtroFecha) filtroFecha.value = "";
            if (filtroFechaFin) filtroFechaFin.value = "";
            alertaBuscada = { ...snapshot.data(), id: snapshot.id };
            renderHistorial();
            const filaBuscada = filas.find((fila) => String(fila.datos.alerta.id) === id);
            if (filaBuscada && !filaBuscada.elemento.hidden) {
                filaBuscada.elemento.scrollIntoView({ behavior: "smooth", block: "center" });
                filaBuscada.elemento.classList.add("fila-alerta-buscada");
            }
        } catch (error) {
            console.error("No se pudo buscar la alerta por código:", error);
            window.alert(error.code === "permission-denied"
                ? "No tienes permiso para consultar esa alerta."
                : "No se pudo consultar la alerta. Inténtalo nuevamente.");
        }
    }
});

function crearFilaAlerta(alerta) {
    const tipo = String(alerta.tipo || "Sospechoso");
    const tipoClase = obtenerClaseTipo(tipo);
    const fecha = obtenerFechaAlerta(alerta);
    const estado = obtenerEstadoAlerta(alerta.estado);
    const fila = document.createElement("tr");

    fila.dataset.tipo = tipoClase;
    fila.dataset.estado = estado.clase;
    fila.dataset.fecha = fecha.iso;

    const tipoCelda = document.createElement("td");
    const tipoContenedor = document.createElement("div");
    tipoContenedor.className = "tipo-alerta-tabla";
    const iconoTipo = document.createElement("span");
    iconoTipo.className = `tipo-icono ${tipoClase}`;
    const icono = document.createElement("i");
    icono.className = `fa-solid ${obtenerIconoTipo(tipoClase)}`;
    icono.setAttribute("aria-hidden", "true");
    iconoTipo.appendChild(icono);
    const nombreAlerta = document.createElement("span");
    nombreAlerta.className = "tipo-alerta-nombre";
    nombreAlerta.textContent = nombreTipo(tipoClase);
    tipoContenedor.append(iconoTipo, nombreAlerta);
    tipoCelda.appendChild(tipoContenedor);

    const ubicacionCelda = document.createElement("td");
    ubicacionCelda.className = "celda-ubicacion";
    const ubicacionIcono = document.createElement("i");
    ubicacionIcono.className = "fa-solid fa-location-dot";
    ubicacionIcono.setAttribute("aria-hidden", "true");
    const ubicacionTexto = document.createElement("span");
    ubicacionTexto.textContent = ubicacionAlerta(alerta);
    ubicacionCelda.append(ubicacionIcono, ubicacionTexto);

    const fechaCelda = document.createElement("td");
    fechaCelda.className = "celda-fecha";
    const fechaIcono = document.createElement("i");
    fechaIcono.className = "fa-regular fa-calendar";
    fechaIcono.setAttribute("aria-hidden", "true");
    const fechaTexto = document.createElement("span");
    fechaTexto.textContent = fecha.formateada;
    fechaCelda.append(fechaIcono, fechaTexto);

    const horaCelda = document.createElement("td");
    horaCelda.className = "celda-hora";
    const horaIcono = document.createElement("i");
    horaIcono.className = "fa-regular fa-clock";
    horaIcono.setAttribute("aria-hidden", "true");
    const horaTexto = document.createElement("span");
    horaTexto.textContent = obtenerHoraAlerta(alerta);
    horaCelda.append(horaIcono, horaTexto);

    const estadoCelda = document.createElement("td");
    const estadoEtiqueta = document.createElement("span");
    estadoEtiqueta.className = `estado-alerta ${estado.clase}`;
    const iconoEstado = document.createElement("i");
    const estadoEnProceso = estado.clase === "proceso";
    iconoEstado.className = `fa-solid ${estadoEnProceso ? "fa-clock" : estado.icono}`;
    iconoEstado.setAttribute("aria-hidden", "true");
    estadoEtiqueta.append(
        iconoEstado,
        document.createTextNode(` ${estadoEnProceso ? "En proceso" : estado.etiqueta}`)
    );
    estadoCelda.appendChild(estadoEtiqueta);
    const tiempoRespuesta = document.createElement("small");
    tiempoRespuesta.className = "tiempo-respuesta-historial";
    tiempoRespuesta.style.display = "block";
    tiempoRespuesta.style.marginTop = "6px";
    tiempoRespuesta.textContent = `Tiempo de respuesta: ${formatearTiempoRespuesta(alerta)}`;
    estadoCelda.appendChild(tiempoRespuesta);

    const accionCelda = document.createElement("td");
    const botonDetalle = document.createElement("button");
    botonDetalle.type = "button";
    botonDetalle.className = "btn-detalle";
    const textoDetalle = document.createElement("span");
    textoDetalle.textContent = "Ver detalle";
    const iconoDetalle = document.createElement("i");
    iconoDetalle.className = "fa-solid fa-chevron-right";
    iconoDetalle.setAttribute("aria-hidden", "true");
    botonDetalle.append(textoDetalle, iconoDetalle);
    botonDetalle.setAttribute("aria-label", `Ver detalle de ${nombreTipo(tipoClase)}`);
    botonDetalle.addEventListener("click", () => {
        mostrarDetalle(alerta, tipoClase, fecha, estado);
        if (typeof window.coalertaMarcarAlertaLeida === "function") {
            window.coalertaMarcarAlertaLeida(alerta).catch((error) => {
                console.error("No se pudo marcar la alerta como leída desde el historial:", error);
                const operation = document.getElementById("detalleOperacionHistorial");
                if (operation) operation.textContent = error.message || "No se pudo guardar que la alerta fue leída.";
            });
        }
    });
    accionCelda.appendChild(botonDetalle);

    fila.append(tipoCelda, ubicacionCelda, fechaCelda, horaCelda, estadoCelda, accionCelda);

    return {
        elemento: fila,
        datos: {
            tipoClase,
            estadoClase: estado.clase,
            fechaISO: fecha.iso,
            prioridad: String(alerta.prioridad || ""),
            tiempoRespuesta: formatearTiempoRespuesta(alerta),
            alerta
        }
    };
}

function actualizarEstadisticas(filas) {
    const total = filas.length;
    const atendidas = filas.filter(({ datos }) => datos.estadoClase === "atendida").length;
    const enProceso = filas.filter(({ datos }) => datos.estadoClase === "proceso").length;
    const criticas = filas.filter(({ datos }) =>
        normalizarTexto(datos.prioridad) === "alta"
    ).length;

    establecerTexto("totalAlertas", total);
    establecerTexto("totalAtendidas", atendidas);
    establecerTexto("totalProceso", enProceso);
    establecerTexto("totalCriticas", criticas);
}

function configurarUsuario(profileOverride) {
    const usuario = profileOverride ||
        (window.coalertaData && window.coalertaData.getProfile()) ||
        {};

    const nombre = usuario.nombre ||
        [usuario.nombres, usuario.apellidos].filter(Boolean).join(" ") ||
        "usuario";
    const primerNombre = nombre.trim().split(/\s+/)[0] || "usuario";
    const nombreElemento = document.getElementById("sidebarNombre");
    const rolElemento = document.getElementById("sidebarRol");
    const botonExportar = document.getElementById("btnExportar");
    const role = window.coalertaData && window.coalertaData.isReady()
        ? window.coalertaData.getRole()
        : String(usuario.rol || "").trim().toLowerCase();
    if (botonExportar) {
        botonExportar.hidden = !["coordinador", "seguridad", "agente"].includes(role);
    }

    if (nombreElemento) nombreElemento.textContent = `Hola, ${primerNombre}`;
    if (rolElemento) rolElemento.textContent = formatearRolVisible(usuario);

    const avatar = document.getElementById("sidebarAvatarImg");
    const icono = document.getElementById("sidebarAvatarIcon");
    const foto = usuario.fotoBase64 || usuario.fotoURL || usuario.photoURL;
    if (avatar && foto) {
        avatar.onerror = function () {
            avatar.hidden = true;
            if (icono) icono.hidden = false;
        };
        avatar.src = foto;
        avatar.hidden = false;
        if (icono) icono.hidden = true;
    } else if (avatar) {
        avatar.hidden = true;
        if (icono) icono.hidden = false;
    }
}

function configurarModal(modal) {
    if (!modal) return;

    const cerrar = () => {
        modal.classList.remove("mostrar");
    };
    const botonCerrar = document.getElementById("cerrarDetalle");
    const botonListo = document.getElementById("btnCerrarDetalle");

    if (botonCerrar) botonCerrar.addEventListener("click", cerrar);
    if (botonListo) botonListo.addEventListener("click", cerrar);
    modal.addEventListener("click", (evento) => {
        if (evento.target === modal) cerrar();
    });
    document.addEventListener("keydown", (evento) => {
        if (evento.key === "Escape") cerrar();
    });
}

function mostrarDetalle(alerta, tipoClase, fecha, estado) {
    establecerTexto("detalleTitulo", nombreTipo(tipoClase));
    establecerTexto("detalleUbicacion", ubicacionAlerta(alerta));
    establecerTexto("detalleFecha", fecha.formateada);
    establecerTexto("detalleHora", obtenerHoraAlerta(alerta));
    establecerTexto("detalleEstado", estado.etiqueta);
    establecerTexto(
        "detallePatrulla",
        alerta.unidad || alerta.codigoPatrulla || alerta.patrullaId || "No asignada"
    );
    establecerTexto("detalleTiempoRespuesta", formatearTiempoRespuesta(alerta));
    establecerTexto("detalleReporteTexto", String(alerta.detalle || "").trim() || "Sin detalle adicional.");
    renderizarLineaTiempo(alerta);

    const iconoTipo = document.querySelector(".detalle-alerta-icono");
    if (iconoTipo) {
        iconoTipo.className = `detalle-alerta-icono ${tipoClase}`;
        const icono = iconoTipo.querySelector("i");
        if (icono) icono.className = `fa-solid ${obtenerIconoTipo(tipoClase)}`;
    }

    const mensaje = document.getElementById("detalleMensaje");
    const mensajeTitulo = document.getElementById("detalleMensajeTitulo");
    const mensajeTexto = document.getElementById("detalleMensajeTexto");
    const mensajeIcono = document.getElementById("detalleMensajeIcono");

    if (mensaje) mensaje.classList.toggle("detalle-mensaje-pendiente", estado.clase === "proceso");
    if (mensajeTitulo) {
        mensajeTitulo.textContent = estado.clase === "cerrada"
            ? "Reporte descartado"
            : estado.clase === "proceso"
                ? estado.etiqueta
                : "Atención registrada";
    }
    if (mensajeTexto) {
        mensajeTexto.textContent = estado.clase === "cerrada"
            ? `El reporte fue descartado. Motivo: ${alerta.motivoDescarte || "No indicado"}.`
            : estado.clase === "proceso"
                ? estado.etiqueta === "Auxilio en camino" && alerta.etaMinutos
                    ? `Una unidad fue asignada. Tiempo estimado por GPS: ${alerta.etaMinutos} min.`
                    : estado.etiqueta === "Agentes en sitio"
                        ? "La unidad asignada informó que llegó a la ubicación del incidente."
                        : "La alerta continúa en proceso de atención."
                : "El incidente fue marcado como concluido.";
    }
    if (mensajeIcono) {
        mensajeIcono.className = `fa-solid ${
            estado.clase === "cerrada" ? "fa-circle-xmark" : estado.clase === "proceso" ? "fa-clock" : "fa-circle-check"
        }`;
    }

    const modal = document.getElementById("modalDetalle");
    if (modal) modal.classList.add("mostrar");
    const mapLink = document.querySelector(".btn-ver-ubicacion");
    if (mapLink) {
        const latitude = Number(alerta.latitud);
        const longitude = Number(alerta.longitud);
        mapLink.href = Number.isFinite(latitude) && Number.isFinite(longitude)
            ? `mapa.html?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`
            : "mapa.html";
    }
}

function renderizarLineaTiempo(alerta) {
    const lista = document.getElementById("lineaTiempoIncidente");
    if (!lista) return;

    const etapas = [
        ["Emisión", alerta.timestamp],
        ["Derivación", alerta.derivadaAt],
        ["Aceptación", alerta.despachoAt],
        ["Arribo", alerta.enSitioAt],
        ["Cierre", alerta.closedAt]
    ];

    lista.replaceChildren(...etapas.map(([nombre, valor]) => {
        const elemento = document.createElement("li");
        const titulo = document.createElement("strong");
        const hora = document.createElement("time");
        const fecha = convertirFecha(valor);

        titulo.textContent = nombre;
        if (fecha && Number.isFinite(fecha.getTime())) {
            hora.dateTime = fecha.toISOString();
            hora.textContent = fecha.toLocaleString("es-PE");
        } else {
            hora.textContent = "No registrada";
        }

        elemento.append(titulo, hora);
        return elemento;
    }));
}

function configurarExportacion(obtenerFilas) {
    const boton = document.getElementById("btnExportar");
    if (!boton) return;

    boton.addEventListener("click", function () {
        const role = window.coalertaData && window.coalertaData.getRole();
        if (!["coordinador", "seguridad", "agente"].includes(role)) return;

        const filas = obtenerFilas();
        const visibles = filas.filter(({ elemento }) => !elemento.hidden);
        if (visibles.length === 0) {
            alert("No hay alertas que coincidan con los filtros para exportar.");
            return;
        }

        const cabecera = [
            "ID", "Tipo", "Ubicación", "Fecha", "Hora", "Estado",
            "Tiempo de respuesta", "Latitud", "Longitud", "Prioridad"
        ];
        const filasCsv = visibles.map(({ elemento, datos }, index) => {
            const alerta = datos.alerta;
            return [
                alerta && alerta.id ? alerta.id : index + 1,
                elemento.cells[0].textContent.trim(),
                elemento.cells[1].textContent.trim(),
                elemento.cells[2].textContent.trim(),
                elemento.cells[3].textContent.trim(),
                elemento.cells[4].textContent.trim(),
                datos.tiempoRespuesta,
                alerta && alerta.latitud != null ? alerta.latitud : "",
                alerta && alerta.longitud != null ? alerta.longitud : "",
                datos.prioridad
            ];
        });

        const csv = [cabecera, ...filasCsv]
            .map((fila) => fila.map(escaparCampoCsv).join(","))
            .join("\r\n");
        const archivo = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(archivo);
        const enlace = document.createElement("a");
        enlace.href = url;
        enlace.download = "historial_coalerta.csv";
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        URL.revokeObjectURL(url);
    });
}

function formatearTiempoRespuesta(alerta) {
    const emision = convertirFecha(alerta && alerta.timestamp) ||
        convertirFecha(alerta && alerta.fecha) ||
        convertirFecha(alerta && alerta.createdAt);
    const arribo = convertirFecha(alerta && alerta.enSitioAt);
    if (!emision || !arribo || arribo < emision) return "No disponible";

    const totalSegundos = Math.floor((arribo.getTime() - emision.getTime()) / 1000);
    const horas = Math.floor(totalSegundos / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;
    if (horas > 0) return `${horas} h ${minutos} min ${segundos} s`;
    if (minutos > 0) return `${minutos} min ${segundos} s`;
    return `${segundos} s`;
}

function fechaLocal(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function fechaAISO(value) {
    const fecha = convertirFecha(value);
    return fecha ? fecha.toISOString() : null;
}

function obtenerFechaAlerta(alerta) {
    let fecha = convertirFecha(alerta.timestamp);
    if (!fecha) fecha = convertirFecha(alerta.fecha);
    if (!fecha) fecha = convertirFecha(alerta.createdAt);

    return {
        fecha,
        iso: fecha
            ? `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`
            : "",
        formateada: !fecha
            ? "Fecha no disponible"
            : fecha.toLocaleDateString("es-PE")
    };
}

function convertirFecha(valor) {
    if (!valor) return null;
    if (typeof valor.toDate === "function") return valor.toDate();

    if (typeof valor === "string") {
        const fechaLocal = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (fechaLocal) {
            return new Date(
                Number(fechaLocal[3]),
                Number(fechaLocal[2]) - 1,
                Number(fechaLocal[1])
            );
        }
    }

    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function obtenerHoraAlerta(alerta) {
    if (alerta.hora) return String(alerta.hora);
    const fechaConHora = convertirFecha(alerta.timestamp) || convertirFecha(alerta.createdAt);
    if (fechaConHora && !Number.isNaN(fechaConHora.getTime())) {
        return fechaConHora.toLocaleTimeString("es-PE", {
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        });
    }
    return "--:--";
}

function ubicacionAlerta(alerta) {
    const latitude = Number(alerta.latitud);
    const longitude = Number(alerta.longitud);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
        ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
        : alerta.ubicacion ? String(alerta.ubicacion) : "Ubicación no disponible";
}

function obtenerEstadoAlerta(estadoOriginal) {
    const estado = normalizarTexto(estadoOriginal || "En proceso");
    if (estado.includes("atendid") || estado.includes("resuelt")) {
        return { clase: "atendida", etiqueta: "Atendida", icono: "fa-circle-check" };
    }
    if (estado.includes("emergencia concluida")) {
        return { clase: "atendida", etiqueta: "Atendida", icono: "fa-circle-check" };
    }
    if (estado.includes("descartad")) {
        return { clase: "cerrada", etiqueta: "Descartada", icono: "fa-circle-xmark" };
    }
    if (estado.includes("auxilio en camino")) {
        return { clase: "proceso", etiqueta: "Auxilio en camino", icono: "fa-truck-medical" };
    }
    if (estado.includes("agentes en sitio")) {
        return { clase: "proceso", etiqueta: "Agentes en sitio", icono: "fa-location-dot" };
    }
    if (estado.includes("derivada a central")) {
        return { clase: "proceso", etiqueta: "Derivada a central", icono: "fa-tower-broadcast" };
    }
    return { clase: "proceso", etiqueta: "En proceso", icono: "fa-clock" };
}

function obtenerClaseTipo(tipo) {
    const valor = normalizarTexto(tipo);
    if (valor.includes("robo")) return "robo";
    if (valor.includes("accidente")) return "accidente";
    if (valor.includes("incendio")) return "incendio";
    return "sospechoso";
}

function obtenerIconoTipo(tipo) {
    const iconos = {
        robo: "fa-mask-face",
        sospechoso: "fa-user-secret",
        accidente: "fa-truck-medical",
        incendio: "fa-fire"
    };
    return iconos[tipo] || "fa-triangle-exclamation";
}

function nombreTipo(tipo) {
    const nombres = {
        robo: "Robo",
        sospechoso: "Sospechoso",
        accidente: "Accidente",
        incendio: "Incendio"
    };
    return nombres[tipo] || "Alerta";
}

function normalizarTexto(valor) {
    return String(valor || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function escaparCampoCsv(valor) {
    return `"${String(valor == null ? "" : valor).replace(/"/g, '""')}"`;
}
