/* =========================================================
   COALERTA - UBICACION DE SESION
========================================================= */
(function () {
    let solicitudEnCurso = null;
    const claveUbicacion = "coalerta_ubicacion_sesion";
    const vigenciaMs = 15 * 60 * 1000;

    window.coalertaObtenerUbicacionActual = function (forzarActualizacion) {
        if (solicitudEnCurso) return solicitudEnCurso;

        if (!forzarActualizacion) {
            try {
                const guardada = JSON.parse(sessionStorage.getItem(claveUbicacion) || "null");
                if (guardada &&
                    Number.isFinite(guardada.latitud) &&
                    Number.isFinite(guardada.longitud) &&
                    Number.isFinite(guardada.timestamp) &&
                    guardada.timestamp <= Date.now() &&
                    Date.now() - guardada.timestamp < vigenciaMs) {
                    return Promise.resolve(guardada);
                }
            } catch (error) {
                console.error("No se pudo leer la ubicación temporal de esta sesión:", error);
            }
        }

        solicitudEnCurso = new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error("Este navegador no permite obtener la ubicación."));
                return;
            }
            if (!window.isSecureContext) {
                reject(new Error("La ubicación requiere HTTPS o localhost."));
                return;
            }

            navigator.geolocation.getCurrentPosition((position) => {
                const ubicacion = {
                    latitud: position.coords.latitude,
                    longitud: position.coords.longitude,
                    timestamp: Date.now()
                };
                try {
                    sessionStorage.setItem(claveUbicacion, JSON.stringify(ubicacion));
                } catch (error) {
                    console.error("No se pudo guardar la ubicación temporal de esta sesión:", error);
                }
                resolve(ubicacion);
            }, (error) => {
                const mensajes = {
                    1: "No se concedió permiso de ubicación.",
                    2: "No se pudo determinar tu ubicación.",
                    3: "La solicitud de ubicación tardó demasiado."
                };
                reject(new Error(mensajes[error.code] || "No se pudo obtener tu ubicación."));
            }, {
                enableHighAccuracy: false,
                timeout: 12000,
                maximumAge: forzarActualizacion ? 0 : 60000
            });
        }).finally(() => {
            solicitudEnCurso = null;
        });

        return solicitudEnCurso;
    };
})();
