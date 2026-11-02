/* =========================================================
   COALERTA - ALERTAS CERCANAS EN LA CAMPANA
========================================================= */
window.coalertaClaveAlerta = function (alerta) {
    if (alerta && alerta.id !== undefined && alerta.id !== null) {
        return `id:${String(alerta.id)}`;
    }

    return `legacy:${JSON.stringify([
        alerta && alerta.tipo || "",
        alerta && alerta.latitud || "",
        alerta && alerta.longitud || "",
        alerta && alerta.timestamp || "",
        alerta && alerta.fecha || "",
        alerta && alerta.hora || "",
        alerta && alerta.ubicacion || ""
    ])}`;
};

window.coalertaMarcarAlertaLeida = async function (alerta) {
    if (!alerta || typeof alerta !== "object" || !alerta.id) {
        throw new Error("No se puede marcar como leída una alerta sin identificador.");
    }
    if (!window.coalertaData || !window.coalertaData.isReady()) {
        throw new Error("Inicia sesión para guardar el estado de lectura.");
    }
    await window.coalertaData.markAlertRead(alerta.id);
};

window.coalertaSonidoEmergencia = (function () {
    let audioContext = null;

    function getAudioContext() {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) return null;
        if (!audioContext) audioContext = new AudioContextConstructor();
        return audioContext;
    }

    function unlock() {
        const context = getAudioContext();
        if (!context || context.state === "running") return Promise.resolve(Boolean(context));
        return context.resume().then(() => context.state === "running").catch((error) => {
            console.warn("El navegador no permitió activar el sonido de alertas:", error);
            return false;
        });
    }

    async function play() {
        const context = getAudioContext();
        if (!context) return false;
        if (context.state !== "running" && !(await unlock())) return false;

        const startAt = context.currentTime + 0.02;
        [880, 660].forEach((frequency, index) => {
            const start = startAt + index * 0.2;
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.18, start + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.17);
        });
        return true;
    }

    return {
        unlock,
        play,
        isEnabled: () => preferenciasSonidoAlertas.alertas !== false &&
            preferenciasSonidoAlertas.sonido !== false
    };
})();

let preferenciasSonidoAlertas = {};
try {
    const preferenceUid = typeof auth !== "undefined" && auth.currentUser ? auth.currentUser.uid : "";
    const savedPreferences = preferenceUid
        ? JSON.parse(localStorage.getItem(`coalertaPreferencias:${preferenceUid}`) || "{}")
        : {};
    if (savedPreferences && typeof savedPreferences === "object" && !Array.isArray(savedPreferences)) {
        preferenciasSonidoAlertas = savedPreferences;
    }
} catch (error) {
    console.error("No se pudieron leer las preferencias de sonido:", error);
}
window.addEventListener("coalerta:preferencias-cargadas", (event) => {
    preferenciasSonidoAlertas = event.detail && typeof event.detail === "object" ? event.detail : {};
});
window.addEventListener("coalerta:preferencias-cambiadas", (event) => {
    preferenciasSonidoAlertas = event.detail && typeof event.detail === "object" ? event.detail : {};
});
window.addEventListener("storage", (event) => {
    const uid = typeof auth !== "undefined" && auth.currentUser ? auth.currentUser.uid : "";
    if (!uid || event.key !== `coalertaPreferencias:${uid}`) return;
    try {
        const preferences = JSON.parse(event.newValue || "{}");
        preferenciasSonidoAlertas = preferences && typeof preferences === "object" &&
            !Array.isArray(preferences) ? preferences : {};
    } catch (error) {
        console.error("No se pudieron actualizar las preferencias de sonido:", error);
    }
});

document.addEventListener("DOMContentLoaded", function () {
    const boton = document.getElementById("btnNotificaciones");
    const contador = document.querySelector(".notificacion-contador");
    const menu = document.getElementById("menuNotificaciones");
    const lista = document.getElementById("notificacionesLista");
    if (!boton || !contador || !menu || !lista) return;

    let ubicacionActual = null;
    let solicitudUbicacionEnCurso = false;
    let intentoUbicacionRealizado = false;
    let alertSnapshotReady = false;
    let noticeSnapshotReady = false;
    let knownAlertIds = new Set();
    let knownNoticeIds = new Set();
    const pendingSoundAlertIds = new Set();
    const pendingSoundNoticeIds = new Set();
    contador.hidden = true;
    contador.textContent = "";
    lista.textContent = "Abre las notificaciones para consultar alertas cercanas usando tu ubicación.";

    boton.addEventListener("click", function (evento) {
        evento.stopPropagation();
        menu.hidden = !menu.hidden;
        boton.setAttribute("aria-expanded", String(!menu.hidden));
        if (!menu.hidden && !ubicacionActual && !intentoUbicacionRealizado) {
            cargarUbicacion(false);
        }
    });

    document.addEventListener("pointerdown", () => {
        if (soundEnabled()) window.coalertaSonidoEmergencia.unlock();
    }, { once: true });
    document.addEventListener("keydown", () => {
        if (soundEnabled()) window.coalertaSonidoEmergencia.unlock();
    }, { once: true });

    document.addEventListener("click", function (evento) {
        if (!boton.contains(evento.target) && !menu.contains(evento.target)) {
            menu.hidden = true;
            boton.setAttribute("aria-expanded", "false");
        }
    });

    document.addEventListener("keydown", function (evento) {
        if (evento.key === "Escape") {
            menu.hidden = true;
            boton.setAttribute("aria-expanded", "false");
        }
    });

    window.addEventListener("coalerta:alertas-actualizadas", function () {
        detectarAlertasNuevas();
        actualizarNotificaciones();
    });
    window.addEventListener("coalerta:avisos-actualizados", function () {
        detectarAvisosNuevos();
        actualizarNotificaciones();
    });
    window.addEventListener("coalerta:datos-listos", function () {
        actualizarNotificaciones();
        if (!menu.hidden && !ubicacionActual && !intentoUbicacionRealizado) {
            cargarUbicacion(false);
        }
    });
    window.addEventListener("coalerta:mis-alertas-actualizadas", actualizarNotificaciones);
    window.addEventListener("coalerta:lecturas-actualizadas", actualizarNotificaciones);
    window.addEventListener("coalerta:avisos-leidos-actualizados", actualizarNotificaciones);
    window.addEventListener("coalerta:sesion-cambiada", function () {
        alertSnapshotReady = false;
        noticeSnapshotReady = false;
        knownAlertIds = new Set();
        knownNoticeIds = new Set();
        pendingSoundAlertIds.clear();
        pendingSoundNoticeIds.clear();
        actualizarNotificaciones();
    });
    lista.addEventListener("click", function (evento) {
        const enlace = evento.target.closest("a[data-notification-type]");
        if (!enlace) return;
        evento.preventDefault();
        const marcarLeida = enlace.dataset.notificationType === "alert"
            ? window.coalertaData.markAlertRead(enlace.dataset.notificationId)
            : window.coalertaData.markNoticeRead(enlace.dataset.notificationId);
        marcarLeida.then(() => {
            window.location.href = enlace.href;
        }).catch((error) => {
            console.error("No se pudo marcar la notificación como leída:", error);
            lista.textContent = error.message || "No se pudo guardar que la alerta fue leída.";
        });
    });

    actualizarNotificaciones();
    if (typeof window.coalertaObtenerUbicacionActual !== "function") {
        lista.textContent = "No se pudo iniciar el servicio de ubicación.";
    }

    function cargarUbicacion(forzarActualizacion) {
        if (typeof window.coalertaObtenerUbicacionActual !== "function" ||
            solicitudUbicacionEnCurso || (intentoUbicacionRealizado && !forzarActualizacion)) return;
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            lista.textContent = "Inicia sesión con una cuenta activa para consultar alertas cercanas.";
            return;
        }
        solicitudUbicacionEnCurso = true;
        intentoUbicacionRealizado = true;
        actualizarNotificaciones();
        window.coalertaObtenerUbicacionActual(forzarActualizacion).then((ubicacion) => {
            ubicacionActual = ubicacion;
            actualizarNotificaciones();
        }).catch((error) => {
            console.info("No se pueden filtrar alertas cercanas sin permiso de ubicación:", error.message);
            actualizarNotificaciones();
            const mensaje = document.createElement("p");
            mensaje.className = "notificaciones-ubicacion-error";
            mensaje.textContent = `${error.message || "No se pudo obtener tu ubicación."} Puedes revisar el permiso del navegador e intentarlo de nuevo.`;
            const reintentar = document.createElement("button");
            reintentar.type = "button";
            reintentar.className = "notificacion-enlace";
            reintentar.textContent = "Intentar de nuevo";
            reintentar.addEventListener("click", () => cargarUbicacion(true));
            lista.append(mensaje, reintentar);
        }).finally(() => {
            solicitudUbicacionEnCurso = false;
        });
    }

    function actualizarNotificaciones() {
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            lista.textContent = "Inicia sesión para recibir alertas cercanas.";
            contador.hidden = true;
            contador.textContent = "";
            boton.setAttribute("aria-label", "Notificaciones");
            return;
        }
        const perfil = window.coalertaData.getProfile() || {};
        const propias = new Set(window.coalertaData.getMyAlerts()
            .map((alerta) => String(alerta.alertaId || alerta.id)));
        const avisosLeidos = new Set(window.coalertaData.getReadNotices()
            .map((aviso) => String(aviso.avisoId || aviso.id)));
        const alertas = window.coalertaData.getAlerts()
            .filter((alerta) => {
                if (!alerta || typeof alerta !== "object") return false;
                const latitud = Number(alerta.latitud);
                const longitud = Number(alerta.longitud);
                const id = String(alerta.id || "");
                const nearby = Boolean(ubicacionActual) &&
                    Number.isFinite(latitud) && Number.isFinite(longitud) &&
                    latitud >= -90 && latitud <= 90 && longitud >= -180 && longitud <= 180 &&
                    distanciaMetros(ubicacionActual.latitud, ubicacionActual.longitud, latitud, longitud) <= 5000;
                return id && !propias.has(id) && !alerta.leida &&
                    (window.coalertaData.isActive(alerta) ||
                        alerta.tipo === "alerta_abierta" &&
                        ["pendiente", "en_atencion"].includes(alerta.estado)) &&
                    (perfil.comunidadId
                        ? alerta.comunidadId === perfil.comunidadId
                        : (alerta.visibilidad === "publica" || alerta.tipo === "alerta_abierta") && nearby);
            })
            .map((alerta) => ({ ...alerta, notificationType: "alert" }));
        const avisos = window.coalertaData.getNotices()
            .filter((aviso) => {
                const id = String(aviso.id || "");
                return id && !avisosLeidos.has(id) &&
                    (!aviso.comunidadId || aviso.comunidadId === perfil.comunidadId);
            })
            .map((aviso) => ({ ...aviso, notificationType: "notice" }));
        const pendientes = [...alertas, ...avisos]
            .sort((a, b) => obtenerTimestamp(b) - obtenerTimestamp(a));
        const total = pendientes.length;

        contador.hidden = total === 0;
        contador.textContent = total > 99 ? "99+" : String(total);
        boton.setAttribute("aria-label", total
            ? `${total} notificaciones sin leer`
            : "Sin notificaciones sin leer");
        contador.setAttribute("aria-label", `${total} notificaciones sin leer`);
        lista.replaceChildren();

        if (!total) {
            const mensaje = document.createElement("p");
            mensaje.textContent = ubicacionActual || perfil.comunidadId
                ? "No tienes notificaciones sin leer."
                : "Abre las notificaciones para consultar alertas cercanas. Los avisos de tu comunidad aparecerán aquí.";
            lista.appendChild(mensaje);
            return;
        }

        pendientes.slice(0, 10).forEach((notificacion) => {
            const articulo = document.createElement("article");
            articulo.className = `notificacion-alerta notificacion-${notificacion.notificationType}`;
            const titulo = document.createElement("strong");
            titulo.textContent = notificacion.notificationType === "notice"
                ? notificacion.titulo || "Aviso de coordinación"
                : notificacion.tipo || "Alerta cercana";
            const detalle = document.createElement("p");
            if (notificacion.notificationType === "notice") {
                detalle.textContent = notificacion.mensaje || "Nuevo aviso para tu comunidad.";
            } else if (ubicacionActual) {
                const ubicacion = notificacion.ubicacion || "Ubicación registrada";
                const distancia = distanciaMetros(
                    ubicacionActual.latitud,
                    ubicacionActual.longitud,
                    Number(notificacion.latitud),
                    Number(notificacion.longitud)
                );
                detalle.textContent = `${ubicacion} · ${formatearDistancia(distancia)}`;
            } else {
                detalle.textContent = "Nueva alerta de un vecino de tu comunidad.";
            }
            const enlace = document.createElement("a");
            enlace.className = "notificacion-enlace";
            enlace.href = notificacion.notificationType === "notice"
                ? "comunidad.html#listaAvisosOficiales"
                : "mapa.html#alertasLista";
            enlace.dataset.notificationType = notificacion.notificationType;
            enlace.dataset.notificationId = String(notificacion.id);
            enlace.textContent = notificacion.notificationType === "notice"
                ? "Ver aviso"
                : "Ver en el mapa";
            articulo.append(titulo, detalle, enlace);
            lista.appendChild(articulo);
        });
        if (total > 10) {
            const restantes = document.createElement("p");
            restantes.className = "notificaciones-restantes";
            restantes.textContent = `${total - 10} notificaciones más sin leer.`;
            lista.appendChild(restantes);
        }
    }

    function soundEnabled() {
        return window.coalertaSonidoEmergencia.isEnabled();
    }

    function detectarAlertasNuevas() {
        if (!window.coalertaData || !window.coalertaData.isReady()) return;
        const profile = window.coalertaData.getProfile() || {};
        const alerts = window.coalertaData.getAlerts().filter((alert) =>
            isAlertVisibleForProfile(alert, profile)
        );
        const currentIds = new Set(alerts.map((alert) => String(alert.id)));
        if (!alertSnapshotReady) {
            knownAlertIds = currentIds;
            alertSnapshotReady = true;
            return;
        }

        alerts.forEach((alert) => {
            const id = String(alert.id);
            if (!knownAlertIds.has(id) && window.coalertaData.isActive(alert)) {
                pendingSoundAlertIds.add(id);
            }
        });
        knownAlertIds = currentIds;
        reproducirSiHayNotificacionNueva();
    }

    function detectarAvisosNuevos() {
        if (!window.coalertaData || !window.coalertaData.isReady()) return;
        const avisos = window.coalertaData.getNotices();
        const currentIds = new Set(avisos.map((aviso) => String(aviso.id)));
        if (!noticeSnapshotReady) {
            knownNoticeIds = currentIds;
            noticeSnapshotReady = true;
            return;
        }
        avisos.forEach((aviso) => {
            const id = String(aviso.id);
            if (!knownNoticeIds.has(id)) pendingSoundNoticeIds.add(id);
        });
        knownNoticeIds = currentIds;
        reproducirSiHayNotificacionNueva();
    }

    function reproducirSiHayNotificacionNueva() {
        if ((!pendingSoundAlertIds.size && !pendingSoundNoticeIds.size) || !soundEnabled()) return;
        window.setTimeout(async () => {
            const myAlertIds = new Set(window.coalertaData.getMyAlerts()
                .map((alert) => String(alert.alertaId || alert.id)));
            const profile = window.coalertaData.getProfile() || {};
            const alerts = window.coalertaData.getAlerts().filter((alert) =>
                isAlertVisibleForProfile(alert, profile)
            );
            const notices = window.coalertaData.getNotices();
            const newRemoteAlertExists = Array.from(pendingSoundAlertIds).some((id) =>
                !myAlertIds.has(id) && alerts.some((alert) =>
                    String(alert.id) === id && window.coalertaData.isActive(alert)
                )
            );
            const newNoticeExists = Array.from(pendingSoundNoticeIds).some((id) =>
                notices.some((notice) => String(notice.id) === id)
            );
            pendingSoundAlertIds.clear();
            pendingSoundNoticeIds.clear();
            if ((newRemoteAlertExists || newNoticeExists) && soundEnabled()) {
                try {
                    await window.coalertaSonidoEmergencia.play();
                } catch (error) {
                    console.error("No se pudo reproducir el sonido de una notificación nueva:", error);
                }
            }
        }, 500);
    }

    function isAlertVisibleForProfile(alert, profile) {
        if (profile.comunidadId) return alert.comunidadId === profile.comunidadId;
        if (alert.visibilidad !== "publica" && alert.tipo !== "alerta_abierta") return false;
        if (!ubicacionActual) return false;
        const point = alert.ubicacion && typeof alert.ubicacion === "object"
            ? alert.ubicacion
            : {};
        const latitud = Number(alert.latitud ?? point.lat);
        const longitud = Number(alert.longitud ?? point.lng);
        return Number.isFinite(latitud) && latitud >= -90 && latitud <= 90 &&
            Number.isFinite(longitud) && longitud >= -180 && longitud <= 180 &&
            distanciaMetros(
                ubicacionActual.latitud,
                ubicacionActual.longitud,
                latitud,
                longitud
            ) <= 5000;
    }
});

function distanciaMetros(lat1, lon1, lat2, lon2) {
    const radianes = (grados) => grados * Math.PI / 180;
    const diferenciaLat = radianes(lat2 - lat1);
    const diferenciaLon = radianes(lon2 - lon1);
    const a = Math.sin(diferenciaLat / 2) ** 2 +
        Math.cos(radianes(lat1)) * Math.cos(radianes(lat2)) *
        Math.sin(diferenciaLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatearDistancia(metros) {
    return metros < 1000
        ? `${Math.round(metros)} m`
        : `${(metros / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} km`;
}

function obtenerTimestamp(alerta) {
    const timestamp = Date.parse(alerta.timestamp || "");
    if (Number.isFinite(timestamp)) return timestamp;
    const fechaHora = Date.parse(`${alerta.fecha || ""} ${alerta.hora || ""}`);
    return Number.isFinite(fechaHora) ? fechaHora : 0;
}
