import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const data = window.coalertaData;
    if (!data) {
        window.alert("No se pudo iniciar la conexión segura con Firebase. Recarga la página.");
        return;
    }

    const incidentsList = document.getElementById("listaCentralAlertas");
    const auditList = document.getElementById("listaAuditoria");
    const timeFilter = document.getElementById("filtroCentralTiempo");
    let activeRole = "vecino";
    let map;
    let alertLayer;
    let patrolLayer;
    let zoneLayer;
    let routeLayer;
    let heatLayer;
    let heatmapMap;
    let watchId = null;
    let heatmapEnabled = false;
    let zone = null;
    let initialized = false;
    let knownIncidentIds = null;
    let auditExpiryTimer = null;

    document.getElementById("btnCerrarSesionLateral").addEventListener("click", closeSession);
    window.addEventListener("coalerta:datos-listos", initializeFromProfile);
    window.addEventListener("coalerta:incidentes-actualizados", function () {
        alertOnNewIncidents();
        render();
    });
    window.addEventListener("coalerta:avisos-actualizados", render);
    window.addEventListener("coalerta:auditoria-actualizada", renderAudit);
    window.addEventListener("coalerta:patrullas-actualizadas", renderPatrol);
    window.addEventListener("coalerta:zona-actualizada", function (event) {
        zone = event.detail;
        drawZone();
        render();
    });
    window.addEventListener("coalerta:delegacion-actualizada", renderDelegation);
    window.addEventListener("coalerta:preferencias-cargadas", applyNightTheme);
    window.addEventListener("coalerta:preferencias-cambiadas", applyNightTheme);
    window.addEventListener("coalerta:error", function (event) {
        if (event.detail && event.detail.area === "incidentes operativos") {
            incidentsList.replaceChildren(makeEmpty(event.detail.message));
        }
    });
    document.addEventListener("pointerdown", () => {
        if (window.coalertaSonidoEmergencia) window.coalertaSonidoEmergencia.unlock();
    }, { once: true });
    document.addEventListener("keydown", () => {
        if (window.coalertaSonidoEmergencia) window.coalertaSonidoEmergencia.unlock();
    }, { once: true });
    if (data.isReady()) initializeFromProfile();

    function alertOnNewIncidents() {
        if (!initialized || !data.isReady()) return;
        const incidents = getVisibleIncidents();
        const currentIds = new Set(incidents.map((incident) => String(incident.id)));
        if (knownIncidentIds === null) {
            knownIncidentIds = currentIds;
            return;
        }
        const newActiveIncidentIds = incidents
            .filter((incident) => !knownIncidentIds.has(String(incident.id)) && data.isActive(incident))
            .map((incident) => String(incident.id));
        knownIncidentIds = currentIds;
        if (!newActiveIncidentIds.length || !window.coalertaSonidoEmergencia ||
            !window.coalertaSonidoEmergencia.isEnabled()) return;

        window.setTimeout(async () => {
            const latestIncidents = getVisibleIncidents();
            const stillActiveIncidentExists = latestIncidents.some((incident) =>
                newActiveIncidentIds.includes(String(incident.id)) && data.isActive(incident)
            );
            if (!stillActiveIncidentExists || !window.coalertaSonidoEmergencia.isEnabled()) return;
            try {
                await window.coalertaSonidoEmergencia.play();
            } catch (error) {
                console.error("No se pudo reproducir el sonido de un incidente nuevo:", error);
            }
        }, 500);
    }

    function initializeFromProfile() {
        if (initialized || !data.isReady()) return;
        const accountRole = data.getRole();
        if (!["coordinador", "agente", "seguridad", "administrador", "admin"].includes(accountRole)) {
            window.location.replace("mapa.html");
            return;
        }
        if (!["coordinador", "administrador", "admin"].includes(accountRole)) {
            window.location.replace("personal_seguridad.html");
            return;
        }
        activeRole = accountRole;
        initialized = true;
        zone = data.getZone();
        updateSidebarProfile(data.getProfile());
        const roleLabel = document.getElementById("rolCentral");
        roleLabel.textContent = activeRole === "administrador" || activeRole === "admin"
            ? "Panel de coordinación · vista de administrador"
            : "Panel de coordinación vecinal";
        document.title = activeRole === "administrador" || activeRole === "admin"
            ? "Panel de coordinación | CoAlerta"
            : "Panel de coordinación vecinal | CoAlerta";
        configureMap();
        configureControls();
        applyNightTheme();
        updateRoleView();
        render();
    }

    function updateSidebarProfile(profile) {
        const account = profile || {};
        const name = account.nombre ||
            [account.nombres, account.apellidos].filter(Boolean).join(" ") ||
            "Coordinador vecinal";
        const nameElement = document.getElementById("sidebarNombre");
        const roleElement = document.getElementById("sidebarRol");
        const avatar = document.getElementById("sidebarAvatarImg");
        const avatarIcon = document.getElementById("sidebarAvatarIcon");
        const photo = account.fotoBase64 || account.fotoURL || account.photoURL;

        nameElement.textContent = `Hola, ${name.trim().split(/\s+/)[0]}`;
        roleElement.textContent = ["administrador", "admin"].includes(activeRole)
            ? "Administrador"
            : "Coordinador vecinal";
        if (!photo) return;

        avatar.onerror = function () {
            avatar.hidden = true;
            avatarIcon.hidden = false;
        };
        avatar.src = photo;
        avatar.hidden = false;
        avatarIcon.hidden = true;
    }

    async function closeSession() {
        if (!window.confirm("¿Seguro que deseas cerrar sesión?")) return;
        try {
            await signOut(auth);
            localStorage.removeItem("coalerta_usuario");
            localStorage.removeItem("coalertaSesion");
            window.location.replace("login.html");
        } catch (error) {
            console.error("No se pudo cerrar la sesión:", error);
            window.alert(error.message || "No se pudo cerrar la sesión.");
        }
    }

    function configureMap() {
        const element = document.getElementById("mapaCentral");
        if (!element || typeof L === "undefined") {
            element.textContent = "El mapa no está disponible. Comprueba tu conexión e inténtalo nuevamente.";
            return;
        }
        map = L.map(element).setView([-12.1, -77.03], 14);
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 19,
            attribution: "Tiles &copy; Esri — Source: Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community"
        }).addTo(map);
        alertLayer = L.layerGroup().addTo(map);
        patrolLayer = L.layerGroup().addTo(map);
        zoneLayer = L.layerGroup().addTo(map);
        routeLayer = L.layerGroup().addTo(map);
        window.setTimeout(() => map && map.invalidateSize(), 250);
        window.addEventListener("resize", () => map && map.invalidateSize());
    }

    function configureControls() {
        document.getElementById("btnActualizarCentral").addEventListener("click", render);
        timeFilter.addEventListener("change", render);
        document.querySelectorAll(".central-filtros input").forEach((input) => {
            input.addEventListener("change", render);
        });
        incidentsList.addEventListener("click", handleIncidentAction);
        document.getElementById("btnPublicarAviso").addEventListener("click", publishNotice);
        document.getElementById("btnGuardarDelegacion").addEventListener("click", saveDelegation);
        document.getElementById("btnGuardarZona").addEventListener("click", saveZone);
        document.getElementById("btnUbicacionPatrulla").addEventListener("click", togglePatrolLocation);
        document.getElementById("btnTemaCentral").addEventListener("click", toggleNightTheme);
        document.getElementById("btnHeatmap").addEventListener("click", toggleHeatmap);
        document.getElementById("btnCerrarMapaCalor").addEventListener("click", closeHeatmap);
        document.getElementById("modalMapaCalor").addEventListener("click", (event) => {
            if (event.target === event.currentTarget) closeHeatmap();
        });
        document.getElementById("modalMapaCalor").addEventListener("close", () => {
            heatmapEnabled = false;
        });
        document.getElementById("plantillaAviso").addEventListener("change", validateNoticeTemplate);
        document.getElementById("incidenteAviso").addEventListener("change", validateNoticeTemplate);
        document.getElementById("filtroTurnoCalor").addEventListener("change", function () {
            if (heatmapEnabled) updateHeatmap(getVisibleIncidents());
        });
        renderPatrol();
        renderDelegation();
        loadEligibleDelegates();
    }

    function render() {
        if (!initialized) return;
        let alerts;
        let notices;
        try {
            alerts = getVisibleIncidents();
            notices = data.getNotices();
        } catch (error) {
            console.error("No se pudieron leer los datos operativos:", error);
            incidentsList.replaceChildren(makeEmpty("No se pudieron leer los incidentes desde Firebase. Comprueba tu conexión."));
            return;
        }
        const active = alerts.filter((alert) => data.isActive(alert));
        document.getElementById("totalActivas").textContent = String(active.length);
        document.getElementById("totalDespachadas").textContent = String(
            active.filter((alert) => ["Auxilio en camino", "Agentes en sitio"].includes(alert.estado)).length
        );
        document.getElementById("totalAvisos").textContent = String(notices.length);
        updateRoleView();
        renderIncidents(alerts);
        renderNoticeIncidents(alerts);
        renderMap(alerts);
        renderAudit();
        renderPatrol();
        if (heatmapEnabled) updateHeatmap(alerts);
    }

    function updateRoleView() {
        const isCoordinator = activeRole === "coordinador";
        const isAdminViewer = ["administrador", "admin"].includes(activeRole);
        document.getElementById("tituloVista").textContent = isCoordinator
            ? "Panel de coordinación vecinal"
            : isAdminViewer ? "Vista del panel de coordinación"
                : "Consola de despacho";
        document.getElementById("descripcionVista").textContent = isCoordinator
            ? "Revisa incidentes activos, deriva alertas y publica avisos oficiales de tu comunidad."
            : isAdminViewer
                ? "Vista administrativa de los incidentes y la operación de coordinación."
                : "Acepta alertas derivadas, actualiza el estado de respuesta y finaliza el incidente.";
        ["panelZona", "panelAviso", "panelDelegacion"].forEach((id) => {
            document.getElementById(id).hidden = !isCoordinator;
        });
    }

    function getVisibleIncidents() {
        const incidents = data.getIncidents();
        if (activeRole !== "coordinador") return incidents;
        const communityId = data.getProfile() && data.getProfile().comunidadId;
        return communityId
            ? incidents.filter((incident) => incident.comunidadId === communityId)
            : [];
    }

    function renderIncidents(alerts) {
        const selectedCategories = Array.from(document.querySelectorAll(".central-filtros input:checked"))
            .map((input) => input.value);
        const filtered = alerts
            .filter((alert) => !["Emergencia Concluida", "Descartada"].includes(alert.estado))
            .filter((alert) => selectedCategories.includes(data.normalizeCategory(alert.tipo)))
            .filter(matchesPeriod)
            .filter(isInZone)
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        incidentsList.replaceChildren();
        if (!filtered.length) {
            incidentsList.append(makeEmpty("No hay incidentes para los filtros seleccionados."));
            return;
        }
        filtered.forEach((alert) => incidentsList.append(createIncidentCard(alert)));
    }

    function createIncidentCard(alert) {
        const article = document.createElement("article");
        article.className = "central-alerta";
        article.dataset.id = String(alert.id);
        article.dataset.categoria = data.normalizeCategory(alert.tipo);

        const header = document.createElement("div");
        header.className = "central-alerta-cabecera";
        const identity = document.createElement("div");
        identity.className = "central-alerta-identidad";
        const category = data.normalizeCategory(alert.tipo);
        const icon = document.createElement("span");
        icon.className = "central-alerta-icono";
        icon.style.backgroundColor = colorFor(category);
        const iconElement = document.createElement("i");
        iconElement.className = `fa-solid ${iconFor(category)}`;
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);
        const title = document.createElement("h3");
        title.textContent = `${alert.tipo || "Incidente"}${Number(alert.reportes) > 1 ? ` · ${alert.reportes} reportes` : ""}`;
        identity.append(icon, title);
        const state = document.createElement("span");
        state.className = `central-estado${alert.estado === "Auxilio en camino" ? " central-estado-en-camino" : ""}`;
        state.textContent = alert.estado || "Pendiente";
        header.append(identity, state);

        const meta = document.createElement("div");
        meta.className = "central-alerta-meta";
        meta.textContent = `${formatDate(alert.timestamp)} · ${alert.id}`;
        const description = document.createElement("p");
        description.textContent = `${alert.detalle || "Sin detalle adicional"} · ${alert.ubicacion || "Ubicación no disponible"}${hasCoordinates(alert) ? ` · ${Number(alert.latitud).toFixed(5)}, ${Number(alert.longitud).toFixed(5)}` : " · Sin GPS"}`;
        article.append(header, meta, description);
        if (alert.unidad) {
            const assigned = document.createElement("p");
            assigned.textContent = `${alert.unidad} · ETA estimado: ${calculateEta(alert)} min`;
            article.append(assigned);
        }
        if (alert.motivoDescarte) {
            const reason = document.createElement("p");
            reason.textContent = `Motivo: ${alert.motivoDescarte}`;
            article.append(reason);
        }

        const actions = document.createElement("div");
        actions.className = "central-acciones-alerta";
        if (activeRole === "coordinador" && data.isActive(alert)) {
            actions.append(makeAction("derive", "Validar y derivar", "central-button"));
            const reason = document.createElement("select");
            reason.setAttribute("aria-label", "Motivo para descartar");
            reason.dataset.reasonFor = String(alert.id);
            ["Prueba de usuario", "Falsa alarma comprobada", "Duplicado"].forEach((value) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = value;
                reason.append(option);
            });
            actions.append(reason, makeAction("discard", "Descartar alerta", "central-button central-button-peligro"));
        } else if (activeRole === "agente" && alert.estado === "Derivada a Central") {
            const profile = data.getProfile();
            if (profile && profile.patrullaId) {
                actions.append(makeAction("dispatch", "Aceptar y despachar", "central-button"));
            } else {
                const setup = document.createElement("small");
                setup.textContent = "La cuenta de agente necesita una unidad asignada por el administrador.";
                actions.append(setup);
            }
        } else if (activeRole === "agente" && alert.estado === "Auxilio en camino") {
            actions.append(makeAction("onsite", "Marcar en sitio", "central-button"));
        } else if (activeRole === "agente" && alert.estado === "Agentes en sitio") {
            const outcome = document.createElement("select");
            outcome.setAttribute("aria-label", "Resultado del incidente");
            outcome.dataset.outcomeFor = String(alert.id);
            ["Intervención preventiva", "Sujeto intervenido", "Falsa alarma"].forEach((value) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = value;
                outcome.append(option);
            });
            actions.append(outcome, makeAction("close", "Incidente atendido", "central-button"));
        }
        if (hasCoordinates(alert)) {
            actions.append(makeAction(
                "route",
                activeRole === "agente" ? "Calcular ruta" : "Ver ubicación",
                "central-button central-button-secundario"
            ));
        }
        if (actions.childElementCount) article.append(actions);
        return article;
    }

    function makeAction(action, label, className) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.className = className;
        button.textContent = label;
        return button;
    }

    async function handleIncidentAction(event) {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const card = button.closest(".central-alerta");
        const id = card && card.dataset.id;
        if (!id) return;
        button.disabled = true;
        try {
            const alert = getVisibleIncidents().find((item) => String(item.id) === id);
            if (!alert) throw new Error("No se encontró la alerta seleccionada.");
            switch (button.dataset.action) {
                case "derive":
                    await data.transitionIncident(id, "validate");
                    break;
                case "discard": {
                    const select = card.querySelector(`[data-reason-for="${id}"]`);
                    await data.transitionIncident(id, "discard", { reason: select.value });
                    break;
                }
                case "dispatch":
                    await data.transitionIncident(id, "dispatch");
                    break;
                case "onsite":
                    await data.transitionIncident(id, "onsite");
                    break;
                case "close": {
                    const select = card.querySelector(`[data-outcome-for="${id}"]`);
                    await data.transitionIncident(id, "close", { outcome: select.value });
                    break;
                }
                case "route":
                    await showRoute(alert);
                    break;
                default:
                    return;
            }
            render();
        } catch (error) {
            console.error("No se pudo actualizar el incidente:", error);
            if (button.dataset.action === "route") {
                document.getElementById("estadoRutaCentral").textContent =
                    error.message || "No se pudo calcular la ruta.";
            }
            window.alert(error.message || "No se pudo actualizar el incidente.");
        } finally {
            button.disabled = false;
        }
    }

    async function showRoute(alert) {
        if (!hasCoordinates(alert) || !routeLayer) {
            throw new Error("La alerta no tiene coordenadas válidas para calcular una ruta.");
        }
        routeLayer.clearLayers();
        document.getElementById("estadoRutaCentral").textContent = "Buscando una ruta vial…";
        const patrols = data.getPatrols().filter((patrol) =>
            Number.isFinite(Number(patrol.latitud)) && Number.isFinite(Number(patrol.longitud))
        );
        let origin;
        if (patrols.length) {
            origin = patrols.reduce((closest, patrol) =>
                data.distanceMeters(alert, patrol) < data.distanceMeters(alert, closest) ? patrol : closest
            );
        } else if (navigator.geolocation) {
            origin = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    (position) => resolve({
                        latitud: position.coords.latitude,
                        longitud: position.coords.longitude,
                        codigo: "Tu ubicación"
                    }),
                    () => reject(new Error("No hay patrullas con ubicación y no se pudo obtener tu ubicación GPS.")),
                    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
                );
            });
        } else {
            throw new Error("No hay patrullas con ubicación ni GPS disponible para calcular la ruta.");
        }

        if (!window.confirm("Para calcular la ruta vial, se enviarán al servicio público OSRM las coordenadas de la unidad y de la alerta. ¿Deseas continuar?")) {
            return;
        }
        const coordinates = `${Number(origin.longitud)},${Number(origin.latitud)};${Number(alert.longitud)},${Number(alert.latitud)}`;
        const response = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
            { headers: { Accept: "application/json" } }
        );
        if (!response.ok) throw new Error("El servicio público de rutas no está disponible. Inténtalo nuevamente.");
        const result = await response.json();
        const route = result.routes && result.routes[0];
        if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
            throw new Error("No se encontró una ruta vial entre la unidad y la alerta.");
        }
        const line = L.geoJSON(route.geometry, {
            style: { color: "#1267d6", weight: 6, opacity: 0.85 }
        }).addTo(routeLayer);
        map.fitBounds(line.getBounds(), { padding: [30, 30] });
        const distanceKm = (route.distance / 1000).toLocaleString("es", { maximumFractionDigits: 1 });
        const durationMinutes = Math.max(1, Math.ceil(route.duration / 60));
        document.getElementById("estadoRutaCentral").textContent =
            `Ruta calculada desde ${origin.codigo || "la unidad más cercana"}: ${distanceKm} km · ${durationMinutes} min estimados.`;
    }

    async function publishNotice() {
        const template = document.getElementById("plantillaAviso").value;
        const incidentId = document.getElementById("incidenteAviso").value;
        const incident = getVisibleIncidents().find((item) => String(item.id) === incidentId);
        if (!incident || !incident.derivadaAt ||
            incident.estado !== "Emergencia Concluida" || !incident.resultado) {
            window.alert("Selecciona un incidente derivado, revisado y cerrado por el personal de seguridad.");
            return;
        }
        if ((incident.resultado === "Falsa alarma") !==
            (template === "Falsa alarma aclarada por autoridades")) {
            window.alert(incident.resultado === "Falsa alarma"
                ? "Para una falsa alarma, selecciona el comunicado de aclaración."
                : "Ese comunicado solo corresponde a incidentes confirmados como falsa alarma.");
            return;
        }
        try {
            await data.publishOfficialNotice(template, incidentId);
            window.alert("Comunicado publicado en el feed de Comunidad. Las notificaciones push requieren configurar el servicio de mensajería.");
        } catch (error) {
            console.error("No se pudo publicar el aviso:", error);
            window.alert(error.code === "permission-denied"
                ? "Firestore rechazó el comunicado. Verifica que tu perfil esté activo y tenga rol de coordinador (o administrador autorizado), que el incidente pertenezca a tu comunidad y que ya esté concluido con resultado."
                : error.message || "No se pudo publicar el comunicado.");
        }
    }

    function renderNoticeIncidents(alerts) {
        const select = document.getElementById("incidenteAviso");
        const eligible = alerts
            .filter((incident) => incident.derivadaAt &&
                incident.estado === "Emergencia Concluida" && incident.resultado)
            .sort((first, second) =>
                new Date(second.closedAt || second.timestamp || 0) -
                new Date(first.closedAt || first.timestamp || 0)
            );
        const previousValue = select.value;
        select.replaceChildren(new Option("Selecciona un incidente revisado", ""));
        eligible.forEach((incident) => {
            const label = `${incident.tipo || "Incidente"} · ${incident.resultado} · ${formatDate(incident.closedAt || incident.timestamp)}`;
            select.add(new Option(label, String(incident.id)));
        });
        if (eligible.some((incident) => String(incident.id) === previousValue)) {
            select.value = previousValue;
        }
        select.disabled = eligible.length === 0;
        document.getElementById("plantillaAviso").disabled = eligible.length === 0;
        document.getElementById("btnPublicarAviso").disabled = eligible.length === 0;
        validateNoticeTemplate();
    }

    function validateNoticeTemplate() {
        const incident = getVisibleIncidents().find((item) =>
            String(item.id) === document.getElementById("incidenteAviso").value
        );
        const falseAlarm = document.querySelector('#plantillaAviso option[value="Falsa alarma aclarada por autoridades"]');
        if (!falseAlarm) return;
        falseAlarm.disabled = Boolean(incident && incident.resultado !== "Falsa alarma");
        if (incident && incident.resultado === "Falsa alarma") {
            document.getElementById("plantillaAviso").value = "Falsa alarma aclarada por autoridades";
        } else if (falseAlarm.selected) {
            document.getElementById("plantillaAviso").value = "Emergencia canalizada";
        }
    }

    async function loadEligibleDelegates() {
        const select = document.getElementById("delegadoUid");
        try {
            const result = await data.listCommunityDelegates();
            select.replaceChildren(new Option("Selecciona un vecino verificado", ""));
            result.members.forEach((member) => select.add(new Option(member.nombre, member.uid)));
            if (!result.members.length) {
                select.replaceChildren(new Option("No hay vecinos elegibles en esta comunidad", ""));
            }
        } catch (error) {
            console.error("No se pudieron cargar los vecinos elegibles:", error);
            select.replaceChildren(new Option("No se pudieron cargar los vecinos", ""));
        }
    }

    async function saveDelegation() {
        const substituteUid = document.getElementById("delegadoUid").value;
        const startValue = document.getElementById("delegadoInicio").value;
        const endValue = document.getElementById("delegadoFin").value;
        const start = new Date(startValue);
        const end = new Date(endValue);
        if (!substituteUid || !startValue || !endValue || !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime()) || end <= start) {
            window.alert("Selecciona un vecino y un intervalo válido para la delegación.");
            return;
        }
        try {
            await data.saveDelegation({
                suplenteUid: substituteUid,
                inicio: start.toISOString(),
                fin: end.toISOString()
            });
            renderDelegation();
        } catch (error) {
            console.error("No se pudo guardar la delegación:", error);
            window.alert("No se pudo guardar la delegación. Verifica los datos e inténtalo nuevamente.");
        }
    }

    function renderDelegation() {
        const element = document.getElementById("estadoDelegacion");
        const delegation = data.getDelegation();
        if (!delegation) {
            element.textContent = "Sin delegación activa.";
            return;
        }
        const select = document.getElementById("delegadoUid");
        const name = select.selectedOptions[0] && select.selectedOptions[0].textContent ||
            delegation.suplenteUid;
        const expired = new Date(delegation.fin).getTime() < Date.now();
        element.textContent = expired
            ? `La suplencia venció el ${formatDate(delegation.fin)}; los permisos se restituyen automáticamente.`
            : `${name}: ${formatDate(delegation.inicio)} a ${formatDate(delegation.fin)}.`;
    }

    async function saveZone() {
        const radiusKm = Number(document.getElementById("radioZona").value);
        if (!Number.isFinite(radiusKm) || radiusKm < 0.1 || radiusKm > 20) {
            window.alert("El radio debe estar entre 0,1 y 20 km.");
            return;
        }
        if (!navigator.geolocation) {
            window.alert("Este navegador no permite obtener la ubicación para definir el centro del radio.");
            return;
        }
        navigator.geolocation.getCurrentPosition(async (position) => {
            try {
                zone = {
                    latitud: position.coords.latitude,
                    longitud: position.coords.longitude,
                    radioMetros: radiusKm * 1000
                };
                await data.saveCoverageZone(zone);
                drawZone();
                render();
            } catch (error) {
                console.error("No se pudo guardar el radio de cobertura:", error);
                window.alert(error.message || "No se pudo guardar el radio de cobertura.");
            }
        }, (error) => {
            console.error("No se pudo obtener la ubicación para definir la zona:", error);
            window.alert("Permite el acceso a la ubicación y vuelve a guardar el radio.");
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }

    function togglePatrolLocation() {
        const status = document.getElementById("estadoPatrulla");
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
            status.textContent = "Ubicación GPS de patrulla detenida.";
            return;
        }
        if (!navigator.geolocation) {
            status.textContent = "Este navegador no permite geolocalización.";
            return;
        }
        status.textContent = "Conectando el GPS de esta unidad con Firebase...";
        let lastUpdate = 0;
        watchId = navigator.geolocation.watchPosition(async (position) => {
            if (Date.now() - lastUpdate < 5000) return;
            lastUpdate = Date.now();
            try {
                await data.updatePatrolLocation({
                    latitud: position.coords.latitude,
                    longitud: position.coords.longitude,
                    precisionMetros: position.coords.accuracy
                });
                status.textContent = `Ubicación de la unidad sincronizada ${new Date().toLocaleTimeString()}.`;
            } catch (error) {
                console.error("No se pudo sincronizar la ubicación de patrulla:", error);
                status.textContent = error.message || "No se pudo sincronizar la ubicación de patrulla.";
                navigator.geolocation.clearWatch(watchId);
                watchId = null;
            }
        }, (error) => {
            console.error("No se pudo obtener la ubicación de patrulla:", error);
            status.textContent = "No se pudo obtener ubicación. Revisa el permiso del navegador e inténtalo otra vez.";
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    }

    function renderMap(alerts) {
        if (!map || !alertLayer) return;
        alertLayer.clearLayers();
        alerts.filter((alert) => hasCoordinates(alert)).forEach((alert) => {
            const marker = L.circleMarker([Number(alert.latitud), Number(alert.longitud)], {
                radius: 8,
                color: "#fff",
                weight: 2,
                fillColor: colorFor(alert.tipo),
                fillOpacity: 0.95
            });
            marker.bindPopup(`<strong>${escapeHtml(alert.tipo || "Alerta")}</strong><br>${escapeHtml(alert.estado || "Pendiente")}<br>${formatDate(alert.timestamp)}<br>${Number(alert.reportes) || 1} reporte(s)`);
            marker.addTo(alertLayer);
        });
        drawPatrol(data.getPatrols());
        drawZone();
        if (heatmapEnabled) updateHeatmap(alerts);
    }

    function renderPatrol() {
        const patrols = data.getPatrols();
        document.getElementById("totalUnidades").textContent = String(patrols.length);
        drawPatrol(patrols);
    }

    function calculateEta(alert) {
        return Number(alert.etaMinutos) || 0;
    }

    function drawPatrol(patrols = data.getPatrols()) {
        if (!map || !patrolLayer) return;
        patrolLayer.clearLayers();
        patrols.filter((patrol) => Number.isFinite(Number(patrol.latitud)) &&
            Number.isFinite(Number(patrol.longitud))).forEach((patrol) => {
            const markerColor = patrol.estado === "Despachado" || patrol.estado === "En sitio"
                ? "#1676d2"
                : "#15875d";
            L.marker([Number(patrol.latitud), Number(patrol.longitud)], {
                icon: L.divIcon({
                    className: "central-patrol-marker",
                    html: `<span style="display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:${markerColor};color:white;border:2px solid white"><i class="fa-solid fa-car-side"></i></span>`,
                    iconSize: [34, 34]
                })
            }).bindPopup(`${escapeHtml(patrol.codigo || patrol.id)} · ${escapeHtml(patrol.estado || "Disponible")}`)
                .addTo(patrolLayer);
        });
    }

    function drawZone() {
        if (!map || !zoneLayer) return;
        zoneLayer.clearLayers();
        if (!zone) return;
        L.circle([zone.latitud, zone.longitud], {
            radius: zone.radioMetros,
            color: "#147b58",
            fillColor: "#38ad7f",
            fillOpacity: 0.1
        }).addTo(zoneLayer).bindPopup(`Radio de cobertura: ${(zone.radioMetros / 1000).toFixed(1)} km`);
    }

    function toggleHeatmap() {
        const modal = document.getElementById("modalMapaCalor");
        if (modal.open) {
            closeHeatmap();
            return;
        }
        if (typeof L.heatLayer !== "function") {
            window.alert("No se cargó la extensión de mapa de calor. Comprueba tu conexión.");
            return;
        }
        if (!heatmapMap) {
            heatmapMap = L.map("mapaCalorModal").setView([-12.1, -77.03], 13);
            L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
                maxZoom: 19,
                attribution: "Tiles &copy; Esri"
            }).addTo(heatmapMap);
        }
        modal.showModal();
        heatmapEnabled = true;
        window.requestAnimationFrame(() => heatmapMap.invalidateSize());
        updateHeatmap(getVisibleIncidents());
    }

    function closeHeatmap() {
        const modal = document.getElementById("modalMapaCalor");
        if (modal.open) modal.close();
        heatmapEnabled = false;
    }

    function updateHeatmap(alerts) {
        if (typeof L.heatLayer !== "function" || !heatmapMap || !heatmapEnabled) return;
        const categories = Array.from(document.querySelectorAll(".central-filtros input:checked"))
            .map((input) => input.value);
        const points = alerts.filter((alert) => hasCoordinates(alert))
            .filter((alert) => categories.includes(data.normalizeCategory(alert.tipo)))
            .filter(matchesPeriod)
            .filter(matchesHeatmapShift)
            .map((alert) => [
                Number(alert.latitud),
                Number(alert.longitud),
                Math.min(1, 0.45 + (Math.max(1, Number(alert.reportes) || 1) - 1) * 0.1)
            ]);
        const status = document.getElementById("estadoMapaCalor");
        if (status) {
            status.textContent = points.length
                ? `${points.length} incidente(s) incluidos en el mapa de calor.`
                : "No hay incidentes con ubicación para los filtros seleccionados.";
            status.hidden = false;
        }
        if (heatLayer) heatmapMap.removeLayer(heatLayer);
        heatLayer = L.heatLayer(points, {
            radius: 34,
            blur: 24,
            maxZoom: 17,
            max: 1,
            minOpacity: 0.25,
            gradient: { 0.3: "#f6d54a", 0.65: "#f48634", 1: "#d52b2b" }
        }).addTo(heatmapMap);
        if (points.length) {
            heatmapMap.fitBounds(L.latLngBounds(points.map(([latitude, longitude]) => [
                latitude,
                longitude
            ])), { padding: [28, 28], maxZoom: 15 });
        }
    }

    function matchesHeatmapShift(alert) {
        if (document.getElementById("filtroTurnoCalor").value !== "night") return true;
        const hour = new Date(alert.timestamp || 0).getHours();
        return hour >= 22 || hour < 5;
    }

    function renderAudit() {
        auditList.replaceChildren();
        if (auditExpiryTimer !== null) {
            window.clearTimeout(auditExpiryTimer);
            auditExpiryTimer = null;
        }
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const recentStoredEntries = data.getAudit()
            .map((entry) => ({
                id: entry.id,
                at: entry.createdAt,
                action: entry.action,
                incidentId: entry.details && entry.details.incidenteId,
                actorUid: entry.actorUid,
                detail: ""
            }));
        const recentClosedIncidents = getVisibleIncidents()
            .filter((incident) => ["Emergencia Concluida", "Descartada"].includes(incident.estado))
            .map((incident) => ({
                id: incident.id,
                at: incident.closedAt || incident.ultimaActualizacion,
                action: incident.estado === "Descartada" ? "Alerta descartada" : "Alerta atendida",
                incidentId: incident.id,
                actorUid: incident.resueltoPorUid || "",
                detail: incident.estado === "Descartada"
                    ? incident.motivoDescarte || ""
                    : incident.resultado || ""
            }));
        const entries = [...recentStoredEntries, ...recentClosedIncidents]
            .filter((entry) => {
                const timestamp = new Date(entry.at || 0).getTime();
                return Number.isFinite(timestamp) && timestamp <= now && now - timestamp < dayMs;
            })
            .sort((first, second) =>
                new Date(second.at).getTime() - new Date(first.at).getTime()
            )
            .filter((entry, index, list) =>
                list.findIndex((candidate) =>
                    String(candidate.id || candidate.incidentId) ===
                    String(entry.id || entry.incidentId)
                ) === index
            );
        const summary = document.getElementById("resumenBitacora");
        if (summary) {
            summary.textContent = `Acciones de las últimas 24 horas (${entries.length})`;
        }
        if (!entries.length) {
            auditList.append(makeEmpty("Aún no hay acciones registradas."));
            return;
        }
        entries.forEach((entry) => {
            const row = document.createElement("div");
            row.className = "central-auditoria-item";
            row.textContent = [
                formatDate(entry.at),
                entry.action,
                entry.incidentId ? `Incidente ${entry.incidentId}` : "",
                entry.detail,
                entry.actorUid ? `Usuario ${entry.actorUid}` : ""
            ].filter(Boolean).join(" · ");
            auditList.append(row);
        });
        const nextExpiry = entries.reduce((earliest, entry) => {
            const expiresAt = new Date(entry.at).getTime() + dayMs;
            return Math.min(earliest, expiresAt);
        }, Infinity);
        if (Number.isFinite(nextExpiry)) {
            auditExpiryTimer = window.setTimeout(renderAudit, Math.max(0, nextExpiry - now) + 1);
        }
    }

    function matchesPeriod(alert) {
        const value = timeFilter.value;
        if (value === "all") return true;
        const timestamp = new Date(alert.timestamp || 0).getTime();
        const now = Date.now();
        if (value === "hour") return now - timestamp <= 60 * 60 * 1000;
        if (value === "today") {
            const date = new Date(timestamp);
            const today = new Date();
            return date.toDateString() === today.toDateString();
        }
        return now - timestamp <= 7 * 24 * 60 * 60 * 1000;
    }

    function isInZone(alert) {
        if (!zone || !hasCoordinates(alert)) return true;
        return data.distanceMeters(zone, alert) <= zone.radioMetros;
    }

    async function toggleNightTheme() {
        const profile = data.getProfile() || {};
        const preferences = profile.preferencias &&
            typeof profile.preferencias === "object" &&
            !Array.isArray(profile.preferencias)
            ? profile.preferencias
            : {};
        try {
            await data.savePreferences({
                ...preferences,
                temaOscuro: !Boolean(preferences.temaOscuro)
            });
        } catch (error) {
            console.error("No se pudo guardar el tema de la cuenta:", error);
            window.alert(error.message || "No se pudo guardar el tema.");
        }
    }

    function applyNightTheme() {
        const preferences = data.getProfile() && data.getProfile().preferencias;
        document.body.classList.toggle("central-night", Boolean(preferences && preferences.temaOscuro));
    }

    function makeEmpty(text) {
        const element = document.createElement("div");
        element.className = "central-empty";
        element.textContent = text;
        return element;
    }

    function hasCoordinates(alert) {
        return Number.isFinite(Number(alert.latitud)) && Number.isFinite(Number(alert.longitud)) &&
            alert.latitud !== null && alert.longitud !== null;
    }

    function colorFor(type) {
        const category = data.normalizeCategory(type);
        return category === "robo" ? "#d63d3d" :
            category === "sospecha" ? "#d99a00" :
                category === "accidente" ? "#2774c8" : "#e26424";
    }

    function iconFor(type) {
        const icons = {
            robo: "fa-mask",
            sospecha: "fa-user-secret",
            accidente: "fa-car-burst",
            incendio: "fa-fire"
        };
        return icons[type] || "fa-triangle-exclamation";
    }

    function formatDate(value) {
        const date = new Date(value || 0);
        return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Hora no disponible";
    }

    function escapeHtml(value) {
        const element = document.createElement("span");
        element.textContent = String(value || "");
        return element.innerHTML;
    }
});
