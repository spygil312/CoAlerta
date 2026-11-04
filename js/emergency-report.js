(function () {
    const button = document.getElementById("btnEmergenciaAnonima");
    const status = document.getElementById("estadoEmergenciaAnonima");
    if (!button || !status) return;

    button.addEventListener("click", async function () {
        status.hidden = false;
        if (!window.confirm(
            "Para enviar la emergencia, CoAlerta necesita compartir tu ubicación actual con el personal de seguridad. ¿Deseas continuar?"
        )) {
            status.textContent =
                "No se envió la emergencia porque no se compartió la ubicación.";
            return;
        }

        button.disabled = true;
        status.textContent = "Solicitando acceso a tu ubicación GPS…";

        try {
            const position = await getCurrentPosition();
            const { latitude, longitude } = position.coords;
            if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
                !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
                throw new Error("El dispositivo devolvió una ubicación no válida.");
            }

            status.textContent = "Enviando la emergencia con tu ubicación…";
            let service;
            try {
                service = await import(
                    "./emergency-report-service.js?v=emergency-report-service-20261102"
                );
            } catch (error) {
                console.error("No se pudo cargar el servicio de emergencias:", error);
                throw new Error(
                    "No se pudo conectar con el servicio de emergencias. Comprueba tu conexión e inténtalo nuevamente."
                );
            }
            const { submitEmergencyReport } = service;
            await submitEmergencyReport(latitude, longitude);
            status.textContent =
                "Emergencia registrada con tu ubicación. Mantén el teléfono disponible.";
        } catch (error) {
            console.error("No se pudo enviar la emergencia inmediata:", error);
            status.textContent = getUserMessage(error);
        } finally {
            button.disabled = false;
        }
    });

    function getCurrentPosition() {
        if (!navigator.geolocation) {
            return Promise.reject(createLocationError(
                "location/unsupported",
                "Este navegador no permite obtener la ubicación GPS."
            ));
        }
        if (!window.isSecureContext) {
            return Promise.reject(createLocationError(
                "location/insecure-context",
                "La ubicación solo funciona en una conexión HTTPS o en localhost."
            ));
        }

        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                resolve,
                (error) => {
                    const locationErrors = {
                        1: createLocationError(
                            "location/permission-denied",
                            "El navegador bloqueó el permiso de ubicación."
                        ),
                        2: createLocationError(
                            "location/unavailable",
                            "El dispositivo no pudo determinar tu ubicación. Comprueba que los servicios de ubicación estén activados."
                        ),
                        3: createLocationError(
                            "location/timeout",
                            "La solicitud de ubicación tardó demasiado. Inténtalo nuevamente en un lugar con mejor señal."
                        )
                    };
                    reject(locationErrors[error.code] || createLocationError(
                        "location/unknown",
                        "No se pudo obtener tu ubicación GPS. Inténtalo nuevamente."
                    ));
                },
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        });
    }

    function createLocationError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function getUserMessage(error) {
        if (error.code === "location/permission-denied") {
            return "No se autorizó la ubicación. En la configuración del sitio en tu navegador, permite el acceso a la ubicación y vuelve a intentarlo. Si ya está permitido, revisa también los permisos de ubicación del dispositivo.";
        }
        if (error.code === "location/insecure-context") {
            return "No se pudo acceder al GPS porque la página no usa HTTPS. Abre CoAlerta con su dirección segura (HTTPS) e inténtalo nuevamente.";
        }
        if (error.code && error.code.startsWith("location/")) {
            return error.message;
        }
        if (error.code === "auth/admin-restricted-operation" ||
            error.code === "auth/operation-not-allowed") {
            return "Firebase todavía no permite reportes sin iniciar sesión. El administrador debe habilitar el método Anónimo en Authentication > Sign-in method.";
        }
        if (error.code === "permission-denied") {
            return "No se pudo registrar la emergencia. Inténtalo nuevamente más tarde o contacta al administrador.";
        }
        if (error.code === "unavailable" || error.code === "auth/network-request-failed") {
            return "No se pudo conectar con Firebase. Revisa tu conexión e inténtalo nuevamente.";
        }
        return "No se pudo enviar la emergencia. Inténtalo nuevamente o contacta al administrador.";
    }
})();
