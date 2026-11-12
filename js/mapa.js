import {
    onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth } from "./firebase-config.js?v=spark-direct-firestore-1";
import {
    configurarCierreSesion,
    escapeHtml,
    formatearRolVisible
} from "./general.js?v=shared-core-20261106";

let ubicacionActualMapa = null;
let comunidadActualMapa = null;
let solicitudUbicacionMapa = false;
const precisionMaximaUbicacionAceptableMetros = 100000;
const CLAVE_LUGARES_MAPA = "coalerta_lugares_mapa";
const VIGENCIA_LUGARES_MAPA_MS = 30 * 60 * 1000;
const TIPOS_LUGAR_MAPA = {
    salud: { icono: "fa-kit-medical", color: "marcador-salud", etiqueta: "Centro de salud" },
    comisaria: { icono: "fa-shield-halved", color: "marcador-comisaria", etiqueta: "Comisaría / policía" },
    serenazgo: { icono: "fa-shield-halved", color: "marcador-comisaria", etiqueta: "Serenazgo / seguridad ciudadana" },
    bomberos: { icono: "fa-fire-extinguisher", color: "marcador-lugar", etiqueta: "Estación de bomberos" },
    municipalidad: { icono: "fa-landmark", color: "marcador-lugar", etiqueta: "Municipalidad" },
    lugar: { icono: "fa-location-dot", color: "marcador-lugar", etiqueta: "Lugar importante" }
};
const TIPOS_LUGAR_PERMANENTES = ["salud", "comisaria", "serenazgo"];
window.coalertaEstadoUbicacionMapa = "pending";
window.coalertaUbicacionMapa = null;

document.addEventListener("DOMContentLoaded", function () {
    const elementoMapa = document.getElementById("mapaInteractivo");
    if (!elementoMapa) return;

    if (typeof L === "undefined") {
        console.error("Leaflet no está cargado.");
        elementoMapa.textContent = "No se pudo cargar el mapa. Comprueba tu conexión e inténtalo nuevamente.";
        elementoMapa.classList.add("mapa-error");
        return;
    }

    window.map = L.map(elementoMapa, { zoomControl: true })
        .setView([-12.0990, -77.0360], 15);
    const query = new URLSearchParams(window.location.search);
    const latitudeValue = query.get("lat");
    const longitudeValue = query.get("lng");
    const targetLatitude = latitudeValue === null ? NaN : Number(latitudeValue);
    const targetLongitude = longitudeValue === null ? NaN : Number(longitudeValue);
    let lugarObjetivo = null;
    if (Number.isFinite(targetLatitude) && Number.isFinite(targetLongitude) &&
        targetLatitude >= -90 && targetLatitude <= 90 &&
        targetLongitude >= -180 && targetLongitude <= 180) {
        window.map.setView([targetLatitude, targetLongitude], 17);
        // Enlaces desde "Mi comunidad": ?lat=..&lng=..&tipo=..&nombre=..
        lugarObjetivo = {
            latitud: targetLatitude,
            longitud: targetLongitude,
            tipo: query.get("tipo"),
            nombre: (query.get("nombre") || "").slice(0, 120)
        };
    }
    window.grupoMarcadoresAlertas = L.layerGroup().addTo(window.map);
    window.marcadoresAlertas = [];
    const grupoMarcadoresSerenazgo = L.layerGroup().addTo(window.map);
    const grupoMarcadoresLugares = L.layerGroup().addTo(window.map);

    const tileLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: "Tiles &copy; Esri — Source: Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community"
    }).addTo(window.map);
    tileLayer.on("tileerror", function (event) {
        const status = document.getElementById("mapaTileError");
        if (status) {
            status.textContent = "El proveedor del mapa no pudo cargar algunas imágenes. Revisa tu conexión e inténtalo nuevamente.";
            status.hidden = false;
        }
        console.warn("El proveedor de mapas no pudo cargar una imagen:", event.tile && event.tile.src);
    });

    cargarAlertasGuardadas();
    mostrarLugaresCercanosEnMapa(grupoMarcadoresLugares, lugarObjetivo);
    configurarFiltrosMapa();
    configurarPerfilSidebar();
    configurarCierreSesion({
        auth,
        signOut,
        confirmationMessage: "¿Seguro que deseas cerrar sesión?",
        clearCachedSession: true
    });
    configurarModalEmergencia();
    configurarCentradoAlertas();
    configurarPeriodoMapa();
    configurarTemaMapa();
    configurarPanelAlertasMovil();
    window.addEventListener("coalerta:alertas-actualizadas", function () {
        actualizarMarcadoresMapa();
    });
    window.addEventListener("coalerta:mis-alertas-actualizadas", actualizarMarcadoresMapa);
    window.addEventListener("coalerta:patrullas-actualizadas", function (event) {
        actualizarContadorUnidades(event.detail);
    });
    window.addEventListener("coalerta:miembros-actualizados", function (event) {
        actualizarMarcadoresSerenazgo(event.detail, grupoMarcadoresSerenazgo);
    });
    window.addEventListener("coalerta:datos-listos", function (event) {
        configurarPerfilSidebar(event.detail.profile);
        configurarConsultaAlertasMapa(event.detail.profile);
        actualizarMarcadoresSerenazgo(
            window.coalertaData ? window.coalertaData.getCommunityMembers() : [],
            grupoMarcadoresSerenazgo
        );
        actualizarEstadoFirebaseMapa("connected");
    });
    window.addEventListener("coalerta:sesion-cambiada", function (event) {
        const hasUser = Boolean(event.detail && event.detail.user);
        const isReady = Boolean(window.coalertaData && window.coalertaData.isReady());
        if (!hasUser || event.detail.user.isAnonymous) configurarConsultaAlertasMapa(null);
        actualizarEstadoFirebaseMapa(event.detail && event.detail.registrationIncomplete
            ? "registration-incomplete"
            : !hasUser ? "disconnected" : isReady ? "connected" : "connecting");
    });
    window.addEventListener("coalerta:error", function (event) {
        const area = event.detail && event.detail.area;
        if (["perfil", "alertas públicas", "incidentes operativos"].includes(area)) {
            actualizarEstadoFirebaseMapa("error");
        }
    });
    window.addEventListener("coalerta:registro-incompleto", function () {
        configurarConsultaAlertasMapa(null);
    });
    onAuthStateChanged(auth, (user) => {
        if (!user || user.isAnonymous) {
            configurarConsultaAlertasMapa(null);
            return;
        }
        if (window.coalertaData && window.coalertaData.isReady()) {
            configurarConsultaAlertasMapa(window.coalertaData.getProfile());
        }
    });
    if (window.coalertaData && window.coalertaData.isReady()) {
        configurarConsultaAlertasMapa(window.coalertaData.getProfile());
        actualizarMarcadoresSerenazgo(
            window.coalertaData.getCommunityMembers(),
            grupoMarcadoresSerenazgo
        );
    }
    window.setInterval(() => {
        if (window.coalertaData && window.coalertaData.isReady()) {
            actualizarMarcadoresSerenazgo(
                window.coalertaData.getCommunityMembers(),
                grupoMarcadoresSerenazgo
            );
        }
    }, 30000);

    const botonUbicacion = document.getElementById("btnMiUbicacion");
    if (botonUbicacion) botonUbicacion.addEventListener("click", mostrarMiUbicacion);

    actualizarContadorMapa();
    actualizarEstadoFirebaseMapa("connecting");
    window.setTimeout(() => window.map && window.map.invalidateSize(), 300);
    window.addEventListener("resize", () => {
        if (window.map) window.map.invalidateSize();
    });
    if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => {
            if (window.map) window.map.invalidateSize({ pan: false });
        });
        observer.observe(elementoMapa.parentElement || elementoMapa);
    }
});

function configurarConsultaAlertasMapa(profile) {
    const communityId = String(profile && profile.comunidadId || "").trim();
    const context = communityId || "public";
    if (context === comunidadActualMapa && solicitudUbicacionMapa) return;
    comunidadActualMapa = context;

    solicitarUbicacionMapa();
    actualizarMarcadoresMapa();
}

function solicitarUbicacionMapa() {
    if (solicitudUbicacionMapa) return;
    solicitudUbicacionMapa = true;
    if (!navigator.geolocation) {
        window.coalertaUbicacionMapa = null;
        window.coalertaEstadoUbicacionMapa = "unavailable";
        window.dispatchEvent(new CustomEvent("coalerta:ubicacion-mapa-actualizada"));
        actualizarMarcadoresMapa();
        return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
        const precisionMetros = position.coords.accuracy;
        ubicacionActualMapa = {
            latitud: position.coords.latitude,
            longitud: position.coords.longitude,
            precisionMetros
        };
        window.coalertaUbicacionMapa = ubicacionActualMapa;
        if (precisionMetros > precisionMaximaUbicacionAceptableMetros) {
            console.warn("La ubicación del navegador es demasiado imprecisa para buscar alertas cercanas.");
            window.coalertaEstadoUbicacionMapa = "inaccurate";
        } else if (precisionMetros > 5000) {
            window.coalertaEstadoUbicacionMapa = "approximate";
        } else {
            window.coalertaEstadoUbicacionMapa = "ready";
        }
        window.dispatchEvent(new CustomEvent("coalerta:ubicacion-mapa-actualizada"));
        actualizarMarcadoresMapa();
    }, (error) => {
        if (error.code === 1) {
            console.info("El usuario denegó el permiso de ubicación para filtrar alertas cercanas.");
        } else {
            console.warn("No se pudo obtener la ubicación para filtrar alertas cercanas:", error);
        }
        ubicacionActualMapa = null;
        window.coalertaUbicacionMapa = null;
        window.coalertaEstadoUbicacionMapa = error.code === 1 ? "denied" : "unavailable";
        window.dispatchEvent(new CustomEvent("coalerta:ubicacion-mapa-actualizada"));
        actualizarMarcadoresMapa();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

function actualizarMarcadoresMapa() {
    if (!window.map) return;
    window.limpiarMarcadoresMapa();
    cargarAlertasGuardadas();
    actualizarContadorMapa();
    aplicarFiltrosMapa();
    window.dispatchEvent(new CustomEvent("coalerta:mapa-alertas-actualizadas"));
}

function actualizarMarcadoresSerenazgo(miembros, capa) {
    if (!capa) return;
    capa.clearLayers();
    const ahora = Date.now();
    (Array.isArray(miembros) ? miembros : []).forEach((miembro) => {
        const actualizado = miembro.ubicacionActualizadaAt
            ? new Date(miembro.ubicacionActualizadaAt).getTime()
            : NaN;
        const latitud = Number(miembro.latitud);
        const longitud = Number(miembro.longitud);
        if (miembro.rol !== "seguridad" || miembro.ubicacionCompartida !== true ||
            !Number.isFinite(actualizado) || ahora - actualizado > 2 * 60 * 1000 ||
            !Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) return;

        const marcador = L.marker([latitud, longitud], {
            icon: crearIconoMapa("fa-user-shield", "marcador-serenazgo")
        });
        const popup = document.createElement("div");
        popup.className = "popup-coalerta";
        const nombre = document.createElement("strong");
        nombre.textContent = miembro.nombre || "Personal de serenazgo";
        const tipo = document.createElement("div");
        tipo.textContent = "Personal de serenazgo · ubicación compartida";
        popup.append(nombre, tipo);
        marcador.bindPopup(popup).addTo(capa);
    });
}

function leerLugaresGuardados() {
    try {
        const guardado = JSON.parse(sessionStorage.getItem(CLAVE_LUGARES_MAPA) || "null");
        if (!guardado || !Array.isArray(guardado.lugares) ||
            !Number.isFinite(guardado.timestamp) || guardado.timestamp > Date.now() ||
            Date.now() - guardado.timestamp > VIGENCIA_LUGARES_MAPA_MS) {
            return [];
        }
        return guardado.lugares
            .map((lugar) => ({
                nombre: String(lugar.nombre || "Lugar sin nombre registrado"),
                tipo: lugar.tipo,
                latitud: Number(lugar.latitud),
                longitud: Number(lugar.longitud)
            }))
            .filter((lugar) =>
                TIPOS_LUGAR_PERMANENTES.includes(lugar.tipo) &&
                Number.isFinite(lugar.latitud) && lugar.latitud >= -90 && lugar.latitud <= 90 &&
                Number.isFinite(lugar.longitud) && lugar.longitud >= -180 && lugar.longitud <= 180);
    } catch (error) {
        console.warn("No se pudieron leer los lugares cercanos guardados:", error);
        return [];
    }
}

function crearMarcadorLugar(lugar) {
    const tipo = TIPOS_LUGAR_MAPA[lugar.tipo] || TIPOS_LUGAR_MAPA.lugar;
    const marcador = L.marker([lugar.latitud, lugar.longitud], {
        icon: crearIconoMapa(tipo.icono, tipo.color),
        zIndexOffset: -100,
        title: lugar.nombre
    });
    const popup = document.createElement("div");
    popup.className = "popup-coalerta";
    const nombre = document.createElement("strong");
    nombre.textContent = lugar.nombre;
    const detalle = document.createElement("div");
    detalle.textContent = tipo.etiqueta;
    popup.append(nombre, detalle);
    marcador.bindPopup(popup);
    return marcador;
}

// Dibuja los centros de salud y comisarías encontrados en "Mi comunidad" y,
// si se llegó desde un enlace de esa página, abre el lugar seleccionado.
function mostrarLugaresCercanosEnMapa(capa, lugarObjetivo) {
    if (!capa) return;
    capa.clearLayers();
    const margen = 0.0002; // ≈ 22 m
    let elegido = null;
    let menorDistancia = Infinity;

    leerLugaresGuardados().forEach((lugar) => {
        const marcador = crearMarcadorLugar(lugar).addTo(capa);
        if (!lugarObjetivo) return;
        const dLat = Math.abs(lugar.latitud - lugarObjetivo.latitud);
        const dLng = Math.abs(lugar.longitud - lugarObjetivo.longitud);
        if (dLat > margen || dLng > margen) return;
        // El nombre coincidente tiene prioridad; si no, el más cercano.
        const distancia = dLat + dLng - (lugar.nombre === lugarObjetivo.nombre ? 1 : 0);
        if (distancia < menorDistancia) {
            menorDistancia = distancia;
            elegido = marcador;
        }
    });

    // Lugar seleccionado que no se guarda de forma permanente (bomberos, municipalidad)
    // o cuya lista ya venció: se muestra solo ese marcador.
    if (!elegido && lugarObjetivo && lugarObjetivo.tipo) {
        elegido = crearMarcadorLugar({
            nombre: lugarObjetivo.nombre || "Lugar seleccionado",
            tipo: TIPOS_LUGAR_MAPA[lugarObjetivo.tipo] ? lugarObjetivo.tipo : "lugar",
            latitud: lugarObjetivo.latitud,
            longitud: lugarObjetivo.longitud
        }).addTo(capa);
    }
    if (elegido) elegido.openPopup();
}

function configurarPanelAlertasMovil() {
    const panel = document.querySelector(".alertas-panel");
    const toggle = document.getElementById("btnExpandirAlertas");
    const mapGrid = document.querySelector(".mapa-principal-grid");
    if (!panel || !toggle || !mapGrid) return;

    const updatePanelPosition = () => {
        document.body.style.setProperty(
            "--alertas-panel-height",
            `${panel.getBoundingClientRect().height}px`
        );
    };
    updatePanelPosition();
    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(updatePanelPosition).observe(panel);
    }

    toggle.addEventListener("click", function () {
        const expanded = panel.dataset.expanded !== "true";
        panel.dataset.expanded = String(expanded);
        mapGrid.classList.toggle("alertas-panel-expandido", expanded);
        document.body.classList.toggle("alertas-panel-expandido", expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute("aria-label", expanded
            ? "Contraer alertas cercanas"
            : "Mostrar alertas cercanas");
        toggle.querySelector("small").textContent = expanded ? "Ver menos" : "Ver todas";
        toggle.querySelector("i").className = expanded
            ? "fa-solid fa-chevron-down"
            : "fa-solid fa-chevron-up";
        updatePanelPosition();
    });
}

function actualizarEstadoFirebaseMapa(status) {
    const header = document.getElementById("estadoSistemaMapa");
    const operationTitle = document.getElementById("estadoOperacionTitulo");
    const operationDetail = document.getElementById("estadoOperacionDetalle");
    const backendStatus = document.getElementById("estadoBackendMapa");
    const stateContainer = document.querySelector(".estado-sistema");
    const labels = {
        connected: {
            header: "Conectado a CoAlerta",
            title: "Gestión CoAlerta en línea",
            detail: "No conectado a despacho municipal externo.",
            dashboard: "En línea"
        },
        connecting: {
            header: "Conectando…",
            title: "Conectando al servidor",
            detail: "Esperando conexión y autenticación.",
            dashboard: "Conectando"
        },
        error: {
            header: "Error de sincronización",
            title: "Datos no sincronizados",
            detail: "Revisa tu conexión e inténtalo nuevamente.",
            dashboard: "Sin conexión"
        },
        "registration-incomplete": {
            header: "Registro pendiente",
            title: "Completa tu registro",
            detail: "Finaliza la creación de tu cuenta para usar las alertas.",
            dashboard: "Registro pendiente"
        },
        disconnected: {
            header: "Sin sesión",
            title: "Conexión requerida",
            detail: "Inicia sesión para ver alertas en tiempo real.",
            dashboard: "Sin sesión"
        }
    };
    const current = labels[status] || labels.error;
    if (header) header.textContent = current.header;
    if (operationTitle) operationTitle.textContent = current.title;
    if (operationDetail) operationDetail.textContent = current.detail;
    if (backendStatus) backendStatus.textContent = current.dashboard;
    if (stateContainer) stateContainer.dataset.state = status;
}

function crearIconoMapa(icono, color) {
    return L.divIcon({
        className: "marcador-personalizado",
        html: `<span class="marcador-icono ${color}"><i class="fa-solid ${icono}" aria-hidden="true"></i></span>`,
        iconSize: [42, 42],
        iconAnchor: [21, 42],
        popupAnchor: [0, -42]
    });
}

function agregarMarcadorAlerta(alerta) {
    if (!window.map || !window.grupoMarcadoresAlertas) return null;
    const latitudMapa = alerta.latitudPublica ?? alerta.latitud;
    const longitudMapa = alerta.longitudPublica ?? alerta.longitud;
    if (latitudMapa === null || latitudMapa === "" ||
        longitudMapa === null || longitudMapa === "") return null;

    const latitud = Number(latitudMapa);
    const longitud = Number(longitudMapa);
    if (!Number.isFinite(latitud) || !Number.isFinite(longitud) ||
        latitud < -90 || latitud > 90 || longitud < -180 || longitud > 180) {
        return null;
    }

    const categoriasEmergencia = {
        robo: "Robo",
        sospecha: "Sospecha",
        accidente: "Accidente",
        incendio: "Incendio"
    };
    const tipo = alerta.tipo === "alerta_abierta"
        ? categoriasEmergencia[alerta.categoria] || "Emergencia inmediata"
        : alerta.tipo || "Alerta";
    const tipoClase = normalizarTipoMapa(tipo);
    const marcador = L.marker([latitud, longitud], {
        icon: obtenerIconoPorTipo(tipo)
    }).addTo(window.grupoMarcadoresAlertas);

    marcador.bindPopup(`
        <div class="popup-coalerta">
            <strong>${escapeHtml(tipo)}</strong><br>
            <span>${escapeHtml(alerta.ubicacion || "Ubicación registrada")}</span><br><br>
            ${alerta.detalle ? `<span>${escapeHtml(alerta.detalle)}</span><br><br>` : ""}
            <b>Estado:</b> ${escapeHtml(alerta.estado || "Activa")}<br>
            <b>Hora:</b> ${escapeHtml(alerta.hora || formatTime(alerta.timestamp))}
        </div>
    `);
    window.marcadoresAlertas.push({
        marcador,
        tipo: tipoClase,
        timestamp: new Date(alerta.timestamp || 0).getTime(),
        estado: alerta.estado || ""
    });
    return marcador;
}

function obtenerIconoPorTipo(tipo) {
    const categoria = normalizarTipoMapa(tipo);
    const iconos = {
        robo: ["fa-mask-face", "marcador-rojo"],
        sospechoso: ["fa-user-secret", "marcador-amarillo"],
        accidente: ["fa-truck-medical", "marcador-azul"],
        incendio: ["fa-fire", "marcador-naranja"]
    };
    const [icono, color] = iconos[categoria] || ["fa-triangle-exclamation", "marcador-rojo"];
    return crearIconoMapa(icono, color);
}

function normalizarTipoMapa(tipo) {
    const valor = String(tipo || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (valor.includes("robo")) return "robo";
    if (valor.includes("sospech")) return "sospechoso";
    if (valor.includes("accidente")) return "accidente";
    if (valor.includes("incendio")) return "incendio";
    return "otro";
}

function centrarMapa(latitud, longitud, zoom = 17) {
    const lat = Number(latitud);
    const lng = Number(longitud);
    if (!window.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    window.map.setView([lat, lng], zoom);
}

let marcadorUsuario = null;

function mostrarMiUbicacion() {
    if (!navigator.geolocation) {
        alert("Tu navegador no permite geolocalización.");
        return;
    }

    navigator.geolocation.getCurrentPosition(function (position) {
        const { latitude, longitude } = position.coords;
        ubicacionActualMapa = {
            latitud: latitude,
            longitud: longitude,
            precisionMetros: position.coords.accuracy
        };
        window.coalertaUbicacionMapa = ubicacionActualMapa;
        const precisionUsable = position.coords.accuracy <= precisionMaximaUbicacionAceptableMetros;
        const precisionSuficiente = position.coords.accuracy <= 5000;
        window.coalertaEstadoUbicacionMapa = !precisionUsable
            ? "inaccurate"
            : precisionSuficiente ? "ready" : "approximate";
        if (!precisionUsable) {
            console.warn("La ubicación del navegador es demasiado imprecisa para buscar alertas cercanas.");
        }
        window.dispatchEvent(new CustomEvent("coalerta:ubicacion-mapa-actualizada"));
        centrarMapa(latitude, longitude, 17);
        actualizarMarcadoresMapa();

        if (marcadorUsuario) window.map.removeLayer(marcadorUsuario);
        marcadorUsuario = L.marker([latitude, longitude], {
            icon: crearIconoMapa("fa-location-dot", "marcador-verde")
        }).addTo(window.map);
        marcadorUsuario.bindPopup(!precisionUsable
            ? "<div class=\"popup-coalerta\"><strong>Ubicación demasiado imprecisa</strong><br>No se pueden filtrar alertas cercanas con esta ubicación.</div>"
            : precisionSuficiente
            ? "<div class=\"popup-coalerta\"><strong>Tu ubicación</strong><br>Estás aquí actualmente.</div>"
            : "<div class=\"popup-coalerta\"><strong>Ubicación aproximada</strong><br>Las alertas se filtran en un radio de 5 km alrededor de esta ubicación estimada.</div>");
        marcadorUsuario.openPopup();
    }, function (error) {
        console.error("No se pudo obtener la ubicación:", error);
        const mensajes = {
            1: "Debes permitir el acceso a tu ubicación.",
            2: "No se pudo determinar tu ubicación.",
            3: "La solicitud de ubicación tardó demasiado."
        };
        ubicacionActualMapa = null;
        window.coalertaUbicacionMapa = null;
        window.coalertaEstadoUbicacionMapa = error.code === 1 ? "denied" : "unavailable";
        window.dispatchEvent(new CustomEvent("coalerta:ubicacion-mapa-actualizada"));
        actualizarMarcadoresMapa();
        alert(mensajes[error.code] || "No se pudo obtener tu ubicación.");
    }, {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
    });
}

function cargarAlertasGuardadas() {
    const data = window.coalertaData;
    const profile = data && data.isReady() ? data.getProfile() : null;
    const communityId = String(profile && profile.comunidadId || "").trim();
    const ownAlerts = data ? data.getMyAlerts() : [];
    const ownAlertIds = new Set(ownAlerts.map((alerta) => String(alerta.id)));
    const alerts = new Map((data ? data.getAlerts() : []).map((alerta) => [String(alerta.id), alerta]));
    const now = Date.now();
    const recentAlertCutoff = now - 60 * 60 * 1000;
    ownAlerts.forEach((alerta) => {
        const id = String(alerta.id);
        alerts.set(id, {
            ...alerts.get(id),
            ...alerta,
            id,
            esReportePropio: true
        });
    });
    const activas = Array.from(alerts.values()).filter((alerta) => {
        if (["Descartada", "Emergencia Concluida"].includes(alerta.estado)) return false;
        const timestamp = new Date(alerta.timestamp || 0).getTime();
        if (!Number.isFinite(timestamp) || timestamp < recentAlertCutoff || timestamp > now) return false;
        const ownAlert = ownAlertIds.has(String(alerta.id));
        if (communityId) {
            if (alerta.comunidadId !== communityId) return false;
        } else if (!ownAlert && alerta.visibilidad !== "publica" && alerta.tipo !== "alerta_abierta") {
            return false;
        }
        if (!ubicacionActualMapa ||
            !["ready", "approximate"].includes(window.coalertaEstadoUbicacionMapa)) return false;
        const latitud = Number(alerta.latitudPublica ?? alerta.latitud);
        const longitud = Number(alerta.longitudPublica ?? alerta.longitud);
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) return false;
        return data && data.distanceMeters
            ? data.distanceMeters(
                ubicacionActualMapa,
                { latitud, longitud }
            ) <= 5000
            : distanciaHaversine(ubicacionActualMapa, { latitud, longitud }) <= 5000;
    });
    window.coalertaAlertasMapa = activas;
    activas.forEach(agregarMarcadorAlerta);
    return activas.length;
}

function distanciaHaversine(first, second) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = radians(second.latitud - first.latitud);
    const longitudeDelta = radians(second.longitud - first.longitud);
    const a = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(radians(first.latitud)) * Math.cos(radians(second.latitud)) *
        Math.sin(longitudeDelta / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

window.agregarAlertaAlMapa = function (alertaOrType, latitud, longitud, ubicacion = "Ubicación registrada") {
    const alerta = typeof alertaOrType === "object"
        ? alertaOrType
        : {
            tipo: alertaOrType,
            latitud,
            longitud,
            ubicacion,
            prioridad: obtenerPrioridadPorTipo(alertaOrType)
        };
    const marcador = agregarMarcadorAlerta(alerta);
    if (marcador) {
        centrarMapa(latitud, longitud, 17);
        aplicarFiltrosMapa();
    }
};

function obtenerPrioridadPorTipo(tipo) {
    const categoria = normalizarTipoMapa(tipo);
    return ["robo", "incendio", "accidente"].includes(categoria) ? "Alta" : "Media";
}

window.limpiarMarcadoresMapa = function () {
    if (!window.grupoMarcadoresAlertas) return;
    window.grupoMarcadoresAlertas.clearLayers();
    window.marcadoresAlertas = [];
};

window.actualizarMapa = function () {
    if (window.map) window.map.invalidateSize();
};

function configurarCentradoAlertas() {
    const contenedor = document.getElementById("alertasLista");
    if (!contenedor) return;

    contenedor.addEventListener("click", function (evento) {
        const boton = evento.target.closest(".btn-ver-mapa");
        if (!boton) return;

        const latitud = Number(boton.dataset.lat);
        const longitud = Number(boton.dataset.lng);
        if (Number.isFinite(latitud) && Number.isFinite(longitud)) {
            centrarMapa(latitud, longitud, 18);
        }
    });
}

function configurarFiltrosMapa() {
    const boton = document.getElementById("btnFiltros");
    const panel = document.getElementById("panelFiltros");
    if (!boton || !panel) return;

    boton.addEventListener("click", function () {
        panel.hidden = !panel.hidden;
        boton.setAttribute("aria-expanded", String(!panel.hidden));
    });
    panel.querySelectorAll('input[type="checkbox"]').forEach((control) => {
        control.addEventListener("change", aplicarFiltrosMapa);
    });

    const listaAlertas = document.getElementById("alertasLista");
    if (listaAlertas && typeof MutationObserver !== "undefined") {
        const observer = new MutationObserver(aplicarFiltrosMapa);
        observer.observe(listaAlertas, { childList: true });
    }
}

function aplicarFiltrosMapa() {
    const panel = document.getElementById("panelFiltros");
    if (!panel) return;

    const seleccionados = new Set(
        Array.from(panel.querySelectorAll('input[type="checkbox"]:checked'))
            .map((control) => control.value)
    );

    const filtroTiempo = document.getElementById("filtroTiempoMapa");
    const periodo = filtroTiempo ? filtroTiempo.value : "all";
    (window.marcadoresAlertas || []).forEach(({ marcador, tipo, timestamp }) => {
        const coincideCategoria = seleccionados.has(tipo);
        const edad = Date.now() - timestamp;
        const coincideTiempo = periodo === "all" ||
            (periodo === "hour" && edad <= 60 * 60 * 1000) ||
            (periodo === "today" && new Date(timestamp).toDateString() === new Date().toDateString()) ||
            (periodo === "week" && edad <= 7 * 24 * 60 * 60 * 1000);
        if (coincideCategoria && coincideTiempo) {
            if (!window.grupoMarcadoresAlertas.hasLayer(marcador)) {
                window.grupoMarcadoresAlertas.addLayer(marcador);
            }
        } else {
            window.grupoMarcadoresAlertas.removeLayer(marcador);
        }
    });

    let records = [];
    try {
        records = JSON.parse(localStorage.getItem("coalertaAlertas") || "[]");
        if (!Array.isArray(records)) throw new Error("La lista guardada no es válida.");
    } catch (error) {
        console.error("No se pudieron leer las alertas para aplicar el filtro temporal:", error);
    }
    document.querySelectorAll("#alertasLista .alerta-item").forEach((alerta) => {
        const item = records.find((record) => String(record.id) === alerta.dataset.id);
        const date = new Date(item && item.timestamp || 0);
        const age = Date.now() - date.getTime();
        const timeMatches = periodo === "all" ||
            (periodo === "hour" && age <= 60 * 60 * 1000) ||
            (periodo === "today" && date.toDateString() === new Date().toDateString()) ||
            (periodo === "week" && age <= 7 * 24 * 60 * 60 * 1000);
        alerta.hidden = !seleccionados.has(normalizarTipoMapa(alerta.dataset.tipo)) || !timeMatches;
    });
}

function configurarPerfilSidebar(profileOverride) {
    let usuario = profileOverride || {};
    if (!profileOverride) {
        try {
            usuario = JSON.parse(localStorage.getItem("coalerta_usuario")) || {};
        } catch (error) {
            console.error("No se pudieron cargar los datos de usuario:", error);
        }
    }

    const nombre = usuario.nombre ||
        [usuario.nombres, usuario.apellidos].filter(Boolean).join(" ") ||
        "usuario";
    const nombreElemento = document.getElementById("sidebarNombre");
    const rolElemento = document.getElementById("sidebarRol");
    if (nombreElemento) nombreElemento.textContent = `Hola, ${nombre.trim().split(/\s+/)[0]}`;
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

function configurarModalEmergencia() {
    const modal = document.getElementById("modalEmergencia");
    const botonAbrir = document.getElementById("btnEmergencia");
    const botonMobile = document.getElementById("btnEmergenciaMobile");
    const botonCerrar = document.getElementById("cerrarModal");
    const cerrar = () => {
        if (typeof window.cancelAlertCountdown === "function") {
            window.cancelAlertCountdown();
        }
        if (modal) modal.classList.remove("mostrar");
    };
    const abrir = () => {
        if (typeof window.resetAlertModal === "function") window.resetAlertModal();
        if (modal) modal.classList.add("mostrar");
    };

    if (botonAbrir) botonAbrir.addEventListener("click", abrir);
    if (botonMobile) botonMobile.addEventListener("click", abrir);
    if (botonCerrar) botonCerrar.addEventListener("click", cerrar);
    if (modal) {
        modal.addEventListener("click", (evento) => {
            if (evento.target === modal) cerrar();
        });
    }
    document.addEventListener("keydown", (evento) => {
        if (evento.key === "Escape") cerrar();
    });
}

function actualizarContadorMapa() {
    const contador = document.getElementById("contadorAlertas");
    if (!contador) return;

    try {
        const alertas = Array.isArray(window.coalertaAlertasMapa)
            ? window.coalertaAlertasMapa
            : window.coalertaData ? window.coalertaData.getAlerts() : [];
        contador.textContent = String(Array.isArray(alertas)
            ? alertas.filter((alerta) => !["Descartada", "Emergencia Concluida"].includes(alerta.estado)).length
            : 0);
    } catch (error) {
        console.error("No se pudo actualizar el contador de alertas:", error);
    }
}

function configurarPeriodoMapa() {
    const filtro = document.getElementById("filtroTiempoMapa");
    if (filtro) filtro.addEventListener("change", aplicarFiltrosMapa);
    actualizarContadorUnidades();
}

function configurarTemaMapa() {
    const button = document.getElementById("btnModoOscuroMapa");
    if (!button) return;
    const saved = localStorage.getItem("coalertaTemaMapa");
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const night = saved ? saved === "oscuro" : minutes >= 18 * 60 + 30 || minutes < 6 * 60;
    document.body.classList.toggle("mapa-nocturno", night);
    button.textContent = night ? "Modo claro" : "Modo nocturno";
    button.addEventListener("click", function () {
        const enable = !document.body.classList.contains("mapa-nocturno");
        document.body.classList.toggle("mapa-nocturno", enable);
        localStorage.setItem("coalertaTemaMapa", enable ? "oscuro" : "claro");
        button.textContent = enable ? "Modo claro" : "Modo nocturno";
    });
}

function actualizarContadorUnidades() {
    const counter = document.getElementById("contadorUnidades");
    if (!counter) return;
    const patrols = window.coalertaData ? window.coalertaData.getPatrols() : [];
    counter.textContent = String(patrols.filter((patrol) => patrol.estado !== "Fuera de servicio").length);
}

function formatTime(timestamp) {
    const date = new Date(timestamp || 0);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}
