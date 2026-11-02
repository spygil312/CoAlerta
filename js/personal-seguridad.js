import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection, doc, onSnapshot, query, runTransaction, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

document.addEventListener("DOMContentLoaded", function () {
    const data = window.coalertaData;
    const incidentList = document.getElementById("listaAlertasSeguridad");
    const status = document.getElementById("estadoSeguridad");
    const notice = document.getElementById("avisoUnidad");
    const selectedDetails = document.getElementById("detalleSeleccionado");
    const routeStatus = document.getElementById("estadoRutaSeguridad");
    const locationStatus = document.getElementById("estadoUbicacionSeguridad");
    const allowedRoles = new Set(["agente", "seguridad", "administrador", "admin"]);
    let map;
    let alertLayer;
    let routeLayer;
    let patrolLayer;
    let selectedIncidentId = null;
    let watchId = null;
    let lastLocationSentAt = 0;
    let lastLocation = null;
    let dispatchProfile = null;
    let stopWatchingProfile = null;
    let dispatchExpiryTimer = null;
    let openAlerts = [];
    let openAlertsError = null;
    let securityLocation = null;
    let stopWatchingOpenAlerts = null;

    if (!data) {
        setStatus("No se pudo iniciar Firebase.", "error");
        return;
    }

    initializeMap();
    document.getElementById("btnActualizarSeguridad").addEventListener("click", render);
    document.getElementById("btnUbicacionUnidad").addEventListener("click", startLocationSharing);
    document.getElementById("btnDetenerUbicacion").addEventListener("click", () => stopLocationSharing(true));
    document.getElementById("btnCerrarSesionSeguridad").addEventListener("click", closeSession);
    incidentList.addEventListener("click", handleIncidentClick);
    window.addEventListener("coalerta:datos-listos", initializeFromProfile);
    window.addEventListener("coalerta:incidentes-actualizados", render);
    window.addEventListener("coalerta:patrullas-actualizadas", render);
    window.addEventListener("coalerta:error", function (event) {
        if (event.detail && ["perfil", "incidentes operativos"].includes(event.detail.area)) {
            setStatus(event.detail.message || "Error de sincronización.", "error");
            if (event.detail.area === "incidentes operativos") {
                incidentList.replaceChildren(makeEmpty("No se pudieron cargar los incidentes desde Firebase."));
            }
        }
    });
    window.addEventListener("beforeunload", () => stopLocationSharing(false));
    window.addEventListener("beforeunload", stopProfileListener, { once: true });
    if (data.isReady()) initializeFromProfile();

    function initializeMap() {
        const element = document.getElementById("mapaSeguridad");
        if (typeof L === "undefined") {
            element.textContent = "No se pudo cargar el mapa. Comprueba tu conexión.";
            setStatus("Mapa no disponible.", "error");
            return;
        }
        map = L.map(element).setView([-12.1, -77.03], 13);
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 19,
            attribution: "Tiles &copy; Esri"
        }).addTo(map);
        alertLayer = L.layerGroup().addTo(map);
        routeLayer = L.layerGroup().addTo(map);
        patrolLayer = L.layerGroup().addTo(map);
        window.setTimeout(() => map.invalidateSize(), 200);
    }

    function initializeFromProfile() {
        if (!data.isReady()) return;
        if (!allowedRoles.has(data.getRole())) {
            window.location.replace(data.getRole() === "coordinador"
                ? "coordinador_vecinal.html"
                : "mapa.html");
            return;
        }
        updateSidebarProfile(data.getProfile());
        dispatchProfile = data.getProfile();
        watchDispatchProfile();
        watchOpenAlerts();
        locateSecurityForOpenAlerts();
        setStatus("Conectado a Firebase.", "connected");
        document.getElementById("metricUnidad").textContent =
            data.getProfile().codigoPatrulla || data.getProfile().patrullaId || "Sin asignar";
        const profile = data.getProfile();
        const hasPatrol = Boolean(profile.patrullaId);
        const isSecurity = data.getRole() === "seguridad";
        const hasCommunity = Boolean(profile.comunidadId);
        const canShareLocation = hasCommunity && (hasPatrol || isSecurity);
        notice.hidden = hasCommunity && (hasPatrol || isSecurity);
        notice.textContent = !hasCommunity
            ? "Únete a una comunidad antes de compartir GPS o despachar alertas."
            : "Tu perfil todavía no tiene una unidad asignada. Solicita al administrador la asignación para poder despachar alertas.";
        document.getElementById("btnUbicacionUnidad").disabled = !canShareLocation;
        const locationButton = document.getElementById("btnUbicacionUnidad");
        const locationButtonIcon = locationButton.querySelector("i");
        locationButton.replaceChildren(
            locationButtonIcon,
            document.createTextNode(isSecurity && !hasPatrol
                ? " Compartir ubicación de serenazgo"
                : " Compartir ubicación de unidad")
        );
        render();
    }

    function watchDispatchProfile() {
        const user = auth.currentUser;
        if (!user) return;
        stopProfileListener();
        stopWatchingProfile = onSnapshot(doc(db, "usuarios", user.uid), (snapshot) => {
            if (!snapshot.exists()) {
                dispatchProfile = null;
                updateDispatchReadiness("No se encontró el perfil de seguridad.");
                return;
            }
            dispatchProfile = { uid: user.uid, ...snapshot.data() };
            const assignedUnit = dispatchProfile.codigoPatrulla || dispatchProfile.patrullaId;
            document.getElementById("metricUnidad").textContent = assignedUnit || "Sin asignar";
            updateDispatchReadiness();
            render();
        }, (error) => {
            console.error("No se pudo sincronizar el perfil para validar despachos:", error);
            dispatchProfile = null;
            updateDispatchReadiness("No se pudo validar la unidad y ubicación en tiempo real.");
        });
    }

    function stopProfileListener() {
        if (stopWatchingProfile) stopWatchingProfile();
        stopWatchingProfile = null;
    }

    function updateSidebarProfile(profile) {
        const account = profile || {};
        const name = account.nombre ||
            [account.nombres, account.apellidos].filter(Boolean).join(" ") ||
            "Personal de seguridad";
        const nameElement = document.getElementById("sidebarNombre");
        const roleElement = document.getElementById("sidebarRol");
        const avatar = document.getElementById("sidebarAvatarImg");
        const avatarIcon = document.getElementById("sidebarAvatarIcon");
        const photo = account.fotoBase64 || account.fotoURL || account.photoURL;

        nameElement.textContent = `Hola, ${name.trim().split(/\s+/)[0]}`;
        roleElement.textContent = ["administrador", "admin"].includes(data.getRole())
            ? "Administrador"
            : "Personal de seguridad";
        if (!photo) return;

        avatar.onerror = function () {
            avatar.hidden = true;
            avatarIcon.hidden = false;
        };
        avatar.src = photo;
        avatar.hidden = false;
        avatarIcon.hidden = true;
    }

    function render() {
        if (!data.isReady() || !allowedRoles.has(data.getRole())) return;
        updateDispatchReadiness();
        const profile = data.getProfile();
        const canViewAllCommunities = ["administrador", "admin"].includes(data.getRole());
        const incidents = data.getIncidents().filter((incident) =>
            canViewAllCommunities ||
            Boolean(profile.comunidadId) && incident.comunidadId === profile.comunidadId
        ).sort((first, second) =>
            new Date(second.timestamp || 0) - new Date(first.timestamp || 0)
        );
        const actionable = incidents.filter((incident) =>
            ["Derivada a Central", "Auxilio en camino", "Agentes en sitio"].includes(incident.estado)
        );
        const nearbyOpenAlerts = getNearbyOpenAlerts();
        const displayedAlerts = actionable.concat(nearbyOpenAlerts);
        const active = incidents.filter((incident) =>
            ["Auxilio en camino", "Agentes en sitio"].includes(incident.estado)
        );
        document.getElementById("metricPendientes").textContent = String(
            actionable.filter((incident) => incident.estado === "Derivada a Central").length +
            nearbyOpenAlerts.length
        );
        document.getElementById("metricActivas").textContent = String(active.length);
        if (!displayedAlerts.some((incident) => String(incident.id) === selectedIncidentId)) {
            selectedIncidentId = displayedAlerts.length ? String(displayedAlerts[0].id) : null;
        }
        incidentList.replaceChildren();
        if (!displayedAlerts.length) {
            incidentList.append(makeEmpty(openAlertsError ||
                "No hay alertas derivadas o asignadas para atender."));
        } else {
            actionable.forEach((incident) => incidentList.append(createIncidentCard(incident)));
            nearbyOpenAlerts.forEach((incident) =>
                incidentList.append(createOpenEmergencyCard(incident))
            );
        }
        drawMap(displayedAlerts);
    }

    function watchOpenAlerts() {
        if (stopWatchingOpenAlerts) stopWatchingOpenAlerts();
        const openAlertsQuery = query(
            collection(db, "alertas"),
            where("tipo", "==", "alerta_abierta"),
            where("estado", "==", "pendiente")
        );
        stopWatchingOpenAlerts = onSnapshot(openAlertsQuery, (snapshot) => {
            openAlertsError = null;
            openAlerts = snapshot.docs.map((document) => {
                const incident = document.data();
                const point = incident.ubicacion || {};
                const timestamp = incident.timestamp && typeof incident.timestamp.toDate === "function"
                    ? incident.timestamp.toDate().toISOString()
                    : incident.timestamp;
                return {
                    ...incident,
                    id: document.id,
                    tipo: "Emergencia inmediata",
                    latitud: Number(point.lat),
                    longitud: Number(point.lng),
                    estado: "pendiente",
                    timestamp
                };
            });
            render();
        }, (error) => {
            console.error("No se pudieron sincronizar las emergencias inmediatas:", error);
            openAlerts = [];
            openAlertsError = error.code === "permission-denied"
                ? "Firebase denegó el acceso a la cola. El administrador debe publicar las reglas actuales de Firestore y verificar que esta cuenta esté activa con rol de seguridad."
                : "No se pudieron cargar las emergencias inmediatas. Revisa la conexión e inténtalo de nuevo.";
            setStatus(openAlertsError, "error");
            render();
        });
    }

    function locateSecurityForOpenAlerts() {
        if (!navigator.geolocation) {
            locationStatus.textContent = "Este navegador no permite filtrar emergencias por ubicación GPS.";
            render();
            return;
        }
        navigator.geolocation.getCurrentPosition((position) => {
            securityLocation = {
                latitud: position.coords.latitude,
                longitud: position.coords.longitude
            };
            locationStatus.textContent = "Ubicación disponible para recibir emergencias cercanas.";
            render();
        }, (error) => {
            console.warn("No se pudo obtener la ubicación para filtrar emergencias:", error);
            locationStatus.textContent =
                "Activa la ubicación GPS para ver emergencias inmediatas a menos de 5 km.";
            render();
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    }

    function getNearbyOpenAlerts() {
        if (!securityLocation) return [];
        return openAlerts.filter((incident) =>
            validPoint(incident) &&
            data.distanceMeters(securityLocation, {
                latitud: Number(incident.latitud),
                longitud: Number(incident.longitud)
            }) <= 5000
        );
    }

    function createOpenEmergencyCard(incident) {
        const card = document.createElement("article");
        card.className = "seguridad-alert-card";
        card.dataset.selected = String(String(incident.id) === selectedIncidentId);

        const select = document.createElement("button");
        select.type = "button";
        select.className = "seguridad-alert-select";
        select.dataset.selectIncident = String(incident.id);
        const heading = document.createElement("span");
        heading.className = "seguridad-alert-title";
        const identity = document.createElement("span");
        identity.className = "seguridad-alert-identity";
        const icon = document.createElement("span");
        icon.className = "seguridad-alert-icon";
        icon.style.backgroundColor = "#b42318";
        const iconElement = document.createElement("i");
        iconElement.className = "fa-solid fa-triangle-exclamation";
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);
        const title = document.createElement("strong");
        title.textContent = "Emergencia inmediata";
        identity.append(icon, title);
        const state = document.createElement("span");
        state.className = "seguridad-alert-state";
        state.textContent = "Pendiente";
        heading.append(identity, state);
        const summary = document.createElement("p");
        const distance = data.distanceMeters(securityLocation, {
            latitud: Number(incident.latitud),
            longitud: Number(incident.longitud)
        });
        summary.textContent =
            `Reporte inmediato · a ${(distance / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} km`;
        select.append(heading, summary);

        const actions = document.createElement("div");
        actions.className = "seguridad-card-actions";
        actions.append(makeButton("accept-open", "Atender emergencia"));
        if (hasCoordinates(incident)) actions.append(makeButton("route", "Calcular ruta"));
        card.append(select, actions);
        return card;
    }

    function createIncidentCard(incident) {
        const card = document.createElement("article");
        card.className = "seguridad-alert-card";
        card.dataset.selected = String(String(incident.id) === selectedIncidentId);

        const category = data.normalizeCategory(incident.tipo || incident.categoria);
        const iconByCategory = {
            robo: "fa-mask-face",
            sospecha: "fa-user-secret",
            accidente: "fa-truck-medical",
            incendio: "fa-fire"
        };
        const colorByCategory = {
            robo: "#d63d3d",
            sospecha: "#d99a00",
            accidente: "#2774c8",
            incendio: "#e26424"
        };
        card.dataset.category = category;
        const select = document.createElement("button");
        select.type = "button";
        select.className = "seguridad-alert-select";
        select.dataset.selectIncident = String(incident.id);
        const heading = document.createElement("span");
        heading.className = "seguridad-alert-title";
        const identity = document.createElement("span");
        identity.className = "seguridad-alert-identity";
        const icon = document.createElement("span");
        icon.className = "seguridad-alert-icon";
        icon.style.backgroundColor = colorByCategory[category] || "#435d57";
        const iconElement = document.createElement("i");
        iconElement.className = `fa-solid ${iconByCategory[category] || "fa-triangle-exclamation"}`;
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);
        const title = document.createElement("strong");
        title.textContent = `${incident.tipo || "Alerta"}${Number(incident.reportes) > 1 ? ` · ${incident.reportes} reportes` : ""}`;
        identity.append(icon, title);
        const state = document.createElement("span");
        state.className = "seguridad-alert-state";
        state.textContent = incident.estado;
        heading.append(identity, state);
        const summary = document.createElement("p");
        summary.textContent = `${incident.detalle || "Sin detalle adicional"} · ${incident.ubicacion || "Ubicación no disponible"}`;
        select.append(heading, summary);

        const actions = document.createElement("div");
        actions.className = "seguridad-card-actions";
        if (incident.estado === "Derivada a Central") {
            const dispatchButton = makeButton("dispatch", "Despachar unidad");
            const dispatchStatus = getDispatchEligibility();
            dispatchButton.disabled = !dispatchStatus.allowed;
            dispatchButton.title = dispatchButton.disabled
                ? dispatchStatus.message
                : "Despachar la unidad asignada a esta alerta.";
            actions.append(dispatchButton);
        } else if (incident.estado === "Auxilio en camino") {
            actions.append(makeButton("onsite", "Marcar llegada"));
        } else if (incident.estado === "Agentes en sitio") {
            const outcome = document.createElement("select");
            outcome.dataset.outcomeFor = String(incident.id);
            outcome.setAttribute("aria-label", "Resultado del incidente");
            [
                ["Persona detenida", "Persona detenida"],
                ["Falsa alarma", "Falsa alarma"],
                ["Intervención preventiva", "Intervención preventiva"],
                ["Sin novedad", "Sin novedad"]
            ].forEach(([value, label]) => outcome.add(new Option(label, value)));
            actions.append(outcome, makeButton("close", "Cerrar incidente"));
        }
        if (hasCoordinates(incident)) actions.append(makeButton("route", "Calcular ruta"));
        card.append(select, actions);
        return card;
    }

    function makeButton(action, label) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "seguridad-button";
        button.dataset.action = action;
        button.textContent = label;
        return button;
    }

    async function handleIncidentClick(event) {
        const selector = event.target.closest("[data-select-incident]");
        if (selector) {
            selectedIncidentId = selector.dataset.selectIncident;
            render();
            return;
        }
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const card = button.closest(".seguridad-alert-card");
        const incidentId = card && card.querySelector("[data-select-incident]")?.dataset.selectIncident;
        if (!incidentId) return;
        button.disabled = true;
        try {
            const incident = data.getIncidents().find((item) => String(item.id) === incidentId) ||
                getNearbyOpenAlerts().find((item) => String(item.id) === incidentId);
            if (!incident) throw new Error("No se encontró el incidente seleccionado.");
            if (button.dataset.action === "dispatch") {
                const dispatchStatus = getDispatchEligibility();
                if (!dispatchStatus.allowed) throw new Error(dispatchStatus.message);
            }
            if (button.dataset.action === "route") {
                await showRoute(incident);
                return;
            }
            if (button.dataset.action === "accept-open") {
                await acceptOpenEmergency(incident);
                return;
            }
            if (button.dataset.action === "close") {
                const outcome = card.querySelector(`[data-outcome-for="${incidentId}"]`).value;
                await data.transitionIncident(incidentId, "close", { outcome });
            } else {
                await data.transitionIncident(incidentId, button.dataset.action);
            }
            render();
        } catch (error) {
            console.error("No se pudo actualizar el incidente:", error);
            window.alert(error.message || "No se pudo actualizar el incidente.");
        } finally {
            button.disabled = false;
        }
    }

    async function acceptOpenEmergency(incident) {
        const alertRef = doc(db, "alertas", String(incident.id));
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(alertRef);
            if (!snapshot.exists() || snapshot.get("estado") !== "pendiente") {
                throw new Error("Esta emergencia ya fue atendida por otro operador.");
            }
            transaction.update(alertRef, {
                estado: "en_atencion",
                atendidaAt: serverTimestamp()
            });
        });
    }

    function drawMap(incidents) {
        if (!map || !alertLayer) return;
        alertLayer.clearLayers();
        patrolLayer.clearLayers();
        routeLayer.clearLayers();
        const bounds = [];
        incidents.forEach((incident) => {
            if (!hasCoordinates(incident)) return;
            const marker = L.marker([Number(incident.latitud), Number(incident.longitud)])
                .bindPopup(`<strong>${escapeHtml(incident.tipo || "Alerta")}</strong><br>${escapeHtml(incident.estado || "")}`)
                .addTo(alertLayer);
            if (String(incident.id) === selectedIncidentId) marker.openPopup();
            bounds.push(marker.getLatLng());
        });
        const profile = data.getProfile();
        const patrol = data.getPatrols().find((item) => item.id === profile.patrullaId);
        if (patrol && validPoint(patrol)) {
            L.marker([Number(patrol.latitud), Number(patrol.longitud)], {
                icon: L.divIcon({ className: "seguridad-patrol-marker", html: "●", iconSize: [20, 20] })
            }).bindPopup("Ubicación de la unidad").addTo(patrolLayer);
            bounds.push([Number(patrol.latitud), Number(patrol.longitud)]);
        }
        if (bounds.length) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
        updateSelectedDetails(incidents);
    }

    function updateSelectedDetails(incidents) {
        const incident = incidents.find((item) => String(item.id) === selectedIncidentId);
        if (!incident) {
            selectedDetails.textContent = "Selecciona una alerta de la cola.";
            return;
        }
        selectedDetails.textContent =
            `${incident.tipo || "Alerta"} · ${incident.estado} · ${incident.ubicacion || "Ubicación no disponible"}` +
            (hasCoordinates(incident) ? ` · ${Number(incident.latitud).toFixed(5)}, ${Number(incident.longitud).toFixed(5)}` : "");
    }

    async function showRoute(incident) {
        if (!hasCoordinates(incident) || !map) throw new Error("La alerta no tiene coordenadas válidas.");
        const profile = data.getProfile();
        const patrolId = profile.patrullaId;
        const patrols = data.getPatrols().filter((patrol) => validPoint(patrol));
        let origin = patrols.find((patrol) => patrol.id === patrolId);
        if (!origin && securityLocation) {
            origin = {
                latitud: securityLocation.latitud,
                longitud: securityLocation.longitud,
                codigo: "Tu ubicación"
            };
        }
        if (!origin && data.getRole() === "seguridad" && profile.comunidadId) {
            const member = data.getCommunityMembers().find((item) => item.id === profile.uid);
            const updatedAt = new Date(member && member.ubicacionActualizadaAt || 0).getTime();
            if (member && member.ubicacionCompartida === true &&
                Date.now() - updatedAt <= 2 * 60 * 1000 && validPoint(member)) {
                origin = {
                    latitud: Number(member.latitud),
                    longitud: Number(member.longitud),
                    codigo: "Ubicación compartida de serenazgo"
                };
            }
        }
        if (!origin && navigator.geolocation) {
            origin = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    (position) => resolve({
                        latitud: position.coords.latitude,
                        longitud: position.coords.longitude,
                        codigo: "Tu ubicación"
                    }),
                    () => reject(new Error("No se pudo obtener la ubicación de la unidad para calcular la ruta.")),
                    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
                );
            });
        }
        if (!origin) throw new Error("La unidad aún no tiene ubicación GPS.");
        if (!window.confirm("Se enviarán las coordenadas de la unidad y la alerta al servicio público OSRM para calcular la ruta. ¿Deseas continuar?")) return;
        const coordinates = `${Number(origin.longitud)},${Number(origin.latitud)};${Number(incident.longitud)},${Number(incident.latitud)}`;
        const response = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
            { headers: { Accept: "application/json" } }
        );
        if (!response.ok) throw new Error("El servicio de rutas no está disponible. Inténtalo nuevamente.");
        const result = await response.json();
        const route = result.routes && result.routes[0];
        if (!route || !route.geometry) throw new Error("No se encontró una ruta vial.");
        routeLayer.clearLayers();
        const line = L.geoJSON(route.geometry, {
            style: { color: "#1267d6", weight: 6, opacity: .85 }
        }).addTo(routeLayer);
        map.fitBounds(line.getBounds(), { padding: [30, 30] });
        routeStatus.textContent =
            `Ruta desde ${origin.codigo || origin.codigoPatrulla || "la unidad"}: ` +
            `${(route.distance / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} km · ` +
            `${Math.max(1, Math.ceil(route.duration / 60))} min estimados.`;
    }

    function startLocationSharing() {
        if (!navigator.geolocation) {
            locationStatus.textContent = "Este navegador no permite compartir ubicación GPS.";
            return;
        }
        if (watchId !== null) return;
        watchId = navigator.geolocation.watchPosition(async (position) => {
            const point = {
                latitud: position.coords.latitude,
                longitud: position.coords.longitude,
                precisionMetros: Math.max(1, position.coords.accuracy)
            };
            securityLocation = point;
            render();
            const movedEnough = !lastLocation ||
                data.distanceMeters(lastLocation, point) >= 25;
            if (!movedEnough && Date.now() - lastLocationSentAt < 15000) return;
            let stage = "actualizar la ubicación de serenazgo";
            try {
                const profile = await data.refreshCurrentProfile();
                if (data.getRole() === "seguridad" && profile.comunidadId && !profile.patrullaId) {
                    await data.updateSecurityLocation(point);
                }
                if (profile.patrullaId) {
                    stage = "actualizar la ubicación de la unidad y habilitar el despacho";
                    await data.updatePatrolLocation(point);
                }
                lastLocation = point;
                lastLocationSentAt = Date.now();
                locationStatus.textContent =
                    `Ubicación actualizada · precisión ±${Math.round(position.coords.accuracy)} m.`;
                render();
            } catch (error) {
                console.error(`No se pudo ${stage}:`, error);
                locationStatus.textContent = `${stage}: ${error.message || "permiso denegado por Firestore."}`;
            }
        }, (error) => {
            console.error("No se pudo obtener la ubicación de la unidad:", error);
            locationStatus.textContent = error.code === 1
                ? "Permite el acceso a la ubicación para compartir la posición de tu unidad."
                : "No se pudo obtener la ubicación GPS.";
            stopLocationSharing();
        }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
        document.getElementById("btnUbicacionUnidad").disabled = true;
        document.getElementById("btnDetenerUbicacion").disabled = false;
        locationStatus.textContent = "Obteniendo ubicación GPS de la unidad…";
    }

    async function stopLocationSharing(clearRemote = true) {
        if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        if (clearRemote && lastLocation && data.isReady() &&
            ["seguridad", "agente"].includes(data.getRole())) {
            try {
                await data.clearSecurityLocation();
            } catch (error) {
                console.error("No se pudo detener la ubicación compartida de serenazgo:", error);
                locationStatus.textContent = error.message || "No se pudo detener la ubicación compartida.";
                return;
            }
        }
        lastLocation = null;
        const stopButton = document.getElementById("btnDetenerUbicacion");
        if (stopButton) stopButton.disabled = true;
        const startButton = document.getElementById("btnUbicacionUnidad");
        if (startButton && data.isReady()) {
            const profile = data.getProfile();
            startButton.disabled = !profile.patrullaId &&
                !(data.getRole() === "seguridad" && profile.comunidadId);
        }
        if (locationStatus) locationStatus.textContent = "La ubicación no se está compartiendo.";
    }

    async function closeSession() {
        if (!window.confirm("¿Seguro que deseas cerrar sesión?")) return;
        try {
            await stopLocationSharing(true);
            await signOut(auth);
            localStorage.removeItem("coalerta_usuario");
            localStorage.removeItem("coalertaSesion");
            window.location.replace("login.html");
        } catch (error) {
            console.error("No se pudo cerrar la sesión:", error);
            window.alert(error.message || "No se pudo cerrar la sesión.");
        }

        function stopOpenAlertsListener() {
            if (stopWatchingOpenAlerts) stopWatchingOpenAlerts();
            stopWatchingOpenAlerts = null;
        }

        window.addEventListener("beforeunload", stopOpenAlertsListener, { once: true });
    }

    function hasCoordinates(incident) {
        return validPoint(incident);
    }

    function getDispatchEligibility() {
        const profile = dispatchProfile;
        if (!profile || !["seguridad", "agente"].includes(profile.rol)) {
            return { allowed: false, message: "El despacho solo está disponible para personal de seguridad autorizado." };
        }
        if (profile.activo !== true ||
            profile.rol === "seguridad" && profile.estadoSolicitudRol !== "aprobada") {
            return { allowed: false, message: "La cuenta debe estar activa y aprobada para despachar." };
        }
        if (!/^Unidad-(?:0[1-9]|10)$/.test(String(profile.patrullaId || ""))) {
            return { allowed: false, message: "Requiere una unidad asignada por el administrador." };
        }
        if (!profile.comunidadId) {
            return { allowed: false, message: "Únete a una comunidad para atender sus alertas." };
        }
        const timestamp = getTimestampMillis(profile.ultimaUbicacion && profile.ultimaUbicacion.timestamp);
        const age = Date.now() - timestamp;
        if (!Number.isFinite(timestamp) || age < 0 || age >= 300000) {
            return {
                allowed: false,
                message: "No hay GPS reciente. Pulsa «Activar GPS para habilitar despacho» y permite el acceso a la ubicación."
            };
        }
        return { allowed: true, message: "" };
    }

    function updateDispatchReadiness(overrideMessage) {
        const status = overrideMessage
            ? { allowed: false, message: overrideMessage }
            : getDispatchEligibility();
        if (dispatchExpiryTimer !== null) {
            window.clearTimeout(dispatchExpiryTimer);
            dispatchExpiryTimer = null;
        }
        const message = document.getElementById("avisoDespacho");
        if (message) {
            message.textContent = status.allowed
                ? "Unidad asignada y GPS actualizado. El despacho está habilitado."
                : status.message;
            message.dataset.estado = status.allowed ? "correcto" : "pendiente";
            message.hidden = false;
        }
        updateLocationButtonLabel(status);
        incidentList.querySelectorAll('button[data-action="dispatch"]').forEach((button) => {
            button.disabled = !status.allowed;
            button.title = status.message;
        });
        if (status.allowed) {
            const timestamp = getTimestampMillis(dispatchProfile.ultimaUbicacion.timestamp);
            const remaining = Math.max(0, 300000 - (Date.now() - timestamp));
            dispatchExpiryTimer = window.setTimeout(() => {
                dispatchExpiryTimer = null;
                updateDispatchReadiness();
                render();
            }, remaining + 1);
        }
    }

    function updateLocationButtonLabel(status) {
        const button = document.getElementById("btnUbicacionUnidad");
        if (!button || !data.isReady()) return;
        const profile = data.getProfile();
        const icon = button.querySelector("i");
        const label = profile && profile.patrullaId && !status.allowed
            ? " Activar GPS para habilitar despacho"
            : data.getRole() === "seguridad" && profile && !profile.patrullaId
                ? " Compartir ubicación de serenazgo"
                : " Compartir ubicación de unidad";
        button.replaceChildren(icon, document.createTextNode(label));
        if (!profile || !profile.comunidadId) {
            button.disabled = true;
            button.title = "Únete a una comunidad para compartir GPS.";
        } else {
            button.disabled = watchId !== null;
            button.title = status.allowed
                ? "La ubicación GPS está actualizada."
                : "Activa el GPS y permite la ubicación para habilitar despachos.";
        }
    }

    function getTimestampMillis(value) {
        if (value && typeof value.toMillis === "function") return value.toMillis();
        if (value && typeof value.toDate === "function") return value.toDate().getTime();
        const parsed = new Date(value || 0).getTime();
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function validPoint(point) {
        return Number.isFinite(Number(point.latitud)) &&
            Number.isFinite(Number(point.longitud)) &&
            Number(point.latitud) >= -90 && Number(point.latitud) <= 90 &&
            Number(point.longitud) >= -180 && Number(point.longitud) <= 180;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (character) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[character]);
    }

    function makeEmpty(text) {
        const element = document.createElement("p");
        element.className = "seguridad-empty";
        element.textContent = text;
        return element;
    }

    function setStatus(text, stateName) {
        status.textContent = text;
        status.dataset.state = stateName;
    }
});
