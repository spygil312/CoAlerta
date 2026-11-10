document.addEventListener("DOMContentLoaded", function () {
    const modal = document.getElementById("modalEmergencia");
    const grid = document.querySelector(".modal-alertas-grid");
    const countdown = document.getElementById("confirmacionCuentaRegresiva");
    const countdownNumber = document.getElementById("cuentaRegresivaNumero");
    const progress = document.getElementById("cuentaRegresivaProgreso");
    const cancelButton = document.getElementById("btnCancelarAlerta");
    const feedback = document.getElementById("estadoEnvioAlerta");
    const gpsConsent = document.getElementById("consentimientoGPS");
    const detailInput = document.getElementById("detalleEmergencia");
    const detailCounter = document.getElementById("contadorDetalleEmergencia");
    let activeTimer = null;
    let selectedCategory = "";
    let responseRendered = false;
    let lastResponse = "";
    let recentlySubmittedAlert = null;
    let assignedPatrolId = "";
    let assignedPatrolUnsubscribe = null;
    let assignedPatrol = null;
    let responseEtaTimer = null;

    if (detailInput && detailCounter) {
        detailInput.addEventListener("input", function () {
            detailCounter.textContent = String(detailInput.value.length);
        });
    }

    renderAlerts();
    window.addEventListener("coalerta:alertas-actualizadas", renderAlerts);
    window.addEventListener("coalerta:mapa-alertas-actualizadas", renderAlerts);
    window.addEventListener("coalerta:mis-alertas-actualizadas", renderAlerts);
    window.addEventListener("coalerta:datos-listos", renderAlerts);
    window.addEventListener("coalerta:sesion-cambiada", function () {
        recentlySubmittedAlert = null;
        configureAssignedPatrolListener(null);
        updateAlertEmissionLock(null);
        renderAlerts();
    });
    window.addEventListener("pagehide", () => configureAssignedPatrolListener(null), { once: true });
    window.addEventListener("coalerta:ubicacion-mapa-actualizada", renderAlerts);
    window.addEventListener("coalerta:alerta-reportada", function (event) {
        recentlySubmittedAlert = event.detail && event.detail.alerta || null;
        renderAlerts();
    });
    window.addEventListener("coalerta:error", function (event) {
        const detail = event.detail || {};
        if (detail.area === "delegación") {
            const ownAlerts = window.coalertaData
                ? window.coalertaData.getMyAlerts()
                : [];
            updateAlertEmissionLock(getLatestActiveOwnAlert(ownAlerts));
            renderAlerts();
            return;
        }
        if (!["alertas públicas", "tus alertas", "perfil"].includes(detail.area)) return;
        const list = document.getElementById("alertasLista");
        if (list) list.replaceChildren(makeEmpty(
            "No se pudieron cargar las alertas. Inténtalo más tarde."
        ));
    });

    document.querySelectorAll(".modal-alerta-btn").forEach((button) => {
        button.addEventListener("click", function () {
            unlockEmergencyAudio();
            if (!button.dataset.emergencia) return;
            startCountdown(button.dataset.emergencia);
        });
    });
    ["btnEmergencia", "btnEmergenciaMobile"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.addEventListener("click", unlockEmergencyAudio);
    });

    if (cancelButton) cancelButton.addEventListener("click", cancelCountdown);
    window.cancelAlertCountdown = function () {
        if (activeTimer) cancelCountdown();
    };
    window.resetAlertModal = function () {
        if (activeTimer) window.clearInterval(activeTimer);
        activeTimer = null;
        if (detailInput) detailInput.disabled = false;
        selectedCategory = "";
        if (grid) grid.hidden = false;
        if (countdown) countdown.hidden = true;
        if (feedback) {
            feedback.hidden = true;
            feedback.textContent = "";
        }
        if (gpsConsent) gpsConsent.checked = false;
        if (detailInput) detailInput.value = "";
        if (detailCounter) detailCounter.textContent = "0";
        if (progress) progress.style.width = "0%";
        updateAlertEmissionLock(getLatestActiveOwnAlert());
    };
    const refresh = document.getElementById("btnActualizar");
    if (refresh) {
        refresh.addEventListener("click", async function () {
            if (refresh.disabled) return;
            const refreshStatus = document.getElementById("estadoActualizarAlertas");
            if (!window.coalertaData) {
                if (refreshStatus) refreshStatus.textContent = "No se pudo iniciar la conexión de alertas.";
                return;
            }
            refresh.disabled = true;
            refresh.classList.add("girando");
            refresh.setAttribute("aria-label", "Actualizando alertas");
            if (refreshStatus) refreshStatus.textContent = "Actualizando…";
            try {
                await window.coalertaData.refreshAlerts();
                if (refreshStatus) {
                    refreshStatus.textContent = "Alertas actualizadas.";
                    window.setTimeout(() => {
                        if (refreshStatus.textContent === "Alertas actualizadas.") {
                            refreshStatus.textContent = "";
                        }
                    }, 3000);
                }
            } catch (error) {
                console.error("No se pudieron actualizar las alertas:", error);
                if (refreshStatus) {
                    refreshStatus.textContent = getUserFacingError(
                        error,
                        "No se pudieron actualizar las alertas. Inténtalo más tarde."
                    );
                }
            } finally {
                refresh.disabled = false;
                refresh.classList.remove("girando");
                refresh.setAttribute("aria-label", "Actualizar alertas");
            }
        });
    }

    function startCountdown(category) {
        if (activeTimer) return;
        const activeOwnAlert = getLatestActiveOwnAlert();
        if (activeOwnAlert) {
            updateAlertEmissionLock(activeOwnAlert);
            renderUserResponse(window.coalertaData.getMyAlerts());
            return;
        }
        if (!gpsConsent || !gpsConsent.checked) {
            showFailure("Debes aceptar el uso de tu ubicación GPS para enviar el reporte.");
            return;
        }
        if (!window.coalertaData) {
            showFailure("No se pudo iniciar la conexión con Firebase. Recarga la página.");
            return;
        }
        if (!navigator.geolocation || !window.isSecureContext) {
            showFailure("La ubicación requiere un navegador compatible y una conexión HTTPS. No se envió ninguna alerta.");
            return;
        }
        selectedCategory = category;
        if (grid) grid.hidden = true;
        if (feedback) {
            feedback.hidden = true;
            feedback.textContent = "";
        }
        if (countdown) countdown.hidden = false;
        if (countdownNumber) countdownNumber.textContent = "3";
        if (progress) progress.style.width = "0%";
        if (detailInput) detailInput.disabled = true;

        const positionResult = new Promise((resolve) => {
            navigator.geolocation.getCurrentPosition(
                (position) => resolve({ position }),
                (error) => resolve({ error }),
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        });
        const startedAt = Date.now();
        const duration = 3000;
        activeTimer = window.setInterval(function () {
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, duration - elapsed);
            if (countdownNumber) countdownNumber.textContent = String(Math.ceil(remaining / 1000));
            if (progress) progress.style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
            if (remaining <= 0) {
                window.clearInterval(activeTimer);
                activeTimer = null;
                if (navigator.vibrate) navigator.vibrate([100, 50, 180]);
                submitAlert(selectedCategory, positionResult);
            }
        }, 50);
    }

    function cancelCountdown() {
        if (activeTimer) window.clearInterval(activeTimer);
        activeTimer = null;
        if (countdown) countdown.hidden = true;
        if (grid) grid.hidden = false;
        if (progress) progress.style.width = "0%";
        if (feedback) {
            feedback.textContent = "Alerta cancelada";
            feedback.className = "estado-envio-alerta estado-envio-info";
            feedback.hidden = false;
        }
    }

    async function submitAlert(category, positionResult) {
        if (!gpsConsent || !gpsConsent.checked) {
            showFailure("Debes aceptar el uso de tu ubicación GPS para enviar el reporte.");
            return;
        }
        showFeedback("Enviando ...", "info", "fa-regular fa-clock");
        try {
            const result = await positionResult;
            if (result.error) {
                console.error("No se pudo obtener el GPS de la alerta:", result.error);
                if (result.error.code === 1 || result.error.code === 2) {
                    throw new Error(
                        "Activa la ubicación en los ajustes del dispositivo y permite el acceso en el navegador. No se envió ninguna alerta."
                    );
                }
                throw new Error(
                    "La ubicación tardó demasiado. Inténtalo nuevamente en un lugar con señal GPS. No se envió ninguna alerta."
                );
            }
            const position = result.position;
            const precisionMetros = esEntornoLocal()
                ? 4
                : position.coords.accuracy;
            if (!Number.isFinite(precisionMetros) || precisionMetros >= 5) {
                throw new Error(
                    `La precisión GPS debe ser menor a 5 metros (actual: ±${Number(precisionMetros).toFixed(2)} m). Busca una señal más precisa e inténtalo nuevamente. No se envió ninguna alerta.`
                );
            }
            if (!gpsConsent || !gpsConsent.checked) {
                throw new Error("Debes aceptar el uso de tu ubicación GPS para enviar el reporte.");
            }

            const normalizedCategory = window.coalertaData.normalizeCategory(category);
            const payload = {
                tipo: category,
                codigoCategoria: window.coalertaData.categoryCode(normalizedCategory),
                detalle: detailInput ? detailInput.value.trim() : "",
                latitud: position.coords.latitude,
                longitud: position.coords.longitude,
                precisionMetros,
                consentimientoGPS: gpsConsent.checked
            };
            const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
            if (payloadSize > 2048) throw new Error("El paquete de alerta supera el límite de 2 KB.");
            await window.coalertaData.waitForReady();
            const submitted = await window.coalertaData.createAlert(payload);
            const submittedAlert = {
                ...payload,
                id: submitted.incidentId,
                estado: "Recibido en servidor",
                prioridad: normalizedCategory === "sospecha" ? "Media" : "Alta",
                reportes: 1,
                timestamp: new Date().toISOString(),
                uid: window.coalertaData.getProfile().uid,
                esReporteReciente: true
            };
            window.dispatchEvent(new CustomEvent("coalerta:alerta-reportada", {
                detail: { alerta: submittedAlert }
            }));
            showFeedback("Alerta recibida por la central", "success", "fa-solid fa-circle-check");
            if (gpsConsent) gpsConsent.checked = false;
            if (detailInput) detailInput.value = "";
            if (detailCounter) detailCounter.textContent = "0";
            if (detailInput) detailInput.disabled = false;
            if (countdown) countdown.hidden = true;
            if (grid) grid.hidden = true;
        } catch (error) {
            console.error("No se pudo enviar la alerta al servidor:", error);
            if (detailInput) detailInput.disabled = false;
            showFailure(getUserFacingError(
                error,
                error.message || "No se pudo transmitir la alerta. Verifica tu conexión e inténtalo de nuevo."
            ));
        }
    }

    function renderAlerts() {
        const currentProfile = window.coalertaData && window.coalertaData.getProfile();
        if (recentlySubmittedAlert &&
            recentlySubmittedAlert.uid !== (currentProfile && currentProfile.uid)) {
            recentlySubmittedAlert = null;
        }
        const list = document.getElementById("alertasLista");
        if (!list) return;
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            const message = window.coalertaData && window.coalertaData.isRegistrationIncomplete()
                ? "Tu cuenta aún no terminó de registrarse. Completa el registro para enviar y consultar alertas."
                : window.coalertaData && window.coalertaData.getProfile()
                ? "Conectando con el servidor de alertas…"
                : "Inicia sesión para consultar alertas.";
            list.replaceChildren(makeEmpty(message));
            updateCounter(0);
            return;
        }
        const alerts = window.coalertaData.getAlerts();
        const allOwnAlerts = window.coalertaData.getMyAlerts();
        if (recentlySubmittedAlert) {
            const latestOwnStatus = allOwnAlerts.find((alert) =>
                String(alert.id || alert.alertaId) === String(recentlySubmittedAlert.id)
            );
            if (latestOwnStatus && !isTrackedActiveAlert(latestOwnStatus)) {
                recentlySubmittedAlert = null;
            }
        }
        const mapAlerts = Array.isArray(window.coalertaAlertasMapa)
            ? window.coalertaAlertasMapa
            : null;
        const ownAlerts = allOwnAlerts;
        const latestOwnActiveAlert = allOwnAlerts
            .filter((alert) =>
                window.coalertaData.isActive(alert) ||
                alert.tipo === "alerta_abierta" &&
                    ["pendiente", "en_atencion"].includes(alert.estado)
            )
            .filter(isWithinVerifiedNearbyRadius)
            .sort((first, second) =>
                new Date(second.timestamp || 0) - new Date(first.timestamp || 0)
            )[0];
        const ownedRecent = latestOwnActiveAlert
            ? [{
                ...latestOwnActiveAlert,
                id: latestOwnActiveAlert.id || latestOwnActiveAlert.alertaId,
                reportes: Number(latestOwnActiveAlert.reportes) || 1,
                esReportePropio: true
            }]
            : [];
        const ownAlertIds = new Set(ownedRecent.map((alert) => String(alert.id)));
        const visibleSource = mapAlerts || alerts;
        const activeAlerts = visibleSource.filter((alert) =>
            window.coalertaData.isActive(alert) ||
            alert.tipo === "alerta_abierta" &&
                ["pendiente", "en_atencion"].includes(alert.estado)
        );
        const responseAlerts = ownAlerts.slice();
        if (recentlySubmittedAlert &&
            !responseAlerts.some((alert) => String(alert.id || alert.alertaId) === String(recentlySubmittedAlert.id))) {
            responseAlerts.push(recentlySubmittedAlert);
        }
        renderUserResponse(responseAlerts);
        const visibleById = new Map(activeAlerts.map((alert) => [String(alert.id), alert]));
        ownedRecent.forEach((alert) => {
            const id = String(alert.id || "");
            if (id) visibleById.set(id, { ...visibleById.get(id), ...alert });
        });
        if (recentlySubmittedAlert && isWithinVerifiedNearbyRadius(recentlySubmittedAlert)) {
            visibleById.set(recentlySubmittedAlert.id, recentlySubmittedAlert);
        } else if (recentlySubmittedAlert) {
            recentlySubmittedAlert = null;
        }
        const visibleAlerts = [...visibleById.values()]
            .sort((a, b) => new Date(b.timestamp || b.ultimaActualizacion || 0) -
                new Date(a.timestamp || a.ultimaActualizacion || 0));
        list.replaceChildren();
        if (window.coalertaEstadoUbicacionMapa === "approximate") {
            const locationNotice = document.createElement("p");
            locationNotice.className = "alerta-ubicacion-aproximada";
            locationNotice.textContent =
                "Ubicación aproximada; las alertas se filtran a 5 km de la ubicación estimada.";
            list.append(locationNotice);
        }
        if (!visibleAlerts.length) {
            const locationMessages = {
                pending: "Comprobando tu ubicación para mostrar alertas cercanas…",
                denied: "Permite el acceso a tu ubicación para ver alertas cercanas.",
                inaccurate: "La ubicación es demasiado imprecisa. Activa el GPS o pulsa «Mi ubicación» para intentarlo de nuevo.",
                unavailable: "No se pudo obtener tu ubicación. Revisa los permisos del navegador."
            };
            list.append(makeEmpty(
                locationMessages[window.coalertaEstadoUbicacionMapa] ||
                "No hay alertas activas cerca de tu ubicación."
            ));
        } else {
            visibleAlerts.slice(0, 3).forEach((alert) =>
                list.append(createAlertCard(
                    alert,
                    ownAlertIds.has(String(alert.id)) || Boolean(alert.esReporteReciente)
                ))
            );
        }
        const historyLink = document.createElement("a");
        historyLink.className = "alertas-ver-historial";
        historyLink.href = "historial.html";
        historyLink.textContent = "Ver más";
        list.append(historyLink);
        updateCounter(activeAlerts.length);
    }

    function createAlertCard(alert, isCurrentUserAlert) {
        const article = document.createElement("article");
        article.className = "alerta-item";
        const categoryLabels = {
            robo: "Robo",
            sospecha: "Sospecha",
            accidente: "Accidente"
        };
        const alertType = alert.tipo === "alerta_abierta"
            ? categoryLabels[alert.categoria] || "Emergencia inmediata"
            : alert.tipo;
        article.dataset.tipo = normalizeType(alertType);
        article.dataset.id = String(alert.id);

        const icon = document.createElement("div");
        icon.className = `alerta-item-icono ${typeClass(alertType)}`;
        const iconElement = document.createElement("i");
        iconElement.className = `fa-solid ${typeIcon(alertType)}`;
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);

        const info = document.createElement("div");
        info.className = "alerta-item-info";
        const top = document.createElement("div");
        top.className = "alerta-item-top";
        const title = document.createElement("strong");
        const titleType = alertType;
        title.textContent = `${alert.esReporteReciente || alert.esReportePropio ? "Tu reporte · " : ""}` +
            `${Number(alert.reportes) > 1 ? "Incidente Grupal · " : ""}${titleType || "Alerta"}${Number(alert.reportes) > 1 ? ` · ${alert.reportes} reportes` : ""}`;
        const elapsed = document.createElement("span");
        elapsed.className = "alerta-tiempo";
        elapsed.textContent = elapsedTime(alert.timestamp);
        top.append(title, elapsed);
        const location = document.createElement("p");
        location.textContent = alert.ubicacion || "Ubicación aproximada del incidente";
        const footer = document.createElement("div");
        footer.className = "alerta-item-footer";
        const state = document.createElement("span");
        state.className = `prioridad ${String(alert.prioridad || "media").toLowerCase()}`;
        if (alert.estado === "Auxilio en camino") state.className = "prioridad estado-auxilio";
        else if (alert.estado === "Recibido en servidor") state.className = "prioridad estado-recibido";
        else if (alert.estado === "Derivada a Central") state.className = "prioridad estado-derivada";
        state.textContent = alert.estado || "Pendiente";
        footer.append(state);

        const latitude = alert.latitudPublica ?? alert.latitud;
        const longitude = alert.longitudPublica ?? alert.longitud;
        if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
            const viewButton = document.createElement("button");
            viewButton.type = "button";
            viewButton.className = "btn-ver-mapa";
            viewButton.dataset.lat = String(latitude);
            viewButton.dataset.lng = String(longitude);
            viewButton.textContent = "Ver";
            viewButton.addEventListener("click", function () {
                if (window.map) window.map.setView([Number(latitude), Number(longitude)], 18);
                if (typeof window.coalertaMarcarAlertaLeida === "function") {
                    window.coalertaMarcarAlertaLeida(alert).catch((error) => {
                        console.error("No se pudo marcar la alerta como leída:", error);
                        showFeedback(getUserFacingError(error, "No se pudo guardar el cambio. Inténtalo de nuevo."), "error");
                    });
                }
            });
            footer.append(viewButton);
        } else {
            const noGps = document.createElement("span");
            noGps.className = "alerta-sin-ubicacion";
            noGps.textContent = "Sin GPS";
            footer.append(noGps);
        }
        info.append(top, location, footer);
        if (isCurrentUserAlert && alert.estado === "Emergencia Concluida") {
            if (alert.calificacion || alert.calificacionOmitida) {
                const thanks = document.createElement("p");
                thanks.className = "evaluacion-confirmacion";
                thanks.textContent = alert.calificacion
                    ? `Gracias por calificar la atención con ${alert.calificacion} estrella(s).`
                    : "Encuesta omitida.";
                info.append(thanks);
            } else {
                info.append(createEvaluation(alert));
            }
        } else if (isCurrentUserAlert && alert.estado === "Descartada") {
            const notice = document.createElement("p");
            notice.className = "evaluacion-confirmacion";
            notice.textContent = `El reporte se cerró como descartado. Motivo: ${alert.motivoDescarte || "No indicado"}.`;
            info.append(notice);
        }
        article.append(icon, info);
        return article;
    }

    function renderUserResponse(ownAlerts) {
        const panel = document.getElementById("estadoRespuestaVecino");
        const title = document.getElementById("estadoRespuestaTitulo");
        const detail = document.getElementById("estadoRespuestaDetalle");
        if (!panel || !title || !detail) {
            updateAlertEmissionLock(getLatestActiveOwnAlert(ownAlerts));
            return;
        }
        const latestOwn = ownAlerts.slice()
            .sort((a, b) => new Date(b.ultimaActualizacion || b.timestamp || 0) -
                new Date(a.ultimaActualizacion || a.timestamp || 0))[0];
        const latest = latestOwn && isTrackedActiveAlert(latestOwn) ? latestOwn : null;
        updateAlertEmissionLock(latest);
        if (!latest) {
            panel.hidden = true;
            panel.classList.remove("respuesta-vecino-en-camino");
            lastResponse = "";
            responseRendered = true;
            configureAssignedPatrolListener(null);
            return;
        }

        const isEnRoute = ["Auxilio en camino", "Atendiendo"].includes(latest.estado);
        title.textContent = isEnRoute
            ? "Auxilio en camino"
            : latest.estado === "Agentes en sitio"
                ? "Agentes de serenazgo en su ubicación"
                : latest.estado === "Derivada a Central"
                    ? "Alerta canalizada a la central"
                    : "Alerta recibida por la central";
        panel.classList.toggle("respuesta-vecino-en-camino", isEnRoute);
        detail.textContent = isEnRoute
            ? responseDetail(latest)
            : latest.estado === "Agentes en sitio"
                ? "El agente de la unidad asignada marcó su llegada a la ubicación del incidente."
                : latest.estado === "Derivada a Central"
                    ? "La alerta fue validada por el coordinador de tu comunidad."
                    : "Tu alerta fue guardada y la central puede verla.";
        panel.hidden = false;
        configureAssignedPatrolListener(latest);
        const responseKey = `${latest.id}:${latest.estado}`;
        if (responseRendered && lastResponse !== responseKey &&
            ["Auxilio en camino", "Atendiendo", "Agentes en sitio"].includes(latest.estado) &&
            typeof navigator.vibrate === "function") {
            navigator.vibrate([180, 90, 180]);
        }
        if (responseRendered && lastResponse !== responseKey && isEnRoute) {
            playArrivalTone();
        }

        lastResponse = responseKey;
        responseRendered = true;
    }

    function isTrackedActiveAlert(alert) {
        return Boolean(alert && (
            window.coalertaData.isActive(alert) ||
            alert.tipo === "alerta_abierta" &&
                ["pendiente", "en_atencion"].includes(alert.estado)
        ));
    }

    function getLatestActiveOwnAlert(alerts) {
        const ownAlerts = Array.isArray(alerts)
            ? alerts
            : window.coalertaData && window.coalertaData.getMyAlerts() || [];
        return ownAlerts
            .filter(isTrackedActiveAlert)
            .sort((a, b) => new Date(b.ultimaActualizacion || b.timestamp || 0) -
                new Date(a.ultimaActualizacion || a.timestamp || 0))[0] || null;
    }

    function updateAlertEmissionLock(activeAlert) {
        const locked = Boolean(activeAlert);
        document.querySelectorAll(".modal-alerta-btn").forEach((button) => {
            button.disabled = locked;
            button.setAttribute("aria-disabled", String(locked));
        });
        ["btnEmergencia", "btnEmergenciaMobile"].forEach((id) => {
            const button = document.getElementById(id);
            if (!button) return;
            button.disabled = locked;
            button.setAttribute("aria-disabled", String(locked));
            button.title = locked
                ? "Ya tienes una alerta activa. Podrás reportar otra cuando se cierre."
                : "Reportar emergencia";
        });
        if (locked && activeTimer) {
            window.clearInterval(activeTimer);
            activeTimer = null;
            if (countdown) countdown.hidden = true;
            if (detailInput) detailInput.disabled = false;
        }
    }

    function configureAssignedPatrolListener(alert) {
        const shouldTrackPatrol = alert &&
            ["Auxilio en camino", "Atendiendo"].includes(alert.estado) &&
            alert.patrullaId;
        const nextPatrolId = shouldTrackPatrol ? String(alert.patrullaId) : "";
        if (nextPatrolId === assignedPatrolId) {
            if (nextPatrolId) updateResponseEta();
            return;
        }
        stopAssignedPatrolTracking();
        assignedPatrolId = nextPatrolId;
        if (!assignedPatrolId || !window.coalertaData.watchAssignedPatrolLocation) return;
        assignedPatrolUnsubscribe = window.coalertaData.watchAssignedPatrolLocation(
            assignedPatrolId,
            (patrol) => {
                assignedPatrol = patrol;
                updateResponseEta();
            }
        );
        responseEtaTimer = window.setInterval(updateResponseEta, 10000);
    }

    function stopAssignedPatrolTracking() {
        if (assignedPatrolUnsubscribe) assignedPatrolUnsubscribe();
        assignedPatrolUnsubscribe = null;
        assignedPatrolId = "";
        assignedPatrol = null;
        if (responseEtaTimer !== null) {
            window.clearInterval(responseEtaTimer);
            responseEtaTimer = null;
        }
    }

    function responseDetail(alert) {
        const unitCode = alert.unidad || alert.patrullaId || "Unidad asignada";
        const distance = getResponseDistance(alert);
        const eta = Number.isFinite(distance)
            ? distance === 0 ? 0 : Math.max(1, Math.ceil(distance / (40000 / 60)))
            : null;
        const distanceText = Number.isFinite(distance)
            ? `Distancia: ${Math.round(distance)} m`
            : "Distancia: calculándose";
        const etaText = eta === null ? "Tiempo estimado: calculándose" : `Tiempo estimado: ${eta} min`;
        return `Unidad de seguridad: ${unitCode} · ${distanceText} · ${etaText}`;
    }

    function getResponseDistance(alert) {
        if (!assignedPatrol || assignedPatrol.latitud == null || assignedPatrol.longitud == null ||
            alert.latitud == null || alert.longitud == null ||
            !Number.isFinite(Number(assignedPatrol.latitud)) ||
            !Number.isFinite(Number(assignedPatrol.longitud)) ||
            !Number.isFinite(Number(alert.latitud)) || !Number.isFinite(Number(alert.longitud))) {
            return NaN;
        }
        return window.coalertaData.distanceMeters(
            { latitud: Number(assignedPatrol.latitud), longitud: Number(assignedPatrol.longitud) },
            { latitud: Number(alert.latitud), longitud: Number(alert.longitud) }
        );
    }

    function updateResponseEta() {
        const panel = document.getElementById("estadoRespuestaVecino");
        const detail = document.getElementById("estadoRespuestaDetalle");
        if (!panel || panel.hidden || !detail || !window.coalertaData) return;
        const latest = getLatestActiveOwnAlert();
        if (!latest || !["Auxilio en camino", "Atendiendo"].includes(latest.estado)) return;
        detail.textContent = responseDetail(latest);
    }

    function playArrivalTone() {
        const sound = window.coalertaSonidoEmergencia;
        if (sound && typeof sound.play === "function") {
            Promise.resolve().then(() => sound.play()).catch((error) => {
                console.info("El navegador no permitió reproducir el tono de llegada:", error);
            });
            return;
        }
        if (typeof Audio !== "function" || typeof URL.createObjectURL !== "function") return;
        const audio = new Audio(
            "data:audio/wav;base64,UklGRqQCAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YYACAADAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwMBAQEBAwMDAwMBAQEBAwMDAwMBAQEBAwMDAwMBAQEBAwMDAwMBAQEBAwMDAwMBAQEBAQMDAwMBAQEBAQMDAwMBAQEBAQMDAwMBAQEBAQMDAwMBAQEBAQMDAwMBAQEBAQMDAwMDAQEBAQMDAwMDAQEBAQMDAwMDAQEBAQMDAwMDAQEBAQMDAwMDAQEBAQMDAwMDAQEBAQEDAwMDAQEBAQEDAwMDAQEBAQEDAwMDAQEBAQEDAwMDAQEBAQEDAwMDAQEBAQEDAwMDAwEBAQEDAwMDAwEBAQEDAwMDAwEBAQEDAwMDAwEBAQEDAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBAQEBAwMDAwEBA"
        );
        const sampleRate = 8000;
        const sampleCount = sampleRate / 5;
        const wav = new Uint8Array(44 + sampleCount);
        const header = new DataView(wav.buffer);
        const writeText = (offset, value) => {
            for (let index = 0; index < value.length; index += 1) {
                wav[offset + index] = value.charCodeAt(index);
            }
        };
        writeText(0, "RIFF");
        header.setUint32(4, 36 + sampleCount, true);
        writeText(8, "WAVEfmt ");
        header.setUint32(16, 16, true);
        header.setUint16(20, 1, true);
        header.setUint16(22, 1, true);
        header.setUint32(24, sampleRate, true);
        header.setUint32(28, sampleRate, true);
        header.setUint16(32, 1, true);
        header.setUint16(34, 8, true);
        writeText(36, "data");
        header.setUint32(40, sampleCount, true);
        for (let index = 0; index < sampleCount; index += 1) {
            wav[44 + index] = Math.sin(2 * Math.PI * 880 * index / sampleRate) >= 0 ? 208 : 48;
        }
        const audioUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        audio.src = audioUrl;
        const releaseAudioUrl = () => URL.revokeObjectURL(audioUrl);
        audio.addEventListener("ended", releaseAudioUrl, { once: true });
        audio.addEventListener("error", releaseAudioUrl, { once: true });
        audio.play().catch((error) => {
            releaseAudioUrl();
            console.info("El navegador no permitió reproducir el tono de llegada:", error);
        });
    }

    function unlockEmergencyAudio() {
        const sound = window.coalertaSonidoEmergencia;
        if (!sound || typeof sound.unlock !== "function") return;
        try {
            Promise.resolve(sound.unlock()).catch((error) => {
                console.info("No se pudo habilitar el audio de emergencia:", error);
            });
        } catch (error) {
            console.info("No se pudo habilitar el audio de emergencia:", error);
        }
    }

    function createEvaluation(alert) {
        const form = document.createElement("div");
        form.className = "evaluacion-alerta";
        const prompt = document.createElement("strong");
        prompt.textContent = "¿Cómo evalúas la atención? (opcional)";
        const rating = document.createElement("select");
        rating.setAttribute("aria-label", "Calificación de 1 a 5 estrellas");
        rating.innerHTML = '<option value="">Selecciona estrellas</option>' +
            [1, 2, 3, 4, 5].map((value) => `<option value="${value}">${value} estrella${value === 1 ? "" : "s"}</option>`).join("");
        const comment = document.createElement("select");
        comment.setAttribute("aria-label", "Comentario predefinido");
        comment.innerHTML = '<option value="">Comentario (opcional)</option><option>Llegaron rápido</option><option>Trato amable</option><option>Demora en arribo</option>';
        const status = document.createElement("p");
        status.setAttribute("aria-live", "polite");
        const send = document.createElement("button");
        send.type = "button";
        send.className = "btn-ver-mapa";
        send.textContent = "Enviar";
        let saving = false;
        send.addEventListener("click", async function () {
            if (saving) return;
            if (!rating.value) {
                status.textContent = "Selecciona entre 1 y 5 estrellas o usa Omitir.";
                return;
            }
            saving = true;
            send.disabled = true;
            skip.disabled = true;
            status.textContent = "Guardando evaluación…";
            try {
                await window.coalertaData.transitionIncident(alert.id, "rate", {
                    rating: Number(rating.value),
                    comment: comment.value || ""
                });
                status.textContent = "Gracias por evaluar la atención.";
            } catch (error) {
                console.error("No se pudo guardar la calificación:", error);
                saving = false;
                send.disabled = false;
                skip.disabled = false;
                status.textContent = getUserFacingError(error, "No se pudo guardar la calificación. Inténtalo de nuevo.");
            }
        });
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "btn-omitir-evaluacion";
        skip.textContent = "Omitir";
        skip.addEventListener("click", async function () {
            if (saving) return;
            saving = true;
            send.disabled = true;
            skip.disabled = true;
            status.textContent = "Guardando…";
            try {
                await window.coalertaData.transitionIncident(alert.id, "skipRating");
                status.textContent = "Encuesta omitida.";
            } catch (error) {
                console.error("No se pudo omitir la encuesta:", error);
                saving = false;
                send.disabled = false;
                skip.disabled = false;
                status.textContent = getUserFacingError(error, "No se pudo completar la acción. Inténtalo de nuevo.");
            }
        });
        form.append(prompt, rating, comment, status, send, skip);
        return form;
    }

    function updateCounter(total) {
        const element = document.getElementById("contadorAlertas");
        if (element) element.textContent = String(total);
    }

    function showFailure(message) {
        if (detailInput) detailInput.disabled = false;
        if (countdown) countdown.hidden = true;
        if (grid) grid.hidden = false;
        showFeedback(message, "error");
    }

    function esEntornoLocal() {
        return ["localhost", "127.0.0.1"].includes(window.location.hostname);
    }

    function showFeedback(message, type, iconClass = "") {
        if (!feedback) {
            window.alert(message);
            return;
        }
        feedback.replaceChildren();
        if (iconClass) {
            const icon = document.createElement("i");
            icon.className = iconClass;
            icon.setAttribute("aria-hidden", "true");
            feedback.append(icon, document.createTextNode(" "));
        }
        feedback.append(document.createTextNode(message));
        feedback.className = `estado-envio-alerta estado-envio-${type}`;
        feedback.hidden = false;
    }

    function makeEmpty(text) {
        const element = document.createElement("p");
        element.className = "alertas-vacio";
        element.textContent = text;
        return element;
    }

    function getUserFacingError(error, fallback) {
        if (error && (error.code === "permission-denied" || error.code === "unauthenticated")) {
            return "No tienes permiso para completar esta acción.";
        }
        if (error && error.code === "resource-exhausted") {
            return "El servicio está temporalmente saturado. Inténtalo más tarde.";
        }
        if (error && (error.code === "unavailable" || error.code === "network-request-failed")) {
            return "Error de conexión. Inténtalo de nuevo.";
        }
        return fallback;
    }

    function isWithinVerifiedNearbyRadius(alert) {
        const location = window.coalertaUbicacionMapa;
        if (!location ||
            !["ready", "approximate"].includes(window.coalertaEstadoUbicacionMapa)) return false;
        const latitud = Number(alert.latitudPublica ?? alert.latitud);
        const longitud = Number(alert.longitudPublica ?? alert.longitud);
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) return false;
        return window.coalertaData.distanceMeters(
            location,
            { latitud, longitud }
        ) <= 5000;
    }
});

function normalizeType(type) {
    const value = String(type || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (value.includes("robo")) return "robo";
    if (value.includes("sospech")) return "sospechoso";
    if (value.includes("accidente")) return "accidente";
    if (value.includes("incendio")) return "incendio";
    return "otro";
}

function typeClass(type) {
    const value = normalizeType(type);
    return value === "robo" ? "robo" : value === "sospechoso" ? "sospechoso" :
        value === "accidente" ? "accidente" : value === "incendio" ? "incendio" : "robo";
}

function typeIcon(type) {
    const value = normalizeType(type);
    return value === "robo" ? "fa-mask-face" : value === "sospechoso" ? "fa-user-secret" :
        value === "accidente" ? "fa-truck-medical" : value === "incendio" ? "fa-fire" : "fa-triangle-exclamation";
}

function elapsedTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - new Date(timestamp || Date.now()).getTime());
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "Ahora";
    if (minutes < 60) return `Hace ${minutes} min`;
    return `Hace ${Math.floor(minutes / 60)} h`;
}
