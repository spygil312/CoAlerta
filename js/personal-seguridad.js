import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, onSnapshot, query, runTransaction, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";
import { configurarCierreSesion, escapeHtml } from "./general.js?v=shared-core-20261106";

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
    let displayedIncidents = [];
    const incidentCoordinatesCache = new Map();
    const incidentCoordinateLoads = new Map();
    let watchId = null;
    let locationSyncTimer = null;
    let latestLocationPoint = null;
    let locationSyncInProgress = false;
    let lastLocation = null;
    let dispatchProfile = null;
    let stopWatchingProfile = null;
    let dispatchExpiryTimer = null;
    let openAlerts = [];
    let openAlertsError = null;
    let securityLocation = null;
    let stopWatchingOpenAlerts = null;
    let knownDispatchStates = null;

    if (!data) {
        setStatus("No se pudo iniciar Firebase.", "error");
        return;
    }

    initializeMap();
    document.getElementById("btnActualizarSeguridad").addEventListener("click", render);
    document.getElementById("btnUbicacionUnidad").addEventListener("click", startLocationSharing);
    document.getElementById("btnDetenerUbicacion").addEventListener("click", () => stopLocationSharing(true));
    configurarCierreSesion({
        auth,
        signOut,
        buttonIds: ["btnCerrarSesionSeguridad"],
        confirmationMessage: "¿Seguro que deseas cerrar sesión?",
        clearCachedSession: true,
        replaceLocation: true,
        beforeSignOut: async () => {
            window.addEventListener("beforeunload", stopOpenAlertsListener, { once: true });
            await stopLocationSharing(true);
        },
        errorMessage: (error) => error.message || "No se pudo cerrar la sesión."
    });
    incidentList.addEventListener("click", handleIncidentClick);
    window.addEventListener("coalerta:datos-listos", initializeFromProfile);
    window.addEventListener("coalerta:incidentes-actualizados", function () {
        const incidents = data.getIncidents();
        const profile = data.getProfile() || {};
        const newlyDispatchedToUnit = knownDispatchStates !== null && incidents.some((incident) =>
            incident.estado === "Auxilio en camino" &&
            String(incident.patrullaId || "") === String(profile.patrullaId || "") &&
            knownDispatchStates.get(String(incident.id)) !== "Auxilio en camino"
        );
        knownDispatchStates = new Map(
            incidents.map((incident) => [String(incident.id), incident.estado])
        );
        if (newlyDispatchedToUnit && window.coalertaSonidoEmergencia &&
            window.coalertaSonidoEmergencia.isEnabled()) {
            window.coalertaSonidoEmergencia.play().catch((error) => {
                console.error("No se pudo reproducir el sonido del despacho:", error);
            });
        }
        render();
    });
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
        displayedIncidents = displayedAlerts.map((incident) => ({
            ...incident,
            ...(incidentCoordinatesCache.get(String(incident.id)) || {})
        }));
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
        if (!displayedIncidents.length) {
            incidentList.append(makeEmpty(openAlertsError ||
                "No hay alertas derivadas o asignadas para atender."));
        } else {
            const actionableIds = new Set(actionable.map((incident) => String(incident.id)));
            displayedIncidents.forEach((incident) => incidentList.append(
                actionableIds.has(String(incident.id))
                    ? createIncidentCard(incident)
                    : createOpenEmergencyCard(incident)
            ));
        }
        drawMap(displayedIncidents);
        displayedIncidents.forEach((incident) => {
            if (!hasCoordinates(incident)) {
                void recoverIncidentCoordinates(incident).then(() => render()).catch((error) => {
                    console.error(
                        `No se pudieron recuperar las coordenadas del incidente ${incident.id}:`,
                        error
                    );
                });
            }
        });
    }

    function recoverIncidentCoordinates(incident) {
        const id = String(incident && incident.id || "");
        if (!id) return Promise.reject(new Error("El incidente no tiene identificador."));
        const cached = incidentCoordinatesCache.get(id);
        if (cached) return Promise.resolve({ ...incident, ...cached });
        const pending = incidentCoordinateLoads.get(id);
        if (pending) return pending.then((coordinates) => ({ ...incident, ...coordinates }));
        const load = getDoc(doc(db, "incidentes", id)).then((snapshot) => {
            if (!snapshot.exists()) {
                throw new Error("No se encontró el documento del incidente en Firestore.");
            }
            const storedIncident = snapshot.data();
            const location = storedIncident.ubicacion || {};
            const coordinates = {
                latitud: Number(storedIncident.latitud ?? location.lat ?? location.latitude),
                longitud: Number(storedIncident.longitud ?? location.lng ?? location.longitude)
            };
            if (!validPoint(coordinates)) {
                throw new Error("No se encontraron coordenadas válidas para el incidente.");
            }
            incidentCoordinatesCache.set(id, coordinates);
            return coordinates;
        }).finally(() => {
            incidentCoordinateLoads.delete(id);
        });
        incidentCoordinateLoads.set(id, load);
        return load.then((coordinates) => ({ ...incident, ...coordinates }));
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
                const tipoPorCategoria = {
                    robo: "Robo",
                    sospecha: "Sospecha",
                    accidente: "Accidente",
                    incendio: "Incendio"
                };
                return {
                    ...incident,
                    id: document.id,
                    tipo: tipoPorCategoria[incident.categoria] || "Emergencia inmediata",
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
                longitud: position.coords.longitude,
                precisionMetros: position.coords.accuracy,
                receivedAt: Date.now()
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
        const iconByCategory = {
            robo: "fa-mask-face",
            sospecha: "fa-user-secret",
            accidente: "fa-truck-medical",
            incendio: "fa-fire"
        };
        iconElement.className = `fa-solid ${iconByCategory[incident.categoria] || "fa-triangle-exclamation"}`;
        iconElement.setAttribute("aria-hidden", "true");
        icon.append(iconElement);
        const title = document.createElement("strong");
        title.textContent = incident.tipo || "Emergencia inmediata";
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
        if (incident.detalle) {
            summary.textContent += ` · ${incident.detalle}`;
        }
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
        title.textContent = `${Number(incident.reportes) > 1 ? "Incidente Grupal · " : ""}${incident.tipo || "Alerta"}${Number(incident.reportes) > 1 ? ` · ${incident.reportes} reportes` : ""}`;
        identity.append(icon, title);
        const state = document.createElement("span");
        state.className = "seguridad-alert-state";
        state.textContent = incident.estado;
        heading.append(identity, state);
        const summary = document.createElement("p");
        summary.textContent =
            `${incident.detalle || "Sin detalle adicional"} · ${getIncidentLocationLabel(incident)}`;
        select.append(heading, summary);
        const actions = document.createElement("div");
        actions.className = "seguridad-card-actions";
        if (incident.estado === "Derivada a Central") {
            const dispatchButton = makeButton("dispatch", "EN CAMINO");
            const dispatchStatus = getDispatchEligibility();
            dispatchButton.disabled = !dispatchStatus.allowed;
            dispatchButton.title = dispatchButton.disabled
                ? dispatchStatus.message
                : "Despachar la unidad asignada a esta alerta.";
            actions.append(dispatchButton);
        } else if (incident.estado === "Auxilio en camino") {
            const arrivalButton = makeButton("onsite", "Marcar llegada");
            const arrival = getArrivalEligibility(incident);
            arrivalButton.disabled = !arrival.allowed;
            arrivalButton.title = arrival.message;
            actions.append(arrivalButton);
        } else if (incident.estado === "Agentes en sitio") {
            const outcome = document.createElement("select");
            outcome.dataset.outcomeFor = String(incident.id);
            outcome.setAttribute("aria-label", "Resultado del incidente");
            [
                ["Delincuente retenido", "Delincuente retenido"],
                ["Falsa alarma", "Falsa alarma"],
                ["Intervención preventiva", "Intervención preventiva"]
            ].forEach(([value, label]) => outcome.add(new Option(label, value)));
            actions.append(outcome, makeButton("close", "Finalizar / Incidente Atendido"));
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
            let incident = displayedIncidents.find((item) => String(item.id) === incidentId);
            if (!incident) throw new Error("No se encontró el incidente seleccionado.");
            if (!hasCoordinates(incident)) {
                incident = await recoverIncidentCoordinates(incident);
                incidentCoordinatesCache.set(incidentId, {
                    latitud: Number(incident.latitud),
                    longitud: Number(incident.longitud)
                });
                render();
            }
            if (button.dataset.action === "dispatch") {
                const dispatchStatus = getDispatchEligibility();
                if (!dispatchStatus.allowed) throw new Error(dispatchStatus.message);
            }
            if (button.dataset.action === "onsite") {
                const arrival = getArrivalEligibility(incident);
                if (!arrival.allowed) throw new Error(arrival.message);
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
            if (button.dataset.action === "dispatch") {
                try {
                    await showRoute(incident);
                } catch (routeError) {
                    console.error("El despacho se registró, pero no se pudo calcular la ruta:", routeError);
                    window.alert(`Despacho registrado, pero no se pudo trazar la ruta: ${routeError.message}`);
                }
            }
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
        const unitLocation = getCurrentUnitLocation();
        if (unitLocation) {
            L.marker([Number(unitLocation.latitud), Number(unitLocation.longitud)], {
                icon: L.divIcon({ className: "seguridad-patrol-marker", html: "●", iconSize: [20, 20] })
            }).bindPopup("Ubicación de la unidad").addTo(patrolLayer);
            bounds.push([Number(unitLocation.latitud), Number(unitLocation.longitud)]);
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
        const origin = getCurrentUnitLocation();
        const approximateAddress = typeof incident.direccion === "string" && incident.direccion.trim()
            ? incident.direccion.trim()
            : typeof incident.direccionAproximada === "string" &&
            incident.direccionAproximada.trim()
            ? incident.direccionAproximada.trim()
            : typeof incident.ubicacion === "string" && incident.ubicacion.trim()
                ? incident.ubicacion.trim()
                : hasCoordinates(incident)
                    ? `Referencia GPS aproximada: ${Number(incident.latitud).toFixed(5)}, ${Number(incident.longitud).toFixed(5)}`
                    : "Dirección aproximada no disponible";
        const distance = origin && validPoint(origin) && hasCoordinates(incident)
            ? `${Math.round(data.distanceMeters(origin, {
                latitud: Number(incident.latitud),
                longitud: Number(incident.longitud)
            }))} m`
            : "No disponible";
        selectedDetails.textContent =
            `Tipo de evento: ${incident.tipo || "Alerta"} · Estado: ${incident.estado} · ` +
            `Dirección aproximada: ${approximateAddress} · Distancia actual: ${distance}`;
    }

    async function showRoute(incident) {
        if (!hasCoordinates(incident) || !map) throw new Error("La alerta no tiene coordenadas válidas.");
        const profile = data.getProfile();
        const patrolId = profile.patrullaId;
        const now = Date.now();
        const localPoint = latestLocationPoint || securityLocation;
        const localPointIsFresh = localPoint && validPoint(localPoint) &&
            Number.isFinite(localPoint.receivedAt) && now - localPoint.receivedAt <= 30 * 1000;
        let origin = localPointIsFresh
            ? {
                latitud: Number(localPoint.latitud),
                longitud: Number(localPoint.longitud),
                codigo: "Tu ubicación"
            }
            : null;
        if (!origin && patrolId) {
            const patrol = data.getPatrols().find((item) => item.id === patrolId);
            const updatedAt = getTimestampMillis(patrol && patrol.updatedAt);
            if (patrol && validPoint(patrol) && Number.isFinite(updatedAt) &&
                updatedAt <= now && now - updatedAt <= 2 * 60 * 1000) {
                origin = patrol;
            }
        }
        if (!origin && data.getRole() === "seguridad" && profile.comunidadId) {
            const member = data.getCommunityMembers().find((item) => item.id === profile.uid);
            const updatedAt = new Date(member && member.ubicacionActualizadaAt || 0).getTime();
            if (member && member.ubicacionCompartida === true &&
                updatedAt <= now && now - updatedAt <= 2 * 60 * 1000 && validPoint(member)) {
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
        const navigationUrl = new URL("https://www.google.com/maps/dir/");
        navigationUrl.searchParams.set("api", "1");
        navigationUrl.searchParams.set("origin", `${origin.latitud},${origin.longitud}`);
        navigationUrl.searchParams.set("destination", `${incident.latitud},${incident.longitud}`);
        navigationUrl.searchParams.set("travelmode", "driving");
        navigationUrl.searchParams.set("dir_action", "navigate");
        navigationUrl.searchParams.set("traffic", "1");
        const navigationLink = document.createElement("a");
        navigationLink.href = navigationUrl.toString();
        navigationLink.target = "_blank";
        navigationLink.rel = "noopener noreferrer";
        navigationLink.className = "seguridad-google-maps-link";
        navigationLink.textContent = "Abrir navegación en Google Maps ↗";
        routeLayer.clearLayers();
        map.fitBounds(L.latLngBounds(
            [Number(origin.latitud), Number(origin.longitud)],
            [Number(incident.latitud), Number(incident.longitud)]
        ), { padding: [30, 30] });
        routeStatus.replaceChildren(
            document.createTextNode(
                `Google Maps calculará la ruta vial desde ${origin.codigo || origin.codigoPatrulla || "la unidad"}. `
            ),
            navigationLink
        );
    }

    function getCurrentUnitLocation() {
        const now = Date.now();
        const localPoint = latestLocationPoint || securityLocation;
        if (localPoint && validPoint(localPoint) &&
            Number.isFinite(localPoint.receivedAt) &&
            localPoint.receivedAt <= now && now - localPoint.receivedAt <= 30 * 1000) {
            return localPoint;
        }

        const profile = data.getProfile() || {};
        if (profile.patrullaId) {
            const patrol = data.getPatrols().find((item) =>
                String(item.id) === String(profile.patrullaId)
            );
            const updatedAt = getTimestampMillis(patrol && patrol.updatedAt);
            if (patrol && validPoint(patrol) && Number.isFinite(updatedAt) &&
                updatedAt <= now && now - updatedAt <= 2 * 60 * 1000) {
                return patrol;
            }
        }

        if (data.getRole() === "seguridad" && profile.comunidadId) {
            const member = data.getCommunityMembers().find((item) => item.id === profile.uid);
            const updatedAt = getTimestampMillis(member && member.ubicacionActualizadaAt);
            if (member && member.ubicacionCompartida === true && validPoint(member) &&
                Number.isFinite(updatedAt) && updatedAt <= now &&
                now - updatedAt <= 2 * 60 * 1000) {
                return member;
            }
        }
        return null;
    }

    function getArrivalEligibility(incident) {
        if (!hasCoordinates(incident)) {
            return {
                allowed: false,
                message: "No se cargaron las coordenadas del incidente. Actualiza la lista para recuperarlas."
            };
        }
        const now = Date.now();
        const profile = data.getProfile() || {};
        const patrolId = String(incident.patrullaId || profile.patrullaId || "");
        const patrol = data.getPatrols().find((item) => String(item.id) === patrolId);
        const localPointIsFresh = latestLocationPoint &&
            validPoint(latestLocationPoint) &&
            Number.isFinite(latestLocationPoint.receivedAt) &&
            now - latestLocationPoint.receivedAt >= -10000 &&
            now - latestLocationPoint.receivedAt <= 2 * 60 * 1000;
        const patrolUpdatedAt = getTimestampMillis(patrol && patrol.updatedAt);
        const patrolPointIsFresh = patrol && patrol.estado === "Despachado" &&
            String(patrol.incidenteId || "") === String(incident.id) &&
            validPoint(patrol) &&
            (Number.isFinite(patrolUpdatedAt) &&
                now - patrolUpdatedAt >= -10000 &&
                now - patrolUpdatedAt <= 2 * 60 * 1000 ||
                patrol._hasPendingWrites === true && !Number.isFinite(patrolUpdatedAt));
        const point = localPointIsFresh
            ? latestLocationPoint
            : patrolPointIsFresh
                ? {
                    latitud: Number(patrol.latitud),
                    longitud: Number(patrol.longitud),
                    precisionMetros: Number(patrol.precisionMetros),
                    receivedAt: Number.isFinite(patrolUpdatedAt) ? patrolUpdatedAt : now
                }
                : null;
        if (!point || !validPoint(point) || !Number.isFinite(Number(point.precisionMetros)) ||
            Number(point.precisionMetros) <= 0 ||
            Number(point.precisionMetros) > 50000 ||
            !Number.isFinite(point.receivedAt) || now - point.receivedAt < -10000 ||
            now - point.receivedAt > 2 * 60 * 1000) {
            return {
                allowed: false,
                message: "No hay una ubicación GPS reciente válida de la unidad. Activa el GPS y vuelve a intentarlo."
            };
        }
        const distance = data.distanceMeters(point, incident);
        if (distance > 15) {
            return {
                allowed: false,
                message: `Acércate a 15 m o menos del emisor para marcar llegada (distancia actual: ${Math.round(distance)} m).`
            };
        }
        return { allowed: true, message: "Unidad a 15 m o menos del emisor." };
    }

    function startLocationSharing() {
        if (!navigator.geolocation) {
            locationStatus.textContent = "Este navegador no permite compartir ubicación GPS.";
            return;
        }
        if (watchId !== null) return;
        watchId = navigator.geolocation.watchPosition((position) => {
            latestLocationPoint = {
                latitud: position.coords.latitude,
                longitud: position.coords.longitude,
                precisionMetros: Math.max(1, position.coords.accuracy),
                receivedAt: Date.now()
            };
            securityLocation = latestLocationPoint;
            render();
            if (!locationSyncInProgress) void syncLatestLocation();
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

    async function syncLatestLocation() {
        if (watchId === null || !latestLocationPoint || locationSyncInProgress) return;
        locationSyncInProgress = true;
        let stage = "actualizar la ubicación de serenazgo";
        try {
            const point = latestLocationPoint;
            const profile = data.getProfile();
            if (!profile) throw new Error("No se encontró el perfil de seguridad para sincronizar la ubicación.");
            let memberLocationError = null;
            if (data.getRole() === "seguridad" && profile.comunidadId) {
                try {
                    await data.updateSecurityLocation(point);
                } catch (memberError) {
                    memberLocationError = memberError;
                    console.error("No se pudo publicar la ubicación de serenazgo en el mapa:", memberError);
                }
            }
            if (profile.patrullaId) {
                stage = "actualizar la ubicación de la unidad y habilitar el despacho";
                await data.updatePatrolLocation(point);
            }
            if (memberLocationError && !profile.patrullaId) throw memberLocationError;
            lastLocation = point;
            locationStatus.textContent =
                `Ubicación actualizada · precisión ±${Math.round(point.precisionMetros)} m · ` +
                `${point.latitud.toFixed(5)}, ${point.longitud.toFixed(5)}.`;
            render();
        } catch (error) {
            console.error(`No se pudo ${stage}:`, error);
            locationStatus.textContent = `${stage}: ${error.message || "permiso denegado por Firestore."}`;
        } finally {
            locationSyncInProgress = false;
            if (watchId !== null && latestLocationPoint && locationSyncTimer === null) {
                locationSyncTimer = window.setTimeout(() => {
                    locationSyncTimer = null;
                    void syncLatestLocation();
                }, 5000);
            }
        }
    }

    async function stopLocationSharing(clearRemote = true) {
        if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        if (locationSyncTimer !== null) {
            window.clearTimeout(locationSyncTimer);
            locationSyncTimer = null;
        }
        latestLocationPoint = null;
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

    function stopOpenAlertsListener() {
        if (stopWatchingOpenAlerts) stopWatchingOpenAlerts();
        stopWatchingOpenAlerts = null;
    }

    function hasCoordinates(incident) {
        return validPoint(incident);
    }

    function getIncidentLocationLabel(incident) {
        if (typeof incident.direccion === "string" && incident.direccion.trim()) {
            return incident.direccion.trim();
        }
        if (typeof incident.ubicacion === "string" && incident.ubicacion.trim()) {
            return incident.ubicacion.trim();
        }
        if (hasCoordinates(incident)) {
            return `Referencia GPS: ${Number(incident.latitud).toFixed(5)}, ${Number(incident.longitud).toFixed(5)}`;
        }
        return "Ubicación no disponible";
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
        const now = Date.now();
        const localTimestamp = latestLocationPoint && latestLocationPoint.receivedAt;
        const localLocationIsFresh = latestLocationPoint && validPoint(latestLocationPoint) &&
            Number.isFinite(localTimestamp) && now - localTimestamp >= -10000 &&
            now - localTimestamp < 2 * 60 * 1000;
        const patrol = data.getPatrols().find((item) =>
            String(item.id) === String(profile.patrullaId)
        );
        const patrolTimestamp = getTimestampMillis(patrol && patrol.updatedAt);
        const patrolLocationIsFresh = patrol && validPoint(patrol) &&
            (Number.isFinite(patrolTimestamp) && now - patrolTimestamp >= -10000 &&
                now - patrolTimestamp < 2 * 60 * 1000 ||
                patrol._hasPendingWrites === true && !Number.isFinite(patrolTimestamp));
        if (!localLocationIsFresh && !patrolLocationIsFresh) {
            return {
                allowed: false,
                message: "No hay GPS reciente. Pulsa «Activar GPS para habilitar despacho» y permite el acceso a la ubicación."
            };
        }
        return {
            allowed: true,
            message: "",
            timestamp: localLocationIsFresh
                ? localTimestamp
                : Number.isFinite(patrolTimestamp) ? patrolTimestamp : now
        };
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
            const timestamp = status.timestamp;
            const remaining = Math.max(0, 2 * 60 * 1000 - (Date.now() - timestamp));
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
