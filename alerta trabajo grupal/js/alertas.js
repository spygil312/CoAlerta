document.addEventListener("DOMContentLoaded", function () {
    const modal = document.getElementById("modalEmergencia");
    const grid = document.querySelector(".modal-alertas-grid");
    const countdown = document.getElementById("confirmacionCuentaRegresiva");
    const countdownNumber = document.getElementById("cuentaRegresivaNumero");
    const progress = document.getElementById("cuentaRegresivaProgreso");
    const cancelButton = document.getElementById("btnCancelarAlerta");
    const feedback = document.getElementById("estadoEnvioAlerta");
    const detailInput = document.getElementById("detalleEmergencia");
    const detailCounter = document.getElementById("contadorDetalleEmergencia");
    let activeTimer = null;
    let readinessCheckPending = false;
    let selectedCategory = "";
    let responseRendered = false;
    let lastResponse = "";

    if (detailInput && detailCounter) {
        detailInput.addEventListener("input", function () {
            detailCounter.textContent = String(detailInput.value.length);
        });
    }

    renderAlerts();
    window.addEventListener("coalerta:alertas-actualizadas", renderAlerts);
    window.addEventListener("coalerta:mis-alertas-actualizadas", renderAlerts);
    window.addEventListener("coalerta:datos-listos", renderAlerts);
    window.addEventListener("coalerta:sesion-cambiada", renderAlerts);
    window.addEventListener("coalerta:error", function (event) {
        const detail = event.detail || {};
        if (!["alertas públicas", "tus alertas", "perfil"].includes(detail.area)) return;
        const list = document.getElementById("alertasLista");
        if (list) list.replaceChildren(makeEmpty(detail.message || "No se pudieron sincronizar las alertas."));
    });

    document.querySelectorAll(".modal-alerta-btn").forEach((button) => {
        button.addEventListener("click", function () {
            if (!button.dataset.emergencia) return;
            startCountdown(button.dataset.emergencia);
        });
    });

    if (cancelButton) cancelButton.addEventListener("click", cancelCountdown);
    window.resetAlertModal = function () {
        if (activeTimer) window.clearInterval(activeTimer);
        activeTimer = null;
        selectedCategory = "";
        if (grid) grid.hidden = false;
        if (countdown) countdown.hidden = true;
        if (feedback) {
            feedback.hidden = true;
            feedback.textContent = "";
        }
        if (detailInput) detailInput.value = "";
        if (detailCounter) detailCounter.textContent = "0";
        if (progress) progress.style.width = "0%";
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
                    refreshStatus.textContent = error.message || "No se pudieron actualizar las alertas.";
                }
            } finally {
                refresh.disabled = false;
                refresh.classList.remove("girando");
                refresh.setAttribute("aria-label", "Actualizar alertas");
            }
        });
    }

    async function startCountdown(category) {
        if (readinessCheckPending || activeTimer) return;
        if (!window.coalertaData) {
            showFailure("No se pudo iniciar la conexión con Firebase. Recarga la página.");
            return;
        }
        readinessCheckPending = true;
        try {
            showFeedback("Confirmando tu sesión con Firebase…", "info");
            await window.coalertaData.waitForReady();
        } catch (error) {
            readinessCheckPending = false;
            showFailure(error.message || "No se pudo confirmar tu sesión con Firebase.");
            return;
        }
        readinessCheckPending = false;
        if (activeTimer) window.clearInterval(activeTimer);
        selectedCategory = category;
        if (grid) grid.hidden = true;
        if (feedback) {
            feedback.hidden = true;
            feedback.textContent = "";
        }
        if (countdown) countdown.hidden = false;
        if (navigator.vibrate) navigator.vibrate(80);

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
                submitAlert(selectedCategory);
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
            feedback.textContent = "Alerta cancelada. No se envió al servidor.";
            feedback.className = "estado-envio-alerta estado-envio-info";
            feedback.hidden = false;
        }
        if (navigator.vibrate) navigator.vibrate(40);
    }

    function submitAlert(category) {
        if (!navigator.geolocation) {
            showFailure("Este navegador no permite obtener GPS. No se creó la alerta.");
            return;
        }
        showFeedback("Obteniendo GPS de alta precisión…", "info");
        navigator.geolocation.getCurrentPosition(async function (position) {
            try {
                const payload = {
                    tipo: category,
                    detalle: detailInput ? detailInput.value.trim() : "",
                    latitud: position.coords.latitude,
                    longitud: position.coords.longitude,
                    precisionMetros: position.coords.accuracy
                };
                const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
                if (payloadSize > 2048) throw new Error("El paquete de alerta supera el límite de 2 KB.");
                await window.coalertaData.waitForReady();
                showFeedback("Registrando la alerta en CoAlerta…", "info");
                const result = await window.coalertaData.createAlert(payload);
                if (navigator.vibrate) navigator.vibrate([100, 50, 180]);
                const precision = Math.round(position.coords.accuracy);
                const precisionNotice = precision > 5000
                    ? " La ubicación es aproximada; intenta reportar desde un lugar abierto para mejorarla."
                    : "";
                showFeedback(
                    `Alerta registrada en CoAlerta. Código: ${result.incidentId}. ` +
                    `Precisión GPS informada ±${precision} m.${precisionNotice}`,
                    "success"
                );
                if (countdown) countdown.hidden = true;
                if (grid) grid.hidden = true;
                if (detailInput) detailInput.value = "";
                if (detailCounter) detailCounter.textContent = "0";
            } catch (error) {
                console.error("No se pudo enviar la alerta al servidor:", error);
                showFailure(error.message || "No se pudo transmitir la alerta. Verifica tu conexión.");
            }
        }, function (error) {
            console.error("No se pudo obtener el GPS de la alerta:", error);
            const message = error.code === 1
                ? "Permite el acceso a la ubicación y vuelve a intentar. No se envió ninguna alerta."
                : error.code === 3
                    ? "La ubicación tardó demasiado. Inténtalo nuevamente en un lugar con señal GPS."
                    : "No se pudo determinar tu ubicación. No se envió ninguna alerta.";
            showFailure(message);
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }

    function renderAlerts() {
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
        const ownAlerts = window.coalertaData.getMyAlerts();
        const ownedRecent = ownAlerts.map((alert) => ({
            ...alert,
            id: alert.id || alert.alertaId,
            reportes: Number(alert.reportes) || 1
        }));
        const ownAlertIds = new Set(ownedRecent.map((alert) => String(alert.id)));
        const activeAlerts = alerts.filter((alert) => window.coalertaData.isActive(alert));
        renderUserResponse(ownAlerts);
        const visibleById = new Map(activeAlerts.map((alert) => [String(alert.id), alert]));
        ownedRecent.forEach((alert) => {
            const id = String(alert.id || "");
            if (id) visibleById.set(id, { ...visibleById.get(id), ...alert });
        });
        const visibleAlerts = [...visibleById.values()]
            .sort((a, b) => new Date(b.timestamp || b.ultimaActualizacion || 0) -
                new Date(a.timestamp || a.ultimaActualizacion || 0));
        list.replaceChildren();
        if (!visibleAlerts.length) {
            list.append(makeEmpty("No hay alertas activas en este sector."));
        } else {
            visibleAlerts.slice(0, 3).forEach((alert) =>
                list.append(createAlertCard(alert, ownAlertIds.has(String(alert.id))))
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
        article.dataset.tipo = normalizeType(alert.tipo);
        article.dataset.id = String(alert.id);

        const icon = document.createElement("div");
        icon.className = `alerta-item-icono ${typeClass(alert.tipo)}`;
        const iconElement = document.createElement("i");
        iconElement.className = `fa-solid ${typeIcon(alert.tipo)}`;
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);

        const info = document.createElement("div");
        info.className = "alerta-item-info";
        const top = document.createElement("div");
        top.className = "alerta-item-top";
        const title = document.createElement("strong");
        title.textContent = `${alert.tipo || "Alerta"}${Number(alert.reportes) > 1 ? ` · ${alert.reportes} reportes` : ""}`;
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
                        showFeedback(error.message || "No se pudo guardar que la alerta fue leída.", "error");
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
        if (!panel || !title || !detail) return;
        const latestOwn = ownAlerts
            .sort((a, b) => new Date(b.ultimaActualizacion || b.timestamp || 0) -
                new Date(a.ultimaActualizacion || a.timestamp || 0))[0];
        const latest = latestOwn &&
            ["Recibido en servidor", "Derivada a Central", "Auxilio en camino", "Agentes en sitio"].includes(latestOwn.estado)
            ? latestOwn
            : null;
        if (!latest || latest.estado === "Recibido en servidor") {
            panel.hidden = true;
            lastResponse = "";
            responseRendered = true;
            return;
        }

        title.textContent = latest.estado === "Auxilio en camino"
            ? "Auxilio en camino"
            : latest.estado === "Agentes en sitio"
                ? "Agentes de serenazgo en tu ubicación"
                : latest.estado === "Derivada a Central"
                        ? "Alerta canalizada a la central"
                        : "Recibido por Central";
        detail.textContent = latest.estado === "Auxilio en camino"
            ? `${latest.unidad || "Unidad asignada"} · Tiempo estimado: ${latest.etaMinutos ? `${latest.etaMinutos} min` : "calculándose"}.`
            : latest.estado === "Agentes en sitio"
                ? "El agente de la unidad asignada marcó su llegada a la ubicación del incidente."
                : latest.estado === "Derivada a Central"
                    ? "La alerta fue validada por el coordinador de tu comunidad."
                    : "La alerta continúa en proceso de atención.";
        panel.hidden = false;
        const responseKey = `${latest.id}:${latest.estado}`;
        if (responseRendered && lastResponse !== responseKey &&
            ["Auxilio en camino", "Agentes en sitio"].includes(latest.estado) &&
            typeof navigator.vibrate === "function") {
            navigator.vibrate([180, 90, 180]);
        }

        lastResponse = responseKey;
        responseRendered = true;
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
                status.textContent = error.message || "No se pudo guardar la calificación.";
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
                status.textContent = error.message || "No se pudo registrar la omisión.";
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
        if (countdown) countdown.hidden = true;
        if (grid) grid.hidden = false;
        showFeedback(message, "error");
    }

    function showFeedback(message, type) {
        if (!feedback) {
            window.alert(message);
            return;
        }
        feedback.textContent = message;
        feedback.className = `estado-envio-alerta estado-envio-${type}`;
        feedback.hidden = false;
    }

    function makeEmpty(text) {
        const element = document.createElement("p");
        element.className = "alertas-vacio";
        element.textContent = text;
        return element;
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
