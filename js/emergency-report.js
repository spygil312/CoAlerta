(function () {
    const button = document.getElementById("btnEmergenciaAnonima");
    const status = document.getElementById("estadoEmergenciaAnonima");
    const gpsConsent = document.getElementById("consentimientoGPS");
    const alertGrid = document.querySelector(".alertas-grid");
    const detailInput = document.getElementById("detalleEmergenciaAnonima");
    const detailCounter = document.getElementById("contadorDetalleEmergenciaAnonima");
    const countdown = document.getElementById("confirmacionCuentaRegresivaAnonima");
    const countdownNumber = document.getElementById("cuentaRegresivaNumeroAnonima");
    const progress = document.getElementById("cuentaRegresivaProgresoAnonima");
    const cancelButton = document.getElementById("btnCancelarAlertaAnonima");
    let activeTimer = null;
    let sending = false;

    if (!button || !status || !gpsConsent || !alertGrid || !countdown) return;

    if (detailInput && detailCounter) {
        detailInput.addEventListener("input", () => {
            detailCounter.textContent = String(detailInput.value.length);
        });
    }

    button.addEventListener("click", function () {
        alertGrid.scrollIntoView({ behavior: "smooth", block: "center" });
        const firstCategory = alertGrid.querySelector("button");
        if (firstCategory) firstCategory.focus({ preventScroll: true });
        status.hidden = false;
        status.textContent = "Selecciona Robo, Sospecha, Accidente o Incendio para iniciar una alerta.";
        status.className = "estado-envio-alerta estado-envio-info estado-emergencia-directa";
    });

    alertGrid.querySelectorAll("[data-emergencia]").forEach((categoryButton) => {
        categoryButton.addEventListener("click", () => startCountdown(categoryButton.dataset.emergencia));
    });
    if (cancelButton) cancelButton.addEventListener("click", cancelCountdown);

    function startCountdown(category) {
        if (activeTimer || sending) return;
        if (!gpsConsent.checked) {
            showStatus("Debes aceptar el uso de tu ubicación GPS antes de reportar la emergencia.", "error");
            return;
        }
        if (!navigator.geolocation || !window.isSecureContext) {
            showStatus("La ubicación requiere un navegador compatible y una conexión HTTPS. No se envió ninguna alerta.", "error");
            return;
        }

        alertGrid.hidden = true;
        status.hidden = true;
        countdown.hidden = false;
        countdownNumber.textContent = "3";
        progress.style.width = "0%";
        if (detailInput) detailInput.disabled = true;
        const detail = detailInput ? detailInput.value.trim() : "";
        const positionResult = getCurrentPosition()
            .then((position) => ({ position }))
            .catch((error) => ({ error }));
        const startedAt = Date.now();
        const duration = 3000;

        activeTimer = window.setInterval(() => {
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, duration - elapsed);
            countdownNumber.textContent = String(Math.ceil(remaining / 1000));
            progress.style.width = `${Math.min(100, elapsed / duration * 100)}%`;
            if (remaining > 0) return;

            window.clearInterval(activeTimer);
            activeTimer = null;
            if (navigator.vibrate) navigator.vibrate([100, 50, 180]);
            sendAlert(category, detail, positionResult);
        }, 50);
    }

    function cancelCountdown() {
        if (!activeTimer) return;
        window.clearInterval(activeTimer);
        activeTimer = null;
        if (detailInput) detailInput.disabled = false;
        countdown.hidden = true;
        alertGrid.hidden = false;
        progress.style.width = "0%";
        showStatus("Alerta cancelada", "info");
    }

    async function sendAlert(category, detail, positionResult) {
        sending = true;
        alertGrid.querySelectorAll("[data-emergencia]").forEach((item) => {
            item.disabled = true;
        });
        showStatus("Obteniendo ubicación y enviando la alerta…", "info");
        try {
            const result = await positionResult;
            if (result.error) {
                if (["location/permission-denied", "location/unavailable"].includes(result.error.code)) {
                    throw createLocationError(
                        result.error.code,
                        "Activa la ubicación en los ajustes del dispositivo y permite el acceso en el navegador. No se envió ninguna alerta."
                    );
                }
                throw createLocationError(
                    "location/timeout",
                    "La ubicación tardó demasiado. Inténtalo nuevamente en un lugar con señal GPS. No se envió ninguna alerta."
                );
            }
            const { latitude, longitude, accuracy } = result.position.coords;
            if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
                !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
                throw new Error("El dispositivo devolvió una ubicación no válida.");
            }
            const precisionMetros = esEntornoLocal() ? 4 : accuracy;
            if (!Number.isFinite(precisionMetros) || precisionMetros >= 5) {
                throw createLocationError(
                    "location/precision-insufficient",
                    `La precisión GPS debe ser menor a 5 metros (actual: ±${Number(precisionMetros).toFixed(2)} m). Busca una señal más precisa e inténtalo nuevamente. No se envió ninguna alerta.`
                );
            }
            if (!gpsConsent.checked) {
                throw createLocationError(
                    "location/consent",
                    "Debes mantener aceptado el uso de tu ubicación GPS para reportar la emergencia."
                );
            }

            const direccion = typeof window.coalertaGeocodificarInverso === "function"
                ? await window.coalertaGeocodificarInverso(latitude, longitude)
                : "";
            const alertId = await submitEmergencyReport(
                latitude,
                longitude,
                precisionMetros,
                category,
                detail,
                direccion,
                (attempt) => showStatus(
                    `Conexión inestable. Reintentando el envío de la emergencia (intento ${attempt + 1})…`,
                    "info"
                )
            );
            gpsConsent.checked = false;
            if (detailInput) detailInput.value = "";
            if (detailCounter) detailCounter.textContent = "0";
            if (detailInput) detailInput.disabled = false;
            countdown.hidden = true;
            showStatus(
                `Emergencia registrada${direccion ? ` en ${direccion}` : ""}. Código: ${alertId}.`,
                "success"
            );
        } catch (error) {
            console.error("No se pudo enviar la emergencia:", error);
            if (detailInput) detailInput.disabled = false;
            alertGrid.hidden = false;
            countdown.hidden = true;
            showStatus(getUserMessage(error), "error");
        } finally {
            sending = false;
            alertGrid.querySelectorAll("[data-emergencia]").forEach((item) => {
                item.disabled = false;
            });
        }
    }

    function showStatus(message, type) {
        status.textContent = message;
        status.className = `estado-envio-alerta estado-envio-${type} estado-emergencia-directa`;
        status.hidden = false;
    }

    async function submitEmergencyReport(lat, lng, precisionMetros, categoria, detalle, direccion, onRetry) {
        let signInAnonymously;
        let collection;
        let doc;
        let getDocFromServer;
        let serverTimestamp;
        let writeBatch;
        let auth;
        let db;
        try {
            const [authSdk, firestoreSdk, config] = await Promise.all([
                import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"),
                import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"),
                import("./firebase-config.js?v=spark-direct-firestore-1")
            ]);
            ({ signInAnonymously } = authSdk);
            ({ collection, doc, getDocFromServer, serverTimestamp, writeBatch } = firestoreSdk);
            ({ auth, db } = config);
        } catch (error) {
            console.error("No se pudieron cargar las dependencias de Firebase para la emergencia:", error);
            throw new Error(
                "No se pudo conectar con el servicio de emergencias. Comprueba tu conexión e inténtalo nuevamente."
            );
        }

        let user = auth.currentUser;
        if (!user) {
            const credential = await signInAnonymously(auth);
            user = credential.user;
        }

        const alertRef = doc(collection(db, "alertas"));
        const throttleRef = doc(db, "limites_alertas_abiertas", user.uid);
        const alert = {
            tipo: "alerta_abierta",
            comunidadId: null,
            ubicacion: { lat, lng, ...(direccion ? { direccion } : {}) },
            categoria,
            precisionMetros,
            detalle,
            creadorId: user.uid,
            timestamp: serverTimestamp(),
            estado: "pendiente",
            consentimientoGPS: true
        };

        for (let attempt = 1; ; attempt += 1) {
            const batch = writeBatch(db);
            batch.set(alertRef, alert);
            batch.set(throttleRef, {
                uid: user.uid,
                ultimaAlertaAt: serverTimestamp()
            });

            try {
                await batch.commit();
                return alertRef.id;
            } catch (error) {
                const existingAlert = await findPersistedAlert(
                    getDocFromServer,
                    alertRef,
                    user.uid,
                    lat,
                    lng,
                    categoria,
                    detalle
                );
                if (existingAlert) return alertRef.id;
                if (!isRetryableError(error)) throw error;

                if (typeof onRetry === "function") onRetry(attempt, error);
                await wait(1000);
            }
        }
    }

    async function findPersistedAlert(getDocFromServer, alertRef, uid, lat, lng, categoria, detalle) {
        try {
            const snapshot = await getDocFromServer(alertRef);
            if (!snapshot.exists()) return false;

            const alert = snapshot.data();
            return alert.creadorId === uid
                && alert.tipo === "alerta_abierta"
                && alert.categoria === categoria
                && alert.detalle === detalle
                && alert.ubicacion?.lat === lat
                && alert.ubicacion?.lng === lng;
        } catch (error) {
            if (error.code === "unavailable" ||
                error.code === "deadline-exceeded" ||
                error.code === "network-request-failed") {
                return false;
            }
            if (error.code === "permission-denied") {
                const confirmationError = new Error(
                    "No se pudo verificar si Firebase guardó el reporte. Publica las reglas actualizadas de Firestore e inténtalo nuevamente."
                );
                confirmationError.code = "emergency/confirmation-permission-denied";
                throw confirmationError;
            }
            throw error;
        }
    }

    function isRetryableError(error) {
        return [
            "aborted",
            "cancelled",
            "deadline-exceeded",
            "internal",
            "network-request-failed",
            "resource-exhausted",
            "unknown",
            "unavailable"
        ].includes(error.code);
    }

    function wait(durationMs) {
        return new Promise((resolve) => window.setTimeout(resolve, durationMs));
    }

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

    function esEntornoLocal() {
        return window.coalertaEsEntornoLocal();
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
        if (error.code === "emergency/confirmation-permission-denied") {
            return error.message;
        }
        if (error.code === "unavailable" || error.code === "auth/network-request-failed") {
            return "No se pudo conectar con Firebase. Revisa tu conexión e inténtalo nuevamente.";
        }
        return error.message || "No se pudo enviar la emergencia. Inténtalo nuevamente o contacta al administrador.";
    }
})();
