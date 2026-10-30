import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth } from "./firebase-config.js?v=spark-direct-firestore-1";

/* =========================================================
   COALERTA - HISTORIAL.JS
========================================================= */
document.addEventListener("DOMContentLoaded", function () {
    const tablaHistorial = document.getElementById("tablaHistorial");
    const sinResultados = document.getElementById("sinResultados");
    const filtroBusqueda = document.getElementById("buscarAlerta");
    const filtroTipo = document.getElementById("filtroTipo");
    const filtroEstado = document.getElementById("filtroEstado");
    const filtroFecha = document.getElementById("filtroFecha");
    const cantidadResultados = document.getElementById("cantidadResultados");
    const modalDetalle = document.getElementById("modalDetalle");

    if (!tablaHistorial || !sinResultados || !cantidadResultados) {
        console.error("No se encontraron los elementos requeridos para mostrar el historial.");
        return;
    }

    configurarUsuario();
    configurarCierreSesion();
    configurarModal(modalDetalle);

    let filas = [];
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
        renderHistorial();
    });
    window.addEventListener("coalerta:error", function (event) {
        const detail = event.detail || {};
        if (!["perfil", "tus alertas"].includes(detail.area)) return;
        filas = [];
        tablaHistorial.replaceChildren();
        actualizarEstadisticas(filas);
        cantidadResultados.textContent = "0 resultados";
        actualizarEstadoHistorial("error");
        mostrarEstadoHistorial("No se pudo cargar el historial", detail.message || "Inténtalo nuevamente.");
    });
    renderHistorial();

    function renderHistorial() {
        if (!window.coalertaData || !window.coalertaData.isReady()) {
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
        filas = window.coalertaData.getMyAlerts()
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
            .map((alerta) => crearFilaAlerta(alerta));
        tablaHistorial.replaceChildren(...filas.map((fila) => fila.elemento));
        actualizarEstadisticas(filas);
        mostrarEstadoHistorial("No encontramos alertas", "Prueba cambiando los filtros de búsqueda.");
        filtrarHistorial(filas);
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
        [filtroBusqueda, filtroTipo, filtroEstado, filtroFecha].forEach((control) => {
            if (!control) return;
            control.addEventListener(
                control === filtroBusqueda ? "input" : "change",
                () => filtrarHistorial(obtenerFilas())
            );
        });

        const botonLimpiar = document.getElementById("btnLimpiarFiltros");
        if (botonLimpiar) {
            botonLimpiar.addEventListener("click", function () {
                if (filtroBusqueda) filtroBusqueda.value = "";
                if (filtroTipo) filtroTipo.value = "todos";
                if (filtroEstado) filtroEstado.value = "todos";
                if (filtroFecha) filtroFecha.value = "";
                filtrarHistorial(obtenerFilas());
            });
        }
    }

    function filtrarHistorial(alertasFilas) {
        const texto = normalizarTexto(filtroBusqueda ? filtroBusqueda.value : "");
        const tipo = filtroTipo ? filtroTipo.value : "todos";
        const estado = filtroEstado ? filtroEstado.value : "todos";
        const fecha = filtroFecha ? filtroFecha.value : "";
        let visibles = 0;

        alertasFilas.forEach(({ elemento, datos }) => {
            const coincideTexto = normalizarTexto(elemento.textContent).includes(texto);
            const coincideTipo = tipo === "todos" || datos.tipoClase === tipo;
            const coincideEstado = estado === "todos" || datos.estadoClase === estado;
            const coincideFecha = !fecha || datos.fechaISO === fecha;
            const mostrar = coincideTexto && coincideTipo && coincideEstado && coincideFecha;

            elemento.hidden = !mostrar;
            if (mostrar) visibles++;
        });

        cantidadResultados.textContent = `${visibles} ${visibles === 1 ? "resultado" : "resultados"}`;
        sinResultados.classList.toggle("mostrar", visibles === 0);
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
    iconoEstado.className = `fa-solid ${estado.icono}`;
    iconoEstado.setAttribute("aria-hidden", "true");
    estadoEtiqueta.append(iconoEstado, document.createTextNode(` ${estado.etiqueta}`));
    estadoCelda.appendChild(estadoEtiqueta);

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

function formatearRolVisible(usuario) {
    const valor = String(usuario.rol || "vecino").trim();
    const normalizado = valor.toLocaleLowerCase();
    const roleLabels = {
        vecino: "Vecino",
        residente: "Vecino",
        coordinador: "Coordinador vecinal",
        seguridad: "Personal de seguridad",
        agente: "Personal de seguridad"
    };
    const rol = roleLabels[normalizado] ||
        (["vecino / residente", "vecino/residente"].includes(normalizado)
            ? "Vecino"
            : valor.charAt(0).toLocaleUpperCase() + valor.slice(1));
    if (normalizado === "vecino" && usuario.estadoSolicitudRol === "pendiente" && usuario.rolSolicitud) {
        const solicitado = usuario.rolSolicitud === "coordinador"
            ? "Coordinador vecinal"
            : usuario.rolSolicitud === "seguridad" ? "Personal de seguridad" : usuario.rolSolicitud;
        return `${solicitado} (pendiente)`;
    }
    return rol;
}

function configurarCierreSesion() {
    const boton = document.getElementById("btnCerrarSesionLateral");
    if (!boton) return;

    boton.addEventListener("click", async function (evento) {
        evento.preventDefault();
        if (!confirm("¿Seguro que deseas cerrar sesión?")) return;

        try {
            if (typeof auth !== "undefined" && auth.currentUser) {
                await signOut(auth);
            }
            localStorage.removeItem("coalerta_usuario");
            localStorage.removeItem("coalertaSesion");
            window.location.href = "login.html";
        } catch (error) {
            console.error("No se pudo cerrar la sesión:", error);
            alert("No se pudo cerrar la sesión. Inténtalo nuevamente.");
        }
    });
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
    establecerTexto("detalleReporteTexto", String(alerta.detalle || "").trim() || "Sin detalle adicional.");

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

function configurarExportacion(obtenerFilas) {
    const boton = document.getElementById("btnExportar");
    if (!boton) return;

    boton.addEventListener("click", function () {
        const filas = obtenerFilas();
        const visibles = filas.filter(({ elemento }) => !elemento.hidden);
        if (visibles.length === 0) {
            alert("No hay alertas que coincidan con los filtros para exportar.");
            return;
        }

        const cabecera = ["ID", "Tipo", "Ubicación", "Fecha", "Hora", "Estado", "Latitud", "Longitud", "Prioridad"];
        const filasCsv = visibles.map(({ elemento, datos }, index) => {
            const alerta = datos.alerta;
            return [
                alerta && alerta.id ? alerta.id : index + 1,
                elemento.cells[0].textContent.trim(),
                elemento.cells[1].textContent.trim(),
                elemento.cells[2].textContent.trim(),
                elemento.cells[3].textContent.trim(),
                elemento.cells[4].textContent.trim(),
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

function establecerTexto(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = String(valor);
}
