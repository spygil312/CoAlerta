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

    window.coalertaEsEntornoLocal = function () {
        return ["localhost", "127.0.0.1"].includes(window.location.hostname);
    };

    window.coalertaFormatearDistancia = function (metros) {
        return metros < 1000
            ? `${Math.round(metros)} m`
            : `${(metros / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} km`;
    };

    window.coalertaGeocodificarInverso = async function (latitud, longitud) {
        const params = new URLSearchParams({
            format: "jsonv2",
            lat: String(latitud),
            lon: String(longitud),
            zoom: "18",
            addressdetails: "1"
        });
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 4000);
        let direccion = "";

        try {
            const response = await fetch(
                `https://nominatim.openstreetmap.org/reverse?${params}`,
                {
                    headers: { "Accept-Language": "es" },
                    signal: controller.signal
                }
            );
            if (!response.ok) {
                throw new Error(`Nominatim respondió con estado ${response.status}.`);
            }
            const result = await response.json();
            const address = result.address || {};
            const street = address.road || address.pedestrian || address.residential ||
                address.street || address.path || "";
            const district = address.city_district || address.suburb || address.borough ||
                address.city || address.town || address.village || address.municipality ||
                address.county || "";
            direccion = (street && district && street !== district
                ? `${street}, ${district}`
                : street || district || String(result.display_name || "").split(",").slice(0, 2).join(", "))
                .trim().slice(0, 200);
        } catch (error) {
            console.warn("No se pudo geocodificar la ubicación con Nominatim:", error);
        } finally {
            window.clearTimeout(timeout);
        }

        if (direccion) return direccion;

        const photonController = new AbortController();
        const photonTimeout = window.setTimeout(() => photonController.abort(), 4000);
        try {
            const photonParams = new URLSearchParams({
                lat: String(latitud),
                lon: String(longitud),
                lang: "es"
            });
            const response = await fetch(
                `https://photon.komoot.io/reverse?${photonParams}`,
                { signal: photonController.signal }
            );
            if (!response.ok) {
                throw new Error(`Photon respondió con estado ${response.status}.`);
            }
            const result = await response.json();
            const properties = result.features && result.features[0] &&
                result.features[0].properties || {};
            const street = [properties.street, properties.housenumber]
                .filter(Boolean).join(" ") || properties.name || "";
            const district = properties.district || properties.city || properties.county ||
                properties.state || "";
            return (street && district && street !== district
                ? `${street}, ${district}`
                : street || district).trim().slice(0, 200);
        } catch (error) {
            console.warn("No se pudo geocodificar la ubicación con Photon:", error);
            return "";
        } finally {
            window.clearTimeout(photonTimeout);
        }
    };
})();
