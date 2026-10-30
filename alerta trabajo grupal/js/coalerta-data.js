import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getDocsFromServer,
    limit,
    onSnapshot,
    orderBy,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    updateDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

/* =========================================================
   COALERTA - SERVICIOS FIREBASE
========================================================= */
(function () {
    const ADMIN_EMAIL = "mailig.lebam@gmail.com";
    const DEFAULT_COMMUNITY_ID = "comunidad_general_1";
    const activeStates = new Set([
        "Recibido en servidor",
        "En revisión",
        "Derivada a Central",
        "Auxilio en camino",
        "Agentes en sitio"
    ]);
    const state = {
        uid: null,
        profile: null,
        registrationIncomplete: false,
        role: "vecino",
        ready: false,
        initializing: false,
        publicAlerts: [],
        incidents: [],
        ownIncidents: [],
        ownAlerts: [],
        readAlerts: [],
        readNotices: [],
        notices: [],
        audit: [],
        patrols: [],
        communityMembers: [],
        zone: null,
        delegation: null,
        listeners: []
    };

    function normalizeCategory(value) {
        const category = String(value || "").normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "").toLowerCase();
        if (category.includes("robo")) return "robo";
        if (category.includes("sospech")) return "sospecha";
        if (category.includes("accidente")) return "accidente";
        if (category.includes("incendio")) return "incendio";
        return category;
    }

    function distanceMeters(first, second) {
        if (![first.latitud, first.longitud, second.latitud, second.longitud].every(Number.isFinite)) {
            return Infinity;
        }
        const radians = (degrees) => degrees * Math.PI / 180;
        const latitudeDelta = radians(second.latitud - first.latitud);
        const longitudeDelta = radians(second.longitud - first.longitud);
        const a = Math.sin(latitudeDelta / 2) ** 2 +
            Math.cos(radians(first.latitud)) * Math.cos(radians(second.latitud)) *
            Math.sin(longitudeDelta / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function timestampToIso(value) {
        if (value && typeof value.toDate === "function") return value.toDate().toISOString();
        if (value instanceof Date) return value.toISOString();
        return value || null;
    }

    function normalizeDocument(document) {
        const data = document.data();
        Object.keys(data).forEach((key) => {
            if (data[key] && typeof data[key].toDate === "function") data[key] = timestampToIso(data[key]);
        });
        return { ...data, id: document.id };
    }

    function dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function stopListeners() {
        state.listeners.forEach((unsubscribe) => unsubscribe());
        state.listeners = [];
    }

    function reportListenerError(area, error) {
        console.error(`No se pudo sincronizar ${area} desde Firebase:`, error);
        dispatch("coalerta:error", { area, message: error.message || "Error de sincronización." });
    }

    function isPreferences(value) {
        return value && typeof value === "object" && !Array.isArray(value) &&
            Object.entries(value).every(([key, preference]) =>
                ["alertas", "sonido", "ubicacion", "temaOscuro"].includes(key) &&
                typeof preference === "boolean"
            );
    }

    function readLocalPreferences(uid, pending = false) {
        const key = pending
            ? `coalertaPreferenciasPendientes:${uid}`
            : `coalertaPreferencias:${uid}`;
        try {
            const value = JSON.parse(localStorage.getItem(key) || "null");
            return isPreferences(value) ? value : null;
        } catch (error) {
            console.error("No se pudieron leer las preferencias locales:", error);
            return null;
        }
    }

    async function syncPreferences(uid, profile) {
        const pending = readLocalPreferences(uid, true);
        const remote = isPreferences(profile.preferencias) && Object.keys(profile.preferencias).length
            ? profile.preferencias
            : null;
        const local = readLocalPreferences(uid);
        const preferences = pending || remote || local || {};

        profile.preferencias = preferences;
        dispatch("coalerta:preferencias-cargadas", preferences);

        if (pending || (!remote && local && Object.keys(local).length)) {
            try {
                await setDoc(doc(db, "usuarios", uid), { preferencias }, { merge: true });
                localStorage.removeItem(`coalertaPreferenciasPendientes:${uid}`);
            } catch (error) {
                reportListenerError("preferencias de cuenta", error);
            }
        } else if (remote) {
            try {
                localStorage.setItem(`coalertaPreferencias:${uid}`, JSON.stringify(remote));
            } catch (error) {
                console.error("No se pudo actualizar la copia local de preferencias:", error);
            }
        }

        return preferences;
    }

    function watch(query, property, eventName, area) {
        const unsubscribe = onSnapshot(query, (snapshot) => {
            state[property] = snapshot.docs.map(normalizeDocument);
            dispatch(eventName, state[property]);
        }, (error) => reportListenerError(area, error));
        state.listeners.push(unsubscribe);
    }

    function watchCommunityMembers(communityId) {
        watch(
            collection(doc(db, "comunidades", communityId), "miembros"),
            "communityMembers",
            "coalerta:miembros-actualizados",
            "miembros de comunidad"
        );
    }

    function resetData() {
        stopListeners();
        state.uid = null;
        state.profile = null;
        state.registrationIncomplete = false;
        state.role = "vecino";
        state.ready = false;
        state.initializing = false;
        state.publicAlerts = [];
        state.incidents = [];
        state.ownIncidents = [];
        state.ownAlerts = [];
        state.readAlerts = [];
        state.readNotices = [];
        state.notices = [];
        state.audit = [];
        state.patrols = [];
        state.communityMembers = [];
        state.zone = null;
        state.delegation = null;
    }

    function startForUser(user) {
        resetData();
        const cachedProfile = user ? getCachedProfile(user) : null;
        updateRoleNavigation(user, cachedProfile && cachedProfile.rol, false);
        dispatch("coalerta:perfil-cargando", { user });
        if (!user) {
            updateRoleNavigation(null, null, true);
            dispatch("coalerta:sesion-cambiada", { user: null });
            return;
        }
        state.uid = user.uid;
        state.initializing = true;
        getDoc(doc(db, "usuarios", user.uid)).then(async (document) => {
            if (state.uid !== user.uid) return;
            if (!document.exists()) {
                state.registrationIncomplete = true;
                updateRoleNavigation(user, null, true);
                dispatch("coalerta:sesion-cambiada", {
                    user,
                    profile: null,
                    registrationIncomplete: true
                });
                dispatch("coalerta:registro-incompleto", { uid: user.uid, email: user.email || "" });
                return;
            }
            const profile = document.data();
            if (profile.activo !== true) throw new Error("La cuenta todavía no está activa.");
            try {
                const cachedProfile = JSON.parse(localStorage.getItem("coalerta_usuario") || "{}");
                if (cachedProfile.uid === user.uid ||
                    (!cachedProfile.uid && (cachedProfile.correo || cachedProfile.email) === user.email)) {
                    ["fotoBase64", "fotoURL", "photoURL"].forEach((field) => {
                        if (!profile[field] && cachedProfile[field]) profile[field] = cachedProfile[field];
                    });
                }
            } catch (error) {
                console.error("No se pudo recuperar la foto de perfil guardada localmente:", error);
            }
            state.profile = { ...profile, uid: user.uid };
            state.role = String(profile.rol || "vecino").trim().toLowerCase();
            state.profile.rol = state.role;
            updateRoleNavigation(user, state.role, true);
            syncPreferences(user.uid, profile).catch((error) =>
                reportListenerError("preferencias de cuenta", error)
            );
            state.profile.preferencias = profile.preferencias;
            state.ready = true;
            watch(
                query(collection(db, "alertas_publicas"), orderBy("timestamp", "desc"), limit(200)),
                "publicAlerts",
                "coalerta:alertas-actualizadas",
                "alertas públicas"
            );
            watch(
                query(collection(doc(db, "usuarios", user.uid), "alertas"),
                    orderBy("timestamp", "desc"), limit(50)),
                "ownAlerts",
                "coalerta:mis-alertas-actualizadas",
                "tus alertas"
            );
            watch(
                query(collection(db, "incidentes"),
                    where("reporterUids", "array-contains", user.uid),
                    orderBy("timestamp", "desc"), limit(50)),
                "ownIncidents",
                "coalerta:mis-alertas-actualizadas",
                "tus alertas"
            );
            watch(
                query(collection(doc(db, "usuarios", user.uid), "alertas_leidas"),
                    orderBy("readAt", "desc"), limit(500)),
                "readAlerts",
                "coalerta:lecturas-actualizadas",
                "lecturas de alertas"
            );
            watch(
                query(collection(doc(db, "usuarios", user.uid), "avisos_leidos"),
                    orderBy("readAt", "desc"), limit(500)),
                "readNotices",
                "coalerta:avisos-leidos-actualizados",
                "lecturas de avisos"
            );
            watch(
                query(collection(db, "avisos_publicos"),
                    where("comunidadId", "==", profile.comunidadId || null), limit(100)),
                "notices",
                "coalerta:avisos-actualizados",
                "comunicados"
            );
            const role = state.role;
            if (["coordinador", "agente", "seguridad", "administrador", "admin"].includes(role)) {
                watch(
                    query(collection(db, "incidentes"), orderBy("timestamp", "desc"), limit(200)),
                    "incidents",
                    "coalerta:incidentes-actualizados",
                    "incidentes operativos"
                );
                watch(
                    query(collection(db, "auditoria"), orderBy("createdAt", "desc"), limit(100)),
                    "audit",
                    "coalerta:auditoria-actualizada",
                    "bitácora"
                );
                watch(
                    query(collection(db, "patrullas"), limit(100)),
                    "patrols",
                    "coalerta:patrullas-actualizadas",
                    "patrullas"
                );
            }

            if (profile.comunidadId) {
                watchCommunityMembers(profile.comunidadId);
                const zoneUnsubscribe = onSnapshot(doc(db, "zonas", profile.comunidadId), (snapshot) => {
                    state.zone = snapshot.exists() ? snapshot.data() : null;
                    dispatch("coalerta:zona-actualizada", state.zone);
                }, (error) => reportListenerError("perímetro", error));
                state.listeners.push(zoneUnsubscribe);
                const delegationUnsubscribe = onSnapshot(doc(db, "delegaciones", profile.comunidadId), (snapshot) => {
                    state.delegation = snapshot.exists() ? normalizeDocument(snapshot) : null;
                    dispatch("coalerta:delegacion-actualizada", state.delegation);
                }, (error) => reportListenerError("delegación", error));
                state.listeners.push(delegationUnsubscribe);
                synchronizeOwnIncidentsToCommunity(user.uid, profile.comunidadId)
                    .catch((error) => reportListenerError("incidentes operativos", error));
                if (["vecino", "seguridad"].includes(state.role)) {
                    synchronizeCommunityMemberProfile(user.uid, profile.comunidadId, profile)
                        .catch((error) => reportListenerError("contacto de la comunidad", error));
                }
            }
            dispatch("coalerta:datos-listos", { profile: state.profile, uid: user.uid });
            dispatch("coalerta:sesion-cambiada", { user, profile: state.profile });
        }).catch((error) => {
            console.error("No se pudo iniciar la sincronización de CoAlerta:", error);
            if (state.uid === user.uid) {
                state.uid = null;
                state.profile = null;
                state.ready = false;
                updateRoleNavigation(null, null, true);
            }
            dispatch("coalerta:error", { area: "perfil", message: error.message });
        }).finally(() => {
            if (state.uid === user.uid) state.initializing = false;
        });
    }

    function getCachedProfile(user) {
        try {
            const profile = JSON.parse(localStorage.getItem("coalerta_usuario") || "null");
            if (!profile || typeof profile !== "object") return null;
            const matchesUid = profile.uid === user.uid;
            const cachedEmail = String(profile.correo || profile.email || "").toLowerCase();
            const matchesEmail = !profile.uid && cachedEmail &&
                cachedEmail === String(user.email || "").toLowerCase();
            return matchesUid || matchesEmail ? profile : null;
        } catch (error) {
            console.error("No se pudo recuperar el rol guardado localmente:", error);
            return null;
        }
    }

    function updateRoleNavigation(user, role, ready) {
        const normalizedRole = String(role || "").trim().toLowerCase();
        const shouldFilterByRole = ready || Boolean(normalizedRole);
        const isAdmin = Boolean(user) &&
            String(user.email || "").toLowerCase() === ADMIN_EMAIL;
        const isCoordinator = Boolean(user) &&
            ["coordinador", "administrador", "admin"].includes(normalizedRole);
        const isSecurity = Boolean(user) &&
            ["agente", "seguridad", "administrador", "admin"].includes(normalizedRole);
        document.querySelectorAll("[data-admin-only]").forEach((link) => {
            if (shouldFilterByRole) link.hidden = !isAdmin;
            else link.hidden = false;
        });
        document.querySelectorAll('[data-role-link="coordinator"]').forEach((link) => {
            if (shouldFilterByRole) link.hidden = !isCoordinator;
            else link.hidden = false;
        });
        document.querySelectorAll('[data-role-link="security"]').forEach((link) => {
            if (shouldFilterByRole) link.hidden = !isSecurity;
            else link.hidden = false;
        });
        document.body.dataset.roleNavigationReady = String(ready);
    }

    function requireActiveProfile() {
        const user = auth.currentUser;
        if (!user || !state.ready || state.uid !== user.uid ||
            !state.profile || state.profile.activo !== true) {
            throw new Error("Inicia sesión con una cuenta activa para continuar.");
        }
        return { user, profile: state.profile };
    }

    function requireRole(roles) {
        const session = requireActiveProfile();
        if (!roles.includes(state.role)) {
            throw new Error("Tu rol no permite realizar esta acción.");
        }
        return session;
    }

    async function refreshCurrentProfile() {
        const { user } = requireActiveProfile();
        const snapshot = await getDoc(doc(db, "usuarios", user.uid));
        if (!snapshot.exists() || snapshot.get("activo") !== true) {
            throw new Error("No se pudo confirmar el perfil activo para sincronizar el GPS.");
        }
        state.profile = { ...snapshot.data(), uid: user.uid };
        state.role = String(state.profile.rol || "vecino").trim().toLowerCase();
        state.profile.rol = state.role;
        updateRoleNavigation(user, state.role, true);
        return state.profile;
    }

    function validatePoint(point) {
        const latitud = Number(point && point.latitud);
        const longitud = Number(point && point.longitud);
        const precisionMetros = Number(point && point.precisionMetros);
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) {
            throw new TypeError("La ubicación GPS no es válida.");
        }
        if (!Number.isFinite(precisionMetros) || precisionMetros <= 0 ||
            precisionMetros > 100000) {
            throw new TypeError("La precisión GPS informada no es válida.");
        }
        return { latitud, longitud, precisionMetros };
    }

    function makePublicAlert(incident) {
        return {
            tipo: incident.tipo,
            categoria: incident.categoria,
            latitud: Number(Number(incident.latitud).toFixed(3)),
            longitud: Number(Number(incident.longitud).toFixed(3)),
            timestamp: incident.timestamp,
            estado: incident.estado,
            prioridad: incident.prioridad,
            reportes: incident.reportes,
            ultimaActualizacion: incident.ultimaActualizacion,
            comunidadId: incident.comunidadId || null
        };
    }

    function waitForReady(timeoutMs = 15000) {
            if (state.ready && auth.currentUser && auth.currentUser.uid === state.uid) {
                return Promise.resolve(state.profile);
            }
            const user = typeof auth !== "undefined" ? auth.currentUser : null;
            if (!user) return Promise.reject(new Error("Inicia sesión para enviar una alerta."));
            if (state.registrationIncomplete) {
                return Promise.reject(new Error("Completa el registro de tu cuenta antes de enviar una alerta."));
            }

            return new Promise((resolve, reject) => {
                let timeout;
                const cleanup = () => {
                    window.removeEventListener("coalerta:datos-listos", onReady);
                    window.removeEventListener("coalerta:registro-incompleto", onIncomplete);
                    window.removeEventListener("coalerta:error", onError);
                    window.clearTimeout(timeout);
                };
                const onReady = (event) => {
                    if (!event.detail || event.detail.uid !== user.uid) return;
                    cleanup();
                    resolve(state.profile);
                };
                const onIncomplete = (event) => {
                    if (!event.detail || event.detail.uid !== user.uid) return;
                    cleanup();
                    reject(new Error("Completa el registro de tu cuenta antes de enviar una alerta."));
                };
                const onError = (event) => {
                    if (!event.detail || event.detail.area !== "perfil") return;
                    cleanup();
                    reject(new Error(event.detail.message || "No se pudo sincronizar tu cuenta con Firebase."));
                };
                window.addEventListener("coalerta:datos-listos", onReady);
                window.addEventListener("coalerta:registro-incompleto", onIncomplete);
                window.addEventListener("coalerta:error", onError);
                timeout = window.setTimeout(() => {
                    cleanup();
                    reject(new Error("Firebase tardó demasiado en cargar tu perfil. Comprueba tu conexión e inténtalo otra vez."));
                }, timeoutMs);

                if (state.ready && state.uid === user.uid) {
                    cleanup();
                    resolve(state.profile);
                } else if (state.uid !== user.uid || !state.initializing) {
                    startForUser(user);
                }
            });
    }

    function getAlerts() {
        const alerts = new Map(state.publicAlerts.map((alert) => [alert.id, alert]));
        const readIds = new Set(state.readAlerts.map((alert) => alert.alertaId || alert.id));
        alerts.forEach((alert, id) => {
            alerts.set(id, { ...alert, leida: readIds.has(id) });
        });
        getMyAlerts().forEach((alert) => {
            const id = alert.alertaId || alert.id;
            const publicAlert = alerts.get(id);
            if (publicAlert) {
                alerts.set(id, {
                    ...alert,
                    ...publicAlert,
                    unidad: alert.unidad || null,
                    vehiculo: alert.vehiculo || null,
                    etaMinutos: alert.etaMinutos || null,
                    motivoDescarte: alert.motivoDescarte || null,
                    emisorUid: alert.emisorUid,
                    calificacion: alert.calificacion || null,
                    calificacionOmitida: alert.calificacionOmitida || false
                });
            }
        });
        return Array.from(alerts.values());
    }

    async function refreshAlerts() {
        const user = auth.currentUser;
        if (!user || !state.ready || state.uid !== user.uid) {
            throw new Error("Inicia sesión para actualizar las alertas.");
        }
        const [publicSnapshot, ownSnapshot] = await Promise.all([
            getDocsFromServer(query(
                collection(db, "alertas_publicas"),
                orderBy("timestamp", "desc"),
                limit(200)
            )),
            getDocsFromServer(query(
                collection(doc(db, "usuarios", user.uid), "alertas"),
                orderBy("timestamp", "desc"),
                limit(50)
            ))
        ]);
        if (state.uid !== user.uid) return;
        state.publicAlerts = publicSnapshot.docs.map(normalizeDocument);
        state.ownAlerts = ownSnapshot.docs.map(normalizeDocument);
        dispatch("coalerta:alertas-actualizadas", state.publicAlerts);
        dispatch("coalerta:mis-alertas-actualizadas", state.ownAlerts);
    }

    async function markAlertRead(alertaId) {
        const user = auth.currentUser;
        const id = String(alertaId || "");
        if (!user || !state.ready || state.uid !== user.uid || !id) {
            throw new Error("Inicia sesión para guardar el estado de lectura de la alerta.");
        }
        const readRef = doc(db, "usuarios", user.uid, "alertas_leidas", id);
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(readRef);
            if (!snapshot.exists()) {
                transaction.set(readRef, { alertaId: id, readAt: serverTimestamp() });
            }
        });
        if (!state.readAlerts.some((alert) => String(alert.alertaId || alert.id) === id)) {
            state.readAlerts.push({ id, alertaId: id, leida: true, readAt: new Date().toISOString() });
            dispatch("coalerta:lecturas-actualizadas", state.readAlerts);
        }
    }

    async function markNoticeRead(noticeId) {
        const user = auth.currentUser;
        const id = String(noticeId || "");
        if (!user || !state.ready || state.uid !== user.uid || !id) {
            throw new Error("Inicia sesión para guardar el estado de lectura del aviso.");
        }
        const readRef = doc(db, "usuarios", user.uid, "avisos_leidos", id);
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(readRef);
            if (!snapshot.exists()) {
                transaction.set(readRef, { avisoId: id, readAt: serverTimestamp() });
            }
        });
        if (!state.readNotices.some((notice) => String(notice.avisoId || notice.id) === id)) {
            state.readNotices.push({ id, avisoId: id, leido: true, readAt: new Date().toISOString() });
            dispatch("coalerta:avisos-leidos-actualizados", state.readNotices);
        }
    }

    function getIncidents() {
        return state.incidents;
    }

    function getMyAlerts() {
        const incidentsById = new Map(state.ownIncidents.map((incident) => [incident.id, incident]));
        const publicAlertsById = new Map(state.publicAlerts.map((alert) => [alert.id, alert]));
        return state.ownAlerts.map((alert) => {
            const id = alert.alertaId || alert.id;
            const incident = incidentsById.get(id);
            const publicAlert = publicAlertsById.get(id);
            const incidentUpdatedAt = Date.parse(incident && incident.ultimaActualizacion || "") || 0;
            const publicUpdatedAt = Date.parse(publicAlert && publicAlert.ultimaActualizacion || "") || 0;
            const latestState = publicUpdatedAt > incidentUpdatedAt ? publicAlert : incident || publicAlert;
            return {
                ...alert,
                ...(publicAlert ? {
                    estado: publicAlert.estado,
                    ultimaActualizacion: publicAlert.ultimaActualizacion || alert.ultimaActualizacion
                } : {}),
                ...(incident ? {
                    estado: incident.estado,
                    unidad: incident.unidad || null,
                    vehiculo: incident.vehiculo || null,
                    etaMinutos: incident.etaMinutos || null,
                    motivoDescarte: incident.motivoDescarte || null,
                    resultado: incident.resultado || null,
                    derivadaAt: incident.derivadaAt || null,
                    enSitioAt: incident.enSitioAt || null,
                    closedAt: incident.closedAt || null,
                    ultimaActualizacion: incident.ultimaActualizacion || alert.ultimaActualizacion
                } : {}),
                ...(latestState ? {
                    estado: latestState.estado || alert.estado,
                    ultimaActualizacion: latestState.ultimaActualizacion || alert.ultimaActualizacion
                } : {}),
                id
            };
        });
    }

    async function savePreferences(preferences) {
        const user = typeof auth !== "undefined" ? auth.currentUser : null;
        if (!user || (state.uid && user.uid !== state.uid)) {
            throw new Error("Inicia sesión para guardar tus preferencias.");
        }
        if (!isPreferences(preferences)) {
            throw new TypeError("Las preferencias tienen un formato no válido.");
        }
        localStorage.setItem(`coalertaPreferencias:${user.uid}`, JSON.stringify(preferences));
        localStorage.setItem(`coalertaPreferenciasPendientes:${user.uid}`, JSON.stringify(preferences));
        await setDoc(doc(db, "usuarios", user.uid), { preferencias }, { merge: true });
        localStorage.removeItem(`coalertaPreferenciasPendientes:${user.uid}`);
        if (state.profile && state.uid === user.uid) {
            state.profile = { ...state.profile, preferencias };
        }
        dispatch("coalerta:preferencias-cambiadas", preferences);
        return preferences;
    }

    async function createAlert(alert) {
        const user = auth.currentUser;
        if (!user || !state.profile || state.uid !== user.uid || state.profile.activo !== true) {
            throw new Error("Inicia sesión con una cuenta activa para reportar una emergencia.");
        }
        const categoria = normalizeCategory(alert.tipo || alert.categoria);
        const categories = {
            robo: "Robo",
            sospecha: "Sospecha",
            accidente: "Accidente",
            incendio: "Incendio"
        };
        if (!categories[categoria]) throw new Error("Selecciona una categoría de alerta válida.");
        const detalle = typeof alert.detalle === "string" ? alert.detalle.trim() : "";
        const latitud = Number(alert.latitud);
        const longitud = Number(alert.longitud);
        const precisionMetros = Number(alert.precisionMetros);
        if (detalle.length > 300) throw new Error("El detalle no puede superar 300 caracteres.");
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) {
            throw new Error("La ubicación GPS no es válida.");
        }
        if (!Number.isFinite(precisionMetros) || precisionMetros <= 0 || precisionMetros > 100000) {
            throw new Error("La precisión GPS informada no es válida.");
        }

        const coordinatorNeedsCommunity = state.role === "coordinador" && !state.profile.comunidadId;
        const communityId = state.role === "coordinador"
            ? await ensureCoordinatorCommunity(user, state.profile)
            : state.profile.comunidadId || null;
        if (coordinatorNeedsCommunity) {
            await synchronizeOwnIncidentsToCommunity(user.uid, communityId);
        }
        const incidentRef = doc(collection(db, "incidentes"));
        const publicRef = doc(db, "alertas_publicas", incidentRef.id);
        const ownAlertRef = doc(db, "usuarios", user.uid, "alertas", incidentRef.id);
        const throttleRef = doc(db, "usuarios", user.uid, "limites", "reportes_emergencia");
        const reportTimestamp = serverTimestamp();
        const tipo = categories[categoria];
        const prioridad = categoria === "sospecha" ? "Media" : "Alta";
        const incident = {
            id: incidentRef.id,
            tipo,
            categoria,
            detalle,
            latitud,
            longitud,
            precisionMetros,
            prioridad,
            estado: "Recibido en servidor",
            timestamp: reportTimestamp,
            reportes: 1,
            reporterUids: [user.uid],
            comunidadId: communityId,
            ultimaActualizacion: reportTimestamp
        };

        await runTransaction(db, async (transaction) => {
            const throttleSnapshot = await transaction.get(throttleRef);
            if (throttleSnapshot.exists()) {
                const lastReport = throttleSnapshot.data().ultimaAlertaAt;
                const elapsedMs = lastReport && typeof lastReport.toMillis === "function"
                    ? Date.now() - lastReport.toMillis()
                    : 0;
                const waitSeconds = Math.ceil((30000 - elapsedMs) / 1000);
                if (waitSeconds > 0) {
                    throw new Error(`Espera ${waitSeconds} segundos antes de enviar otra alerta.`);
                }
                transaction.update(throttleRef, { uid: user.uid, ultimaAlertaAt: serverTimestamp() });
            } else {
                transaction.set(throttleRef, {
                    uid: user.uid,
                    ultimaAlertaAt: serverTimestamp()
                });
            }
            transaction.set(incidentRef, incident);
            transaction.set(publicRef, {
                tipo,
                categoria,
                latitud: Number(latitud.toFixed(3)),
                longitud: Number(longitud.toFixed(3)),
                timestamp: reportTimestamp,
                estado: incident.estado,
                prioridad,
                reportes: 1,
                ultimaActualizacion: reportTimestamp,
                comunidadId: incident.comunidadId
            });
            transaction.set(ownAlertRef, {
                alertaId: incidentRef.id,
                tipo,
                categoria,
                latitud,
                longitud,
                precisionMetros,
                timestamp: reportTimestamp,
                estado: incident.estado,
                prioridad,
                unidad: null,
                vehiculo: null,
                etaMinutos: null,
                motivoDescarte: null,
                emisorUid: user.uid,
                ultimaActualizacion: reportTimestamp,
                detalle
            });
        });

        return { incidentId: incidentRef.id, agrupada: false, reportes: 1 };
    }

    async function transitionIncident(incidentId, action, payload = {}) {
        const { user, profile } = requireActiveProfile();
        const rolesByAction = {
            validate: ["coordinador"],
            discard: ["coordinador"],
            dispatch: ["agente", "seguridad", "administrador", "admin"],
            onsite: ["agente", "seguridad", "administrador", "admin"],
            close: ["agente", "seguridad", "administrador", "admin"],
            rate: ["vecino"],
            skipRating: ["vecino"]
        };
        if (!rolesByAction[action]) throw new TypeError("La acción solicitada no es válida.");
        requireRole(rolesByAction[action]);

        const id = String(incidentId || "").trim();
        if (!id || id.length > 128) throw new TypeError("El identificador del incidente no es válido.");
        const incidentRef = doc(db, "incidentes", id);
        const publicRef = doc(db, "alertas_publicas", id);
        const ratingRef = doc(db, "incidentes", id, "calificaciones", user.uid);
        const userAlertRef = doc(db, "usuarios", user.uid, "alertas", id);

        const result = await runTransaction(db, async (transaction) => {
            const incidentSnapshot = await transaction.get(incidentRef);
            if (!incidentSnapshot.exists()) throw new Error("No se encontró el incidente.");
            const current = incidentSnapshot.data();
            if (state.role === "coordinador" &&
                (!profile.comunidadId || current.comunidadId !== profile.comunidadId)) {
                throw new Error("El incidente no pertenece a tu comunidad.");
            }

            if (action === "rate" || action === "skipRating") {
                if (!Array.isArray(current.reporterUids) || !current.reporterUids.includes(user.uid) ||
                    current.estado !== "Emergencia Concluida") {
                    throw new Error("Solo un emisor puede calificar un incidente cerrado.");
                }
                const ratingSnapshot = await transaction.get(ratingRef);
                if (ratingSnapshot.exists()) throw new Error("La evaluación ya fue registrada.");
                if (action === "skipRating") {
                    transaction.set(ratingRef, {
                        omitida: true,
                        createdAt: serverTimestamp()
                    });
                    transaction.update(userAlertRef, { calificacionOmitida: true });
                    return { ok: true };
                }
                const rating = Number(payload.rating);
                const comment = String(payload.comment || "");
                const allowedComments = ["Llegaron rápido", "Trato amable", "Demora en arribo"];
                if (!Number.isInteger(rating) || rating < 1 || rating > 5 ||
                    comment && !allowedComments.includes(comment)) {
                    throw new TypeError("La calificación o el comentario no son válidos.");
                }
                transaction.set(ratingRef, {
                    rating,
                    comment: comment || null,
                    createdAt: serverTimestamp()
                });
                transaction.update(userAlertRef, {
                    calificacion: rating,
                    comentarioCalificacion: comment || null
                });
                return { ok: true };
            }

            let changes;
            let patrolRef = null;
            let patrolSnapshot = null;
            if (action === "validate" && current.estado === "Recibido en servidor") {
                changes = {
                    estado: "Derivada a Central",
                    derivadaAt: serverTimestamp()
                };
            } else if (action === "discard" && activeStates.has(current.estado)) {
                const reason = String(payload.reason || "");
                if (!["Prueba de usuario", "Falsa alarma comprobada", "Duplicado"].includes(reason)) {
                    throw new TypeError("Selecciona un motivo de descarte válido.");
                }
                changes = {
                    estado: "Descartada",
                    motivoDescarte: reason,
                    closedAt: serverTimestamp(),
                    resueltoPorUid: user.uid
                };
            } else if (action === "dispatch" && current.estado === "Derivada a Central") {
                const patrolId = String(payload.patrullaId || profile.patrullaId || "").trim();
                if (!patrolId || patrolId.length > 80) {
                    throw new Error("El perfil de la unidad no tiene un identificador de patrulla asignado.");
                }
                if (!["administrador", "admin"].includes(state.role) && patrolId !== profile.patrullaId) {
                    throw new Error("Solo puedes despachar la unidad asignada a tu perfil.");
                }
                patrolRef = doc(db, "patrullas", patrolId);
                patrolSnapshot = await transaction.get(patrolRef);
                if (!patrolSnapshot.exists() || patrolSnapshot.get("estado") !== "Disponible") {
                    throw new Error("La patrulla seleccionada no está disponible para un nuevo despacho.");
                }
                const patrol = patrolSnapshot.data();
                const updatedAt = patrol.updatedAt;
                if (!updatedAt || typeof updatedAt.toMillis !== "function" ||
                    Date.now() - updatedAt.toMillis() >= 5 * 60 * 1000 ||
                    Date.now() < updatedAt.toMillis()) {
                    throw new Error("La unidad todavía no comparte una ubicación GPS reciente.");
                }
                if (![current.latitud, current.longitud, patrol.latitud, patrol.longitud].every(Number.isFinite)) {
                    throw new Error("La ubicación de la unidad o del incidente no es válida.");
                }
                const etaMinutos = Math.max(1, Math.ceil(distanceMeters(current, patrol) / (25000 / 60)));
                changes = {
                    estado: "Auxilio en camino",
                    unidad: patrol.codigo || patrolId,
                    patrullaId: patrolId,
                    vehiculo: patrol.vehiculo || "Unidad de serenazgo",
                    etaMinutos,
                    despachoAt: serverTimestamp()
                };
            } else if (action === "onsite" && current.estado === "Auxilio en camino") {
                if (!current.patrullaId) throw new Error("El incidente no tiene una unidad asignada.");
                if (!["administrador", "admin"].includes(state.role) &&
                    current.patrullaId !== profile.patrullaId) {
                    throw new Error("Solo la unidad asignada puede marcar su llegada.");
                }
                patrolRef = doc(db, "patrullas", current.patrullaId);
                patrolSnapshot = await transaction.get(patrolRef);
                if (!patrolSnapshot.exists() || patrolSnapshot.get("estado") !== "Despachado" ||
                    patrolSnapshot.get("incidenteId") !== id) {
                    throw new Error("La unidad no está despachada a este incidente.");
                }
                const patrol = patrolSnapshot.data();
                const updatedAt = patrol.updatedAt;
                if (!updatedAt || typeof updatedAt.toMillis !== "function" ||
                    Date.now() - updatedAt.toMillis() > 2 * 60 * 1000 ||
                    distanceMeters(current, patrol) > Math.max(30, Number(patrol.precisionMetros) || 0)) {
                    throw new Error("La ubicación GPS de la unidad no es reciente o aún está lejos del incidente.");
                }
                changes = { estado: "Agentes en sitio", enSitioAt: serverTimestamp() };
            } else if (action === "close" && current.estado === "Agentes en sitio") {
                if (!current.patrullaId) throw new Error("El incidente no tiene una unidad asignada.");
                if (!["administrador", "admin"].includes(state.role) &&
                    current.patrullaId !== profile.patrullaId) {
                    throw new Error("Solo la unidad asignada puede cerrar este incidente.");
                }
                patrolRef = doc(db, "patrullas", current.patrullaId);
                patrolSnapshot = await transaction.get(patrolRef);
                if (!patrolSnapshot.exists() || patrolSnapshot.get("estado") !== "En sitio" ||
                    patrolSnapshot.get("incidenteId") !== id) {
                    throw new Error("La unidad no figura en sitio para este incidente.");
                }
                const outcome = String(payload.outcome || "");
                if (!["Intervención preventiva", "Sujeto intervenido", "Falsa alarma",
                    "Persona detenida", "Sin novedad"].includes(outcome)) {
                    throw new TypeError("Selecciona un resultado válido para el incidente.");
                }
                changes = {
                    estado: "Emergencia Concluida",
                    resultado: outcome,
                    closedAt: serverTimestamp(),
                    resueltoPorUid: user.uid
                };
            } else {
                throw new Error("El incidente no puede pasar a ese estado.");
            }

            const updatedAt = serverTimestamp();
            const updated = { ...current, ...changes, ultimaActualizacion: updatedAt };
            transaction.update(incidentRef, { ...changes, ultimaActualizacion: updatedAt });
            transaction.set(publicRef, makePublicAlert(updated), { merge: true });
            if (patrolRef && patrolSnapshot) {
                const patrolChanges = action === "dispatch"
                    ? { estado: "Despachado", incidenteId: id, updatedAt }
                    : action === "onsite"
                        ? { estado: "En sitio", incidenteId: id, updatedAt }
                        : { estado: "Disponible", incidenteId: null, updatedAt };
                transaction.set(patrolRef, patrolChanges, { merge: true });
            }
            return { ok: true, estado: changes.estado, changes };
        });
        if (!result.changes) return result;
        const updatedAt = new Date().toISOString();
        const localChanges = {
            ultimaActualizacion: updatedAt
        };
        Object.entries(result.changes).forEach(([key, value]) => {
            localChanges[key] = key.endsWith("At") || key === "ultimaActualizacion"
                ? updatedAt
                : value;
        });
        if (["discard", "close"].includes(action)) {
            localChanges.closedAt = updatedAt;
            localChanges.resueltoPorUid = user.uid;
        }
        state.incidents = state.incidents.map((incident) =>
            incident.id === id ? { ...incident, ...localChanges } : incident
        );
        state.ownIncidents = state.ownIncidents.map((incident) =>
            incident.id === id ? { ...incident, ...localChanges } : incident
        );
        dispatch("coalerta:mis-alertas-actualizadas", state.ownIncidents);
        dispatch("coalerta:incidentes-actualizados", state.incidents);
        return result;
    }

    async function publishOfficialNotice(template, incidentId) {
        const { user, profile } = requireRole(["coordinador", "administrador", "admin"]);
        const allowedTemplates = [
            "Emergencia canalizada",
            "Sujeto retenido por autoridades",
            "Zona segura",
            "Falsa alarma aclarada por autoridades"
        ];
        if (!allowedTemplates.includes(template)) throw new TypeError("Selecciona una plantilla oficial válida.");
        if (!profile.comunidadId && state.role === "coordinador") {
            throw new Error("Tu cuenta no tiene una comunidad asignada.");
        }
        const incidentRef = doc(db, "incidentes", String(incidentId || ""));
        const noticeRef = doc(collection(db, "avisos_publicos"));
        return runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(incidentRef);
            if (!snapshot.exists()) throw new Error("No se encontró el incidente seleccionado.");
            const incident = snapshot.data();
            const allowedResults = ["Persona detenida", "Falsa alarma", "Intervención preventiva", "Sin novedad"];
            if ((state.role === "coordinador" && incident.comunidadId !== profile.comunidadId) ||
                !incident.derivadaAt ||
                incident.estado !== "Emergencia Concluida" || !allowedResults.includes(incident.resultado)) {
                throw new Error("El comunicado solo puede vincularse a un incidente derivado y cerrado por seguridad.");
            }
            if ((incident.resultado === "Falsa alarma") !==
                (template === "Falsa alarma aclarada por autoridades")) {
                throw new Error("La plantilla no corresponde al resultado registrado por seguridad.");
            }
            transaction.set(noticeRef, {
                titulo: `Comunicado oficial · ${incident.tipo || "Incidente"}`,
                mensaje: `${template}. Resultado de revisión: ${incident.resultado}.`,
                plantilla: template,
                tipoIncidente: incident.tipo || "Incidente",
                incidenteId: snapshot.id,
                resultadoIncidente: incident.resultado,
                autorUid: user.uid,
                comunidadId: incident.comunidadId,
                timestamp: serverTimestamp()
            });
            return { ok: true, avisoId: noticeRef.id };
        });
    }

    async function updatePatrolLocation(point) {
        const { user, profile } = requireRole(["agente", "seguridad", "administrador", "admin"]);
        const patrolId = String(profile.patrullaId || "").trim();
        if (!patrolId) throw new Error("Solicita al administrador asignar una unidad a tu perfil.");
        const comunidadId = String(profile.comunidadId || "").trim();
        if (!comunidadId) throw new Error("Tu perfil no tiene una comunidad asignada para operar la unidad.");
        const location = validatePoint(point);
        const patrolRef = doc(db, "patrullas", patrolId);
        const profileRef = doc(db, "usuarios", user.uid);
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(patrolRef);
            const locationTimestamp = serverTimestamp();
            const updated = {
                comunidadId,
                agenteUid: user.uid,
                latitud: location.latitud,
                longitud: location.longitud,
                precisionMetros: location.precisionMetros,
                updatedAt: locationTimestamp
            };
            if (snapshot.exists()) {
                transaction.update(patrolRef, updated);
            } else {
                transaction.set(patrolRef, {
                    ...updated,
                    codigo: profile.codigoPatrulla || patrolId,
                    estado: "Disponible"
                });
            }
            transaction.update(profileRef, {
                ultimaUbicacion: {
                    latitud: location.latitud,
                    longitud: location.longitud,
                    timestamp: locationTimestamp
                }
            });
        });
        return { ok: true, patrullaId: patrolId };
    }

    async function updateSecurityLocation(point) {
        const { user, profile } = requireRole(["seguridad"]);
        const comunidadId = String(profile.comunidadId || "").trim();
        if (!comunidadId) throw new Error("Únete a una comunidad antes de compartir tu ubicación.");
        const location = validatePoint(point);
        const memberRef = doc(db, "comunidades", comunidadId, "miembros", user.uid);
        const profileRef = doc(db, "usuarios", user.uid);
        await runTransaction(db, async (transaction) => {
            const memberSnapshot = await transaction.get(memberRef);
            if (!memberSnapshot.exists()) {
                throw new Error("No se encontró tu perfil de miembro en la comunidad.");
            }
            const locationTimestamp = serverTimestamp();
            transaction.update(memberRef, {
                latitud: location.latitud,
                longitud: location.longitud,
                precisionMetros: location.precisionMetros,
                ubicacionCompartida: true,
                ubicacionActualizadaAt: locationTimestamp
            });
            if (!profile.patrullaId) {
                transaction.update(profileRef, {
                    ultimaUbicacion: {
                        latitud: location.latitud,
                        longitud: location.longitud,
                        timestamp: locationTimestamp
                    }
                });
            }
        });
        return { ok: true };
    }

    async function clearSecurityLocation() {
        const { user, profile } = requireRole(["seguridad", "agente"]);
        const comunidadId = String(profile.comunidadId || "").trim();
        const profileRef = doc(db, "usuarios", user.uid);
        await runTransaction(db, async (transaction) => {
            let memberRef = null;
            let memberSnapshot = null;
            if (state.role === "seguridad" && comunidadId) {
                memberRef = doc(db, "comunidades", comunidadId, "miembros", user.uid);
                memberSnapshot = await transaction.get(memberRef);
            }
            if (memberRef && memberSnapshot && memberSnapshot.exists()) {
                transaction.update(memberRef, {
                    latitud: null,
                    longitud: null,
                    precisionMetros: null,
                    ubicacionCompartida: false,
                    ubicacionActualizadaAt: serverTimestamp()
                });
            }
            transaction.update(profileRef, { ultimaUbicacion: null });
        });
        return { ok: true };
    }

    async function synchronizeCommunityMemberProfile(uid, communityId, profile) {
        const memberRef = doc(db, "comunidades", communityId, "miembros", uid);
        const memberSnapshot = await getDoc(memberRef);
        if (!memberSnapshot.exists()) return;
        const nombre = String(profile.nombre || "").trim();
        const telefono = String(profile.telefono || "").trim();
        if (!nombre || !/^\d{9}$/.test(telefono)) {
            throw new Error("El nombre o teléfono del perfil no es válido para actualizar el contacto comunitario.");
        }
        if (memberSnapshot.get("nombre") === nombre && memberSnapshot.get("telefono") === telefono) return;
        await updateDoc(memberRef, { nombre, telefono });
    }

    async function synchronizeCurrentCommunityMemberProfile(profileUpdates) {
        const { user, profile } = requireActiveProfile();
        if (!profile.comunidadId || !["vecino", "seguridad"].includes(state.role)) return;
        await synchronizeCommunityMemberProfile(user.uid, profile.comunidadId, {
            ...profile,
            ...profileUpdates
        });
    }

    async function synchronizeOwnIncidentsToCommunity(uid = state.uid, communityId = state.profile && state.profile.comunidadId) {
        if (!uid || !communityId) return 0;
        const snapshot = await getDocs(query(
            collection(db, "incidentes"),
            where("reporterUids", "array-contains", uid)
        ));
        let synchronized = 0;
        for (const incident of snapshot.docs) {
            const publicRef = doc(db, "alertas_publicas", incident.id);
            const updated = await runTransaction(db, async (transaction) => {
                const currentIncident = await transaction.get(incident.ref);
                if (!currentIncident.exists()) return false;
                const assignedCommunity = currentIncident.get("comunidadId");
                if (assignedCommunity === communityId) return false;
                if (assignedCommunity !== null && assignedCommunity !== undefined && assignedCommunity !== "") {
                    return false;
                }
                const publicAlert = await transaction.get(publicRef);
                if (!publicAlert.exists()) {
                    throw new Error(`No se encontró la alerta pública asociada al incidente ${incident.id}.`);
                }
                const updatedAt = serverTimestamp();
                transaction.update(incident.ref, {
                    comunidadId: communityId,
                    ultimaActualizacion: updatedAt
                });
                transaction.update(publicRef, {
                    comunidadId: communityId,
                    ultimaActualizacion: updatedAt
                });
                return true;
            });
            if (updated) synchronized += 1;
        }
        return synchronized;
    }

    async function saveCoverageZone(zone) {
        const { user, profile } = requireRole(["coordinador"]);
        const comunidadId = String(profile.comunidadId || "");
        const latitud = Number(zone && zone.latitud);
        const longitud = Number(zone && zone.longitud);
        const radioMetros = Number(zone && zone.radioMetros);
        if (!comunidadId || !Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180 ||
            !Number.isFinite(radioMetros) || radioMetros < 100 || radioMetros > 20000) {
            throw new TypeError("Configura una ubicación válida y un radio entre 0,1 y 20 km.");
        }
        await setDoc(doc(db, "zonas", comunidadId), {
            comunidadId,
            latitud,
            longitud,
            radioMetros,
            updatedBy: user.uid,
            updatedAt: serverTimestamp()
        });
        return { ok: true };
    }

    async function saveDelegation(delegation) {
        const { user, profile } = requireRole(["coordinador"]);
        const communityId = String(profile.comunidadId || "");
        const substituteUid = String(delegation && delegation.suplenteUid || "").trim();
        const start = new Date(delegation && delegation.inicio);
        const end = new Date(delegation && delegation.fin);
        if (!communityId || !substituteUid || substituteUid === user.uid ||
            !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
            start <= new Date() || end <= start || end.getTime() - start.getTime() > 31 * 86400000) {
            throw new TypeError("Selecciona un vecino válido y un periodo futuro de hasta 31 días.");
        }
        const memberRef = doc(db, "comunidades", communityId, "miembros", substituteUid);
        const delegationRef = doc(db, "delegaciones", communityId);
        await runTransaction(db, async (transaction) => {
            const memberSnapshot = await transaction.get(memberRef);
            if (!memberSnapshot.exists() ||
                memberSnapshot.get("estado") !== "Activo") {
                throw new Error("El suplente debe ser un vecino activo y verificado de tu comunidad.");
            }
            transaction.set(delegationRef, {
                coordinadorUid: user.uid,
                suplenteUid: substituteUid,
                comunidadId: communityId,
                inicio: start,
                fin: end,
                updatedAt: serverTimestamp()
            });
        });
        return { ok: true };
    }

    async function ensureCoordinatorCommunity(user, profile) {
        let communityId = String(profile.comunidadId || "").trim();
        if (communityId) return communityId;

        const profileRef = doc(db, "usuarios", user.uid);
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(profileRef);
            if (!snapshot.exists() || snapshot.get("activo") !== true ||
                snapshot.get("rol") !== "coordinador") {
                throw new Error("No se pudo confirmar que tu cuenta tenga el rol de coordinador activo.");
            }
            const currentCommunityId = String(snapshot.get("comunidadId") || "").trim();
            if (currentCommunityId) {
                communityId = currentCommunityId;
                return;
            }
            transaction.update(profileRef, { comunidadId: DEFAULT_COMMUNITY_ID });
            communityId = DEFAULT_COMMUNITY_ID;
        });
        profile.comunidadId = communityId;
        state.profile = { ...state.profile, comunidadId: communityId };
        const cachedProfile = getCachedProfile(user);
        if (cachedProfile) {
            try {
                localStorage.setItem("coalerta_usuario", JSON.stringify({
                    ...cachedProfile,
                    comunidadId
                }));
            } catch (error) {
                console.error("No se pudo actualizar la copia local de la comunidad:", error);
            }
        }
        dispatch("coalerta:comunidad-asignada", { comunidadId });
        watchCommunityMembers(comunidadId);
        return communityId;
    }

    async function generateCommunityInvite() {
        const { user, profile } = requireRole(["coordinador"]);
        const comunidadId = await ensureCoordinatorCommunity(user, profile);
        const randomBytes = new Uint8Array(12);
        if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
            throw new Error("Este navegador no permite generar un código seguro.");
        }
        window.crypto.getRandomValues(randomBytes);
        const code = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0"))
            .join("").toUpperCase();
        await setDoc(doc(db, "invitaciones", code), {
            comunidadId,
            creadoPor: user.uid,
            activo: true,
            fechaCreacion: serverTimestamp()
        });
        return { code, comunidadId };
    }

    async function joinCommunity(rawCode) {
        const { user, profile } = requireActiveProfile();
        const code = String(rawCode || "").trim().toUpperCase();
        if (!/^[A-F0-9]{24}$/.test(code)) throw new TypeError("El código de invitación no es válido.");
        if (!["vecino", "seguridad"].includes(state.role) || profile.comunidadId) {
            throw new Error("Solo un vecino o personal de seguridad sin comunidad puede unirse.");
        }
        const invitationRef = doc(db, "invitaciones", code);
        const profileRef = doc(db, "usuarios", user.uid);
        await runTransaction(db, async (transaction) => {
            const invitationSnapshot = await transaction.get(invitationRef);
            const profileSnapshot = await transaction.get(profileRef);
            if (!invitationSnapshot.exists() || invitationSnapshot.get("activo") !== true) {
                throw new Error("El código de invitación no existe o ya fue utilizado.");
            }
            const invitation = invitationSnapshot.data();
            const communityId = String(invitation.comunidadId || "");
            if (!communityId) throw new Error("La invitación no tiene una comunidad válida.");
            const actualMemberRef = doc(db, "comunidades", communityId, "miembros", user.uid);
            const memberSnapshot = await transaction.get(actualMemberRef);
            if (!profileSnapshot.exists()) {
                throw new Error("No se encontró el perfil activo para unirse a la comunidad.");
            }
            const memberRole = String(profileSnapshot.get("rol") || "");
            if (profileSnapshot.get("activo") !== true ||
                !["vecino", "seguridad"].includes(memberRole) ||
                profileSnapshot.get("comunidadId") ||
                memberSnapshot.exists()) {
                throw new Error("La cuenta ya pertenece a una comunidad o no puede unirse.");
            }
            transaction.update(invitationRef, {
                activo: false,
                usadoPor: user.uid,
                usadoAt: serverTimestamp()
            });
            transaction.update(profileRef, {
                comunidadId: communityId,
                rol: memberRole,
                invitacionId: code
            });
            transaction.set(actualMemberRef, {
                nombre: profileSnapshot.get("nombre") || "",
                telefono: profileSnapshot.get("telefono") || "",
                rol: memberRole,
                estado: "Activo",
                fechaIngreso: serverTimestamp(),
                invitacionId: code,
                ubicacionCompartida: false
            });
        });
        const updatedProfile = (await getDoc(profileRef)).data();
        state.profile = { ...updatedProfile, uid: user.uid };
        state.zone = null;
        state.delegation = null;
        try {
            await synchronizeOwnIncidentsToCommunity(user.uid, state.profile.comunidadId);
        } catch (error) {
            console.error("Te uniste, pero no se pudieron sincronizar tus alertas anteriores:", error);
            throw new Error(
                `Te uniste correctamente, pero no se pudieron sincronizar tus alertas anteriores. ` +
                `Vuelve a cargar la página para reintentarlo. ${error.message || ""}`.trim()
            );
        }
        return { ok: true, comunidadId: state.profile.comunidadId };
    }

    async function createCommunityAnnouncement(announcement) {
        const { user, profile } = requireRole(["coordinador"]);
        const title = String(announcement && announcement.title || "").trim();
        const description = String(announcement && announcement.description || "").trim();
        if (!profile.comunidadId || !title || title.length > 100 ||
            !description || description.length > 1000) {
            throw new TypeError("Completa un título (máx. 100) y mensaje (máx. 1000 caracteres).");
        }
        const announcementRef = doc(collection(db, "comunidades", profile.comunidadId, "anuncios"));
        await setDoc(announcementRef, {
            titulo: title,
            descripcion: description,
            autorUid: user.uid,
            autorNombre: profile.nombre,
            fecha: serverTimestamp()
        });
        return { ok: true, anuncioId: announcementRef.id };
    }

    async function deleteCommunityAnnouncement(announcementId) {
        const { user, profile } = requireActiveProfile();
        if (!profile.comunidadId || !announcementId) throw new TypeError("El anuncio seleccionado no es válido.");
        const announcementRef = doc(db, "comunidades", profile.comunidadId, "anuncios", String(announcementId));
        await deleteDoc(announcementRef);
        return { ok: true };
    }

    async function listCommunityDelegates() {
        const { profile } = requireRole(["coordinador"]);
        if (!profile.comunidadId) throw new Error("Tu cuenta no tiene una comunidad asignada.");
        const membersQuery = query(
            collection(db, "comunidades", profile.comunidadId, "miembros"),
            where("rol", "==", "vecino"),
            where("estado", "==", "Activo"),
            limit(100)
        );
        const snapshot = await getDocs(membersQuery);
        return {
            members: snapshot.docs
                .filter((member) => member.id !== state.uid)
                .map((member) => ({ uid: member.id, nombre: String(member.get("nombre") || "Vecino") }))
        };
    }

    async function saveEmergencyContacts(contacts) {
        const { user } = requireActiveProfile();
        if (!Array.isArray(contacts) || contacts.length > 2) {
            throw new TypeError("Puedes guardar hasta dos contactos.");
        }
        const sanitized = contacts.map((contact) => ({
            nombre: String(contact && contact.nombre || "").trim(),
            telefono: String(contact && contact.telefono || "").trim()
        }));
        if (sanitized.some((contact) => !contact.nombre || contact.nombre.length > 80 ||
            !/^\d{9}$/.test(contact.telefono))) {
            throw new TypeError("Cada contacto debe tener un nombre y un celular válido de 9 dígitos.");
        }
        await setDoc(doc(db, "usuarios", user.uid), { contactosEmergencia: sanitized }, { merge: true });
        return { ok: true, notificationSent: false };
    }

    async function deactivateAccount(dni) {
        const { user, profile } = requireActiveProfile();
        const value = String(dni || "").trim();
        if (!/^\d{8}$/.test(value)) throw new TypeError("Ingresa un DNI válido de 8 dígitos.");
        if (String(profile.dni || "").trim() !== value) {
            throw new Error("El DNI no coincide con la cuenta activa. No se desactivó la cuenta.");
        }
        await updateDoc(doc(db, "usuarios", user.uid), {
            activo: false,
            desactivadoAt: serverTimestamp()
        });
        state.profile = { ...profile, activo: false };
        state.ready = false;
        return { ok: true };
    }

    window.coalertaData = {
        isReady: () => state.ready,
        isRegistrationIncomplete: () => state.registrationIncomplete,
        waitForReady,
        getProfile: () => state.profile,
        getRole: () => state.role,
        refreshCurrentProfile,
        getAlerts,
        getIncidents,
        getMyAlerts,
        getNotices: () => state.notices.slice().sort((first, second) =>
            new Date(second.timestamp || 0) - new Date(first.timestamp || 0)
        ),
        getReadNotices: () => state.readNotices.slice(),
        getAudit: () => state.audit,
        getPatrols: () => state.patrols,
        getCommunityMembers: () => state.communityMembers.slice(),
        getZone: () => state.zone,
        getDelegation: () => state.delegation,
        savePreferences,
        isActive: (alert) => activeStates.has(alert.estado),
        normalizeCategory,
        distanceMeters,
        createAlert,
        refreshAlerts,
        transitionIncident,
        markAlertRead,
        markNoticeRead,
        publishOfficialNotice,
        updatePatrolLocation,
        updateSecurityLocation,
        clearSecurityLocation,
        synchronizeOwnIncidentsToCommunity,
        synchronizeCurrentCommunityMemberProfile,
        saveCoverageZone,
        saveDelegation,
        generateCommunityInvite,
        joinCommunity,
        createCommunityAnnouncement,
        deleteCommunityAnnouncement,
        listCommunityDelegates,
        saveEmergencyContacts,
        deactivateAccount
    };

    const cachedProfile = (() => {
        try {
            return JSON.parse(localStorage.getItem("coalerta_usuario") || "null");
        } catch (error) {
            console.error("No se pudo recuperar el rol guardado localmente:", error);
            return null;
        }
    })();
    if (cachedProfile && typeof cachedProfile === "object") {
        updateRoleNavigation(
            { uid: cachedProfile.uid, email: cachedProfile.correo || cachedProfile.email || "" },
            cachedProfile.rol,
            false
        );
    } else {
        updateRoleNavigation(null, null, false);
    }

    onAuthStateChanged(auth, startForUser);
})();
