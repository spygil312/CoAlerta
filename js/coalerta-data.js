import {
    collection, deleteDoc, doc, getDoc, getDocs, getDocsFromServer, limit, onSnapshot,
    orderBy, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

/* SERVICIOS FIREBASE */
(function () {
    const DEFAULT_COMMUNITY_ID = "comunidad_general_1";
    const activeStates = new Set([
        "Recibido en servidor", "En revisión", "Derivada a Central",
        "Auxilio en camino", "Atendiendo", "Agentes en sitio"
    ]);
    const state = {
        uid: null,
        profile: null,
        isAdmin: false,
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
        delegationReady: false,
        delegationTimer: null,
        operationalDataReady: false,
        patrolDataReady: false,
        communityMembersCommunityId: null,
        communityMembersUnsubscribe: null,
        listeners: []
    };
    const communityIncidentSyncs = new Map();

    function normalizeCategory(value) {
        const category = String(value || "").normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "").toLowerCase();
        if (category.includes("robo")) return "robo";
        if (category.includes("sospech")) return "sospecha";
        if (category.includes("accidente")) return "accidente";
        if (category.includes("incendio")) return "incendio";
        return category;
    }

    function categoryCode(value) {
        const codes = {
            robo: "ROBO_PROCESO",
            sospecha: "PRESENCIA_SOSPECHOSA",
            accidente: "ACCIDENTE",
            incendio: "INCENDIO"
        };
        return codes[normalizeCategory(value)] || "";
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
        state.listeners.slice().forEach((unsubscribe) => unsubscribe());
        state.listeners = [];
        if (state.delegationTimer !== null) {
            window.clearTimeout(state.delegationTimer);
            state.delegationTimer = null;
        }
    }

    function isActiveDelegate() {
        const delegation = state.delegation;
        if (!state.delegationReady || !state.uid || state.role !== "vecino" ||
            !state.profile || state.profile.activo !== true || !delegation ||
            delegation.suplenteUid !== state.uid ||
            delegation.comunidadId !== state.profile.comunidadId) {
            return false;
        }
        const start = new Date(delegation.inicio).getTime();
        const end = new Date(delegation.fin).getTime();
        const now = Date.now();
        return Number.isFinite(start) && Number.isFinite(end) && start <= now && end >= now;
    }

    function effectiveRole(role = state.role) {
        return role === "vecino" && isActiveDelegate() ? "coordinador" : role;
    }

    function scheduleDelegationRoleUpdate() {
        if (state.delegationTimer !== null) {
            window.clearTimeout(state.delegationTimer);
            state.delegationTimer = null;
        }
        if (!state.delegationReady || state.role !== "vecino" || !state.delegation ||
            state.delegation.suplenteUid !== state.uid) return;

        const start = new Date(state.delegation.inicio).getTime();
        const end = new Date(state.delegation.fin).getTime();
        const now = Date.now();
        const nextChange = start > now ? start : end >= now ? end + 1 : NaN;
        if (!Number.isFinite(nextChange)) return;
        state.delegationTimer = window.setTimeout(() => {
            state.delegationTimer = null;
            updateRoleNavigation(auth.currentUser, state.role, true);
            dispatch("coalerta:delegacion-actualizada", state.delegation);
            scheduleDelegationRoleUpdate();
        }, Math.min(nextChange - now + 1, 2147483647));
    }

    function reportListenerError(area, error, severity = "error") {
        const log = severity === "warn" ? console.warn : console.error;
        log(`No se pudo sincronizar ${area} desde Firebase:`, error);
        let message = `No se pudo sincronizar ${area}. Inténtalo de nuevo más tarde.`;
        if (error.code === "permission-denied") {
            message = `No tienes permiso para consultar ${area}.`;
        } else if (error.code === "resource-exhausted") {
            message = `Firestore agotó temporalmente la cuota disponible al consultar ${area}. Espera unos minutos y vuelve a intentarlo; esto no indica un problema con las reglas de acceso.`;
        } else if (error.code === "unavailable") {
            message = `No se pudo conectar para consultar ${area}. Revisa tu conexión.`;
        } else if (error.code === "failed-precondition") {
            message = `Firestore no pudo completar la consulta de ${area}. Revisa la configuración del índice y vuelve a cargar la página.`;
        }
        dispatch("coalerta:error", { area, code: error.code || "unknown", message });
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
                await setDoc(doc(db, "usuarios", uid), { preferencias: preferences }, { merge: true });
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
        const unsubscribe = onSnapshot(query, {
            includeMetadataChanges: property === "patrols"
        }, (snapshot) => {
            state[property] = snapshot.docs.map((document) => {
                const normalized = normalizeDocument(document);
                if (property === "patrols") {
                    normalized._hasPendingWrites = document.metadata.hasPendingWrites;
                }
                return normalized;
            });
            dispatch(eventName, state[property]);
        }, (error) => reportListenerError(area, error));
        state.listeners.push(unsubscribe);
        return unsubscribe;
    }

    function watchCommunityMembers(communityId) {
        if (state.communityMembersCommunityId === communityId) return;
        if (state.communityMembersUnsubscribe) state.communityMembersUnsubscribe();
        state.communityMembersCommunityId = communityId;
        state.communityMembersUnsubscribe = watch(
            collection(doc(db, "comunidades", communityId), "miembros"),
            "communityMembers",
            "coalerta:miembros-actualizados",
            "miembros de comunidad"
        );
    }

    function hasPageClass(pageClass) {
        return Boolean(document.body && document.body.classList &&
            document.body.classList.contains(pageClass));
    }

    function isOperationalPage() {
        return hasPageClass("pagina-central") || hasPageClass("pagina-seguridad");
    }

    function isMapPage() {
        return hasPageClass("pagina-mapa");
    }

    function watchOperationalData() {
        if (state.operationalDataReady || !isOperationalPage()) return;
        const communityId = String(state.profile && state.profile.comunidadId || "");
        if (!state.isAdmin && !communityId.trim()) return;

        state.operationalDataReady = true;
        watch(
            state.isAdmin
                ? query(collection(db, "incidentes"), orderBy("timestamp", "desc"), limit(200))
                : query(
                    collection(db, "incidentes"),
                    where("comunidadId", "==", communityId),
                    orderBy("timestamp", "desc"),
                    limit(200)
                ),
            "incidents",
            "coalerta:incidentes-actualizados",
            "incidentes operativos"
        );
        if (hasPageClass("pagina-central")) {
            watch(
                state.isAdmin
                    ? query(collection(db, "auditoria"), orderBy("createdAt", "desc"), limit(100))
                    : query(
                        collection(db, "auditoria"),
                        where("comunidadId", "==", communityId),
                        orderBy("createdAt", "desc"),
                        limit(100)
                    ),
                "audit",
                "coalerta:auditoria-actualizada",
                "bitácora"
            );
        }
        watch(
            state.isAdmin
                ? query(collection(db, "patrullas"), limit(100))
                : query(collection(db, "patrullas"), where("comunidadId", "==", communityId), limit(100)),
            "patrols",
            "coalerta:patrullas-actualizadas",
            "patrullas"
        );
    }

    function watchMapPatrols() {
        if (state.patrolDataReady || !isMapPage()) return;
        if (!state.isAdmin && !["coordinador", "agente", "seguridad"].includes(state.role)) return;
        const communityId = String(state.profile && state.profile.comunidadId || "").trim();
        if (!state.isAdmin && !communityId) return;

        state.patrolDataReady = true;
        watch(
            state.isAdmin
                ? query(collection(db, "patrullas"), limit(100))
                : query(collection(db, "patrullas"), where("comunidadId", "==", communityId), limit(100)),
            "patrols",
            "coalerta:patrullas-actualizadas",
            "patrullas"
        );
    }

    function watchPageData() {
        if (isOperationalPage()) {
            watchOperationalData();
        } else if (isMapPage()) {
            watchMapPatrols();
        }
    }

    function publicAlertsQuery() {
        const communityId = String(state.profile && state.profile.comunidadId || "").trim();
        return query(
            collection(db, "alertas_publicas"),
            communityId
                ? where("comunidadId", "==", communityId)
                : where("visibilidad", "==", "publica"),
            orderBy("timestamp", "desc"),
            limit(200)
        );
    }

    function resetData() {
        stopListeners();
        state.uid = null;
        state.profile = null;
        state.isAdmin = false;
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
        state.delegationReady = false;
        state.operationalDataReady = false;
        state.patrolDataReady = false;
        state.communityMembersCommunityId = null;
        state.communityMembersUnsubscribe = null;
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
        Promise.all([
            getDoc(doc(db, "usuarios", user.uid)),
            user.getIdTokenResult()
        ]).then(([document, tokenResult]) => {
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
            state.isAdmin = tokenResult.claims.admin === true
                && tokenResult.claims.email_verified === true;
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
            if (state.role === "coordinador" && profile.comunidadId) {
                registerCommunityCoordinator(user.uid, profile.comunidadId).catch((error) => {
                    console.error("No se pudo registrar la coordinación comunitaria:", error);
                });
            }
            updateRoleNavigation(user, state.role, true);
            syncPreferences(user.uid, profile).catch((error) =>
                reportListenerError("preferencias de cuenta", error)
            );
            state.profile.preferencias = profile.preferencias;
            state.ready = true;
            watch(
                publicAlertsQuery(),
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
                    limit(50)),
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
                    where("comunidadId", "==", profile.comunidadId || null), limit(500)),
                "notices",
                "coalerta:avisos-actualizados",
                "comunicados"
            );
            const role = state.role;
            if (["coordinador", "agente", "seguridad", "administrador", "admin"].includes(role)) {
                watchPageData();
            }

            if (profile.comunidadId) {
                if (["pagina-mapa", "pagina-comunidad", "pagina-seguridad"]
                    .some(hasPageClass)) {
                    watchCommunityMembers(profile.comunidadId);
                }
                if (hasPageClass("pagina-central")) {
                    const zoneUnsubscribe = onSnapshot(doc(db, "zonas", profile.comunidadId), (snapshot) => {
                        state.zone = snapshot.exists() ? snapshot.data() : null;
                        dispatch("coalerta:zona-actualizada", state.zone);
                    }, (error) => reportListenerError("perímetro", error));
                    state.listeners.push(zoneUnsubscribe);
                }
                if (state.role === "vecino" || hasPageClass("pagina-central")) {
                    const delegationUnsubscribe = onSnapshot(doc(db, "delegaciones", profile.comunidadId), (snapshot) => {
                        state.delegation = snapshot.exists() ? normalizeDocument(snapshot) : null;
                        state.delegationReady = true;
                        updateRoleNavigation(user, state.role, true);
                        scheduleDelegationRoleUpdate();
                        watchPageData();
                        dispatch("coalerta:delegacion-actualizada", state.delegation);
                    }, (error) => {
                        state.delegationReady = true;
                        updateRoleNavigation(user, state.role, true);
                        watchPageData();
                        reportListenerError("delegación", error, "warn");
                        dispatch("coalerta:delegacion-actualizada", null);
                    });
                    state.listeners.push(delegationUnsubscribe);
                } else {
                    state.delegationReady = true;
                }
                if (!state.isAdmin &&
                    ["vecino", "seguridad", "coordinador"].includes(role)) {
                    synchronizeOwnIncidentsToCommunity(user.uid, profile.comunidadId)
                        .catch((error) => reportListenerError("incidentes operativos", error));
                }
                if (["vecino", "seguridad"].includes(state.role)) {
                    synchronizeCommunityMemberProfile(user.uid, profile.comunidadId, profile)
                        .catch((error) => reportListenerError("contacto de la comunidad", error));
                }
            } else {
                state.delegationReady = true;
                updateRoleNavigation(user, state.role, true);
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
            dispatch("coalerta:error", {
                area: "perfil",
                message: "No se pudo sincronizar tu cuenta. Inténtalo de nuevo más tarde."
            });
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
        const normalizedRole = effectiveRole(String(role || "").trim().toLowerCase());
        let isAdmin = Boolean(user) && state.isAdmin;
        if (!ready && user) {
            try {
                const cachedRole = JSON.parse(localStorage.getItem("userRole") || "null");
                if (cachedRole && cachedRole.uid === user.uid &&
                    cachedRole.role === normalizedRole) {
                    isAdmin = cachedRole.isAdmin === true;
                }
            } catch (error) {
                console.warn("No se pudo leer el rol guardado para la navegación:", error);
            }
        }

        const isCoordinator = Boolean(user) &&
            (isAdmin || ["coordinador", "administrador", "admin"].includes(normalizedRole));
        const isSecurity = Boolean(user) &&
            (isAdmin || ["agente", "seguridad", "administrador", "admin"].includes(normalizedRole));
        const roleClasses = ["role-admin", "role-coordinator", "role-security"];
        [document.documentElement, document.body].filter(Boolean).forEach((element) => {
            element.classList.remove(...roleClasses);
            if (isAdmin) element.classList.add("role-admin");
            if (isCoordinator) element.classList.add("role-coordinator");
            if (isSecurity) element.classList.add("role-security");
        });

        if (ready && user) {
            try {
                localStorage.setItem("userRole", JSON.stringify({
                    uid: user.uid,
                    role: normalizedRole,
                    isAdmin: state.isAdmin
                }));
            } catch (error) {
                console.warn("No se pudo guardar el rol para la navegación:", error);
            }
        } else if (ready && !user) {
            try {
                localStorage.removeItem("userRole");
            } catch (error) {
                console.warn("No se pudo borrar el rol guardado para la navegación:", error);
            }
        }
        if (document.body) document.body.dataset.roleNavigationReady = String(ready);
    }

    async function registerCommunityCoordinator(uid, communityId) {
        const communityRef = doc(db, "comunidades", communityId);
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(communityRef);
            const timestamp = serverTimestamp();
            if (!snapshot.exists()) {
                transaction.set(communityRef, {
                    coordinadorUid: uid,
                    coordinadorAlternoUid: null,
                    updatedAt: timestamp
                });
                return;
            }
            const currentCoordinator = snapshot.get("coordinadorUid");
            const currentAlternate = snapshot.get("coordinadorAlternoUid");
            if (!currentCoordinator) {
                transaction.update(communityRef, {
                    coordinadorUid: uid,
                    coordinadorAlternoUid: null,
                    updatedAt: timestamp
                });
            } else if (currentCoordinator !== uid && !currentAlternate) {
                transaction.update(communityRef, {
                    coordinadorAlternoUid: uid,
                    updatedAt: timestamp
                });
            }
        });
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
        if (!roles.includes(effectiveRole())) {
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
                const hasExactCoordinates = Number.isFinite(alert.latitud) &&
                    alert.latitud >= -90 && alert.latitud <= 90 &&
                    Number.isFinite(alert.longitud) &&
                    alert.longitud >= -180 && alert.longitud <= 180;
                alerts.set(id, {
                    ...alert,
                    ...publicAlert,
                    ...(hasExactCoordinates ? {
                        latitud: alert.latitud,
                        longitud: alert.longitud
                    } : {}),
                    ...(typeof alert.direccion === "string" && alert.direccion.trim()
                        ? { direccion: alert.direccion }
                        : {}),
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
            getDocsFromServer(publicAlertsQuery()),
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
                    patrullaId: incident.patrullaId || null,
                    vehiculo: incident.vehiculo || null,
                    etaMinutos: incident.etaMinutos || null,
                    latitud: incident.latitud,
                    longitud: incident.longitud,
                    direccion: incident.direccion || alert.direccion || null,
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

    function watchAssignedPatrolLocation(patrolId, onUpdate) {
        const id = String(patrolId || "").trim();
        if (!id || typeof onUpdate !== "function") {
            throw new TypeError("Se requiere una unidad asignada y una función para recibir su ubicación.");
        }
        const stopSnapshot = onSnapshot(doc(db, "patrullas", id), (snapshot) => {
            onUpdate(snapshot.exists() ? normalizeDocument(snapshot) : null);
        }, (error) => reportListenerError("ubicación de patrulla asignada", error));
        let isActive = true;
        const unsubscribe = () => {
            if (!isActive) return;
            isActive = false;
            stopSnapshot();
            const listenerIndex = state.listeners.indexOf(unsubscribe);
            if (listenerIndex !== -1) state.listeners.splice(listenerIndex, 1);
        };
        state.listeners.push(unsubscribe);
        return unsubscribe;
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
        const codigoCategoria = categoryCode(categoria);
        const categories = {
            robo: "Robo",
            sospecha: "Sospecha",
            accidente: "Accidente",
            incendio: "Incendio"
        };
        if (!categories[categoria]) throw new Error("Selecciona una categoría de alerta válida.");
        if (alert.codigoCategoria !== codigoCategoria) {
            throw new Error("El código de categoría de la alerta no es válido.");
        }
        if (alert.consentimientoGPS !== true) {
            throw new Error("Debes aceptar el uso de tu ubicación GPS para enviar el reporte.");
        }
        const detalle = typeof alert.detalle === "string" ? alert.detalle.trim() : "";
        const latitud = Number(alert.latitud);
        const longitud = Number(alert.longitud);
        const precisionMetros = Number(alert.precisionMetros);
        if (detalle.length > 300) throw new Error("El detalle no puede superar 300 caracteres.");
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) {
            throw new Error("La ubicación GPS no es válida.");
        }
        if (!Number.isFinite(precisionMetros) || precisionMetros <= 0 ||
            precisionMetros > 1000000) {
            throw new Error("El navegador no proporcionó una precisión GPS válida.");
        }
        const direccion = await obtenerDireccionInversa(latitud, longitud);

        const coordinatorNeedsCommunity = effectiveRole() === "coordinador" && !state.profile.comunidadId;
        const communityId = effectiveRole() === "coordinador"
            ? await ensureCoordinatorCommunity(user, state.profile)
            : state.profile.comunidadId || null;
        if (coordinatorNeedsCommunity) {
            await synchronizeOwnIncidentsToCommunity(user.uid, communityId);
        }
        const throttleRef = doc(db, "usuarios", user.uid, "limites", "reportes_emergencia");
        const reportTimestamp = serverTimestamp();
        const tipo = categories[categoria];
        const prioridad = categoria === "sospecha" ? "Media" : "Alta";
        const groupWindowMs = 3 * 60 * 1000;
        const maxGroupReporters = 50;
        let groupCandidate = null;
        if (communityId) {
            const recentIncidents = await getDocs(query(
                collection(db, "incidentes"),
                where("comunidadId", "==", communityId),
                where("timestamp", ">=", Timestamp.fromMillis(Date.now() - groupWindowMs)),
                orderBy("timestamp", "desc"),
                limit(100)
            ));
            groupCandidate = recentIncidents.docs
                .map((snapshot) => ({ ref: snapshot.ref, data: snapshot.data() }))
                .filter((candidate) => {
                    const reporters = candidate.data.reporterUids;
                    const createdAt = candidate.data.timestamp;
                    const createdAtMs = createdAt && typeof createdAt.toMillis === "function"
                        ? createdAt.toMillis()
                        : NaN;
                    return candidate.data.categoria === categoria
                        && ["Recibido en servidor", "En revisión", "Derivada a Central"]
                            .includes(candidate.data.estado)
                        && Array.isArray(reporters)
                        && reporters.length < maxGroupReporters
                        && !reporters.includes(user.uid)
                        && Number.isFinite(createdAtMs)
                        && Date.now() >= createdAtMs
                        && Date.now() - createdAtMs < groupWindowMs
                        && distanceMeters(candidate.data, { latitud, longitud }) < 50;
                })
                .sort((first, second) =>
                    distanceMeters(first.data, { latitud, longitud }) -
                    distanceMeters(second.data, { latitud, longitud })
                )[0] || null;
        }

        const newIncidentRef = doc(collection(db, "incidentes"));
        const newPublicRef = doc(db, "alertas_publicas", newIncidentRef.id);
        const newOwnAlertRef = doc(db, "usuarios", user.uid, "alertas", newIncidentRef.id);
        const result = await runTransaction(db, async (transaction) => {
            const throttleSnapshot = await transaction.get(throttleRef);
            let groupSnapshot = null;
            let groupPublicSnapshot = null;
            let groupPublicRef = null;
            if (groupCandidate) {
                groupSnapshot = await transaction.get(groupCandidate.ref);
                groupPublicRef = doc(db, "alertas_publicas", groupCandidate.ref.id);
                groupPublicSnapshot = await transaction.get(groupPublicRef);
            }

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

            if (groupSnapshot && groupSnapshot.exists() &&
                groupPublicSnapshot && groupPublicSnapshot.exists()) {
                const current = groupSnapshot.data();
                const reporters = current.reporterUids;
                const createdAt = current.timestamp;
                const createdAtMs = createdAt && typeof createdAt.toMillis === "function"
                    ? createdAt.toMillis()
                    : NaN;
                const distance = distanceMeters(current, { latitud, longitud });
                const canJoin = current.comunidadId === communityId
                    && current.categoria === categoria
                    && ["Recibido en servidor", "En revisión", "Derivada a Central"]
                        .includes(current.estado)
                    && Array.isArray(reporters)
                    && reporters.length < maxGroupReporters
                    && !reporters.includes(user.uid)
                    && Number.isFinite(createdAtMs)
                    && Date.now() >= createdAtMs
                    && Date.now() - createdAtMs < groupWindowMs
                    && distance < 50;
                if (canJoin) {
                    const groupedIncident = {
                        ...current,
                        reportes: Number(current.reportes) + 1,
                        reporterUids: [...reporters, user.uid],
                        ultimaAgrupacionLatitud: latitud,
                        ultimaAgrupacionLongitud: longitud,
                        ultimaAgrupacionAt: reportTimestamp,
                        ultimaAgrupacionUid: user.uid,
                        ultimaAgrupacionCategoria: categoria,
                        ultimaActualizacion: reportTimestamp
                    };
                    transaction.update(groupCandidate.ref, {
                        reportes: groupedIncident.reportes,
                        reporterUids: groupedIncident.reporterUids,
                        ultimaAgrupacionLatitud: latitud,
                        ultimaAgrupacionLongitud: longitud,
                        ultimaAgrupacionAt: reportTimestamp,
                        ultimaAgrupacionUid: user.uid,
                        ultimaAgrupacionCategoria: categoria,
                        ultimaActualizacion: reportTimestamp
                    });
                    transaction.set(groupPublicRef, makePublicAlert(groupedIncident), { merge: true });
                    transaction.set(doc(db, "usuarios", user.uid, "alertas", groupCandidate.ref.id), {
                        alertaId: groupCandidate.ref.id,
                        tipo: current.tipo,
                        categoria: current.categoria,
                        latitud: current.latitud,
                        longitud: current.longitud,
                        precisionMetros: current.precisionMetros,
                        timestamp: reportTimestamp,
                        estado: current.estado,
                        prioridad: current.prioridad,
                        unidad: current.unidad || null,
                        vehiculo: current.vehiculo || null,
                        etaMinutos: current.etaMinutos || null,
                        motivoDescarte: current.motivoDescarte || null,
                        emisorUid: user.uid,
                        ultimaActualizacion: reportTimestamp,
                        detalle: current.detalle
                    });
                    return {
                        incidentId: groupCandidate.ref.id,
                        agrupada: true,
                        reportes: groupedIncident.reportes,
                        latitud: current.latitud,
                        longitud: current.longitud,
                        direccion: current.direccion || "",
                        precisionMetros: current.precisionMetros
                    };
                }
            }

            const incident = {
                id: newIncidentRef.id,
                tipo,
                categoria,
                codigoCategoria,
                consentimientoGPS: true,
                detalle,
                latitud,
                longitud,
                ...(direccion ? { direccion } : {}),
                precisionMetros,
                prioridad,
                estado: "Recibido en servidor",
                timestamp: reportTimestamp,
                reportes: 1,
                reporterUids: [user.uid],
                comunidadId: communityId,
                ultimaActualizacion: reportTimestamp,
                ultimaAgrupacionLatitud: latitud,
                ultimaAgrupacionLongitud: longitud,
                ultimaAgrupacionAt: reportTimestamp,
                ultimaAgrupacionUid: user.uid,
                ultimaAgrupacionCategoria: categoria
            };
            transaction.set(newIncidentRef, incident);
            transaction.set(newPublicRef, {
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
            transaction.set(newOwnAlertRef, {
                alertaId: newIncidentRef.id,
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
            return {
                incidentId: newIncidentRef.id,
                agrupada: false,
                reportes: 1,
                latitud,
                longitud,
                direccion,
                precisionMetros
            };
        });

        return result;
    }

    async function obtenerDireccionInversa(latitud, longitud) {
        if (typeof window.coalertaGeocodificarInverso !== "function") {
            console.warn("No está disponible el servicio de geocodificación inversa.");
            return "";
        }
        return window.coalertaGeocodificarInverso(latitud, longitud);
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
        const auditLogRef = doc(collection(db, "logs"));

        let patrolRef = null;
        let patrolSnapshot = null;
        if (["dispatch", "onsite", "close", "discard"].includes(action)) {
            let patrolId;
            if (action === "dispatch") {
                patrolId = String(payload.patrullaId || profile.patrullaId || "").trim();
            } else {
                const incidentForPatrol = await getDoc(incidentRef);
                if (!incidentForPatrol.exists()) throw new Error("No se encontró el incidente.");
                patrolId = String(incidentForPatrol.get("patrullaId") || "").trim();
            }
            if (!patrolId && action === "discard") {
                patrolRef = null;
            } else if (!patrolId || patrolId.length > 80) {
                throw new Error("El incidente no tiene un identificador de patrulla válido.");
            } else {
                patrolRef = doc(db, "patrullas", patrolId);
                patrolSnapshot = await getDoc(patrolRef);
            }
        }

        const result = await runTransaction(db, async (transaction) => {
            const incidentSnapshot = await transaction.get(incidentRef);
            if (!incidentSnapshot.exists()) throw new Error("No se encontró el incidente.");
            const current = incidentSnapshot.data();
            if (effectiveRole() === "coordinador" &&
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
                if (!patrolRef || patrolRef.id !== patrolId ||
                    !patrolSnapshot || !patrolSnapshot.exists()) {
                    throw new Error("No se encontró el registro operativo de la patrulla. Comparte nuevamente la ubicación GPS de la unidad.");
                }
                if (patrolSnapshot.get("estado") !== "Disponible") {
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
                if (!patrolRef || patrolRef.id !== current.patrullaId ||
                    !patrolSnapshot || !patrolSnapshot.exists() ||
                    patrolSnapshot.get("estado") !== "Despachado" ||
                    patrolSnapshot.get("incidenteId") !== id) {
                    throw new Error("La unidad no está despachada a este incidente.");
                }
                const patrol = patrolSnapshot.data();
                const updatedAt = patrol.updatedAt;
                const updatedAtMillis = updatedAt && typeof updatedAt.toMillis === "function"
                    ? updatedAt.toMillis()
                    : NaN;
                const updatedAtAge = Date.now() - updatedAtMillis;
                if (!Number.isFinite(updatedAtMillis) ||
                    updatedAtAge < -10000 || updatedAtAge > 2 * 60 * 1000 ||
                    !Number.isFinite(Number(patrol.precisionMetros)) ||
                    Number(patrol.precisionMetros) <= 0 ||
                    Number(patrol.precisionMetros) > 50000 ||
                    distanceMeters(current, patrol) > 15) {
                    throw new Error("La ubicación GPS debe ser reciente y estar a 15 m o menos del incidente.");
                }
                changes = { estado: "Agentes en sitio", enSitioAt: serverTimestamp() };
            } else if (action === "close" && current.estado === "Agentes en sitio") {
                if (!current.patrullaId) throw new Error("El incidente no tiene una unidad asignada.");
                if (!["administrador", "admin"].includes(state.role) &&
                    current.patrullaId !== profile.patrullaId) {
                    throw new Error("Solo la unidad asignada puede cerrar este incidente.");
                }
                if (!patrolRef || patrolRef.id !== current.patrullaId ||
                    !patrolSnapshot || !patrolSnapshot.exists() ||
                    patrolSnapshot.get("estado") !== "En sitio" ||
                    patrolSnapshot.get("incidenteId") !== id) {
                    throw new Error("La unidad no figura en sitio para este incidente.");
                }
                const outcome = String(payload.outcome || "");
                if (!["Delincuente retenido", "Intervención preventiva", "Falsa alarma"].includes(outcome)) {
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
            registrarLogAuditoria(
                transaction,
                auditLogRef,
                id,
                action,
                user.uid,
                obtenerCoordenadasAuditoria(action, patrolSnapshot, current),
                current,
                changes
            );
            transaction.set(publicRef, makePublicAlert(updated), { merge: true });
            const shouldReleaseDiscardedPatrol = action === "discard" &&
                patrolRef && patrolSnapshot && patrolSnapshot.exists() &&
                patrolSnapshot.get("incidenteId") === id &&
                ["Despachado", "En sitio"].includes(patrolSnapshot.get("estado"));
            if (patrolRef && patrolSnapshot && (
                ["dispatch", "onsite", "close"].includes(action) || shouldReleaseDiscardedPatrol
            )) {
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

    function obtenerCoordenadasAuditoria(action, patrolSnapshot, incident) {
        const location = ["dispatch", "onsite", "close"].includes(action) && patrolSnapshot
            ? patrolSnapshot.data()
            : incident;
        const latitud = Number(location && location.latitud);
        const longitud = Number(location && location.longitud);
        if (!Number.isFinite(latitud) || latitud < -90 || latitud > 90 ||
            !Number.isFinite(longitud) || longitud < -180 || longitud > 180) {
            throw new Error("No hay coordenadas válidas para registrar la auditoría.");
        }
        return { latitud, longitud };
    }

    function registrarLogAuditoria(
        transaction,
        logRef,
        alertaId,
        accion,
        usuarioId,
        coordenadas,
        incidente,
        cambios
    ) {
        // La retención de dos años requiere configurar Firestore TTL sobre expiresAt;
        // este comentario no configura ni garantiza por sí solo esa política.
        transaction.set(logRef, {
            alertaId,
            operadorId: usuarioId,
            patrullaId: cambios.patrullaId || incidente.patrullaId || null,
            accion,
            coordenadas,
            comunidadId: incidente.comunidadId,
            createdAt: serverTimestamp()
        });
    }

    async function publishOfficialNotice(template, incidentId) {
        const { user, profile } = requireRole(["coordinador", "administrador", "admin"]);
        const allowedTemplates = [
            "Emergencia Canalizada",
            "Sujeto Retenido por Autoridades",
            "Zona Segura",
            "Falsa alarma aclarada por autoridades"
        ];
        if (!allowedTemplates.includes(template)) throw new TypeError("Selecciona una plantilla oficial válida.");
        if (!profile.comunidadId && effectiveRole() === "coordinador") {
            throw new Error("Tu cuenta no tiene una comunidad asignada.");
        }
        const incidentRef = doc(db, "incidentes", String(incidentId || ""));
        const noticeRef = doc(collection(db, "avisos_publicos"));
        const result = await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(incidentRef);
            if (!snapshot.exists()) throw new Error("No se encontró el incidente seleccionado.");
            const incident = snapshot.data();
            const allowedResults = [
                "Delincuente retenido",
                "Persona detenida",
                "Falsa alarma",
                "Intervención preventiva",
                "Sujeto intervenido",
                "Sin novedad"
            ];
            if ((effectiveRole() === "coordinador" && incident.comunidadId !== profile.comunidadId) ||
                !incident.derivadaAt ||
                incident.estado !== "Emergencia Concluida" || !allowedResults.includes(incident.resultado)) {
                throw new Error("El comunicado solo puede vincularse a un incidente derivado y cerrado por seguridad.");
            }
            if ((incident.resultado === "Falsa alarma") !==
                (template === "Falsa alarma aclarada por autoridades")) {
                throw new Error("La plantilla no corresponde al resultado registrado por seguridad.");
            }
            const notice = {
                titulo: `Comunicado oficial · ${incident.tipo || "Incidente"}`,
                mensaje: `${template}. Resultado de revisión: ${incident.resultado}.`,
                plantilla: template,
                tipoIncidente: incident.tipo || "Incidente",
                incidenteId: snapshot.id,
                resultadoIncidente: incident.resultado,
                autorUid: user.uid,
                comunidadId: incident.comunidadId,
                timestamp: serverTimestamp()
            };
            transaction.set(noticeRef, notice);
            return { ok: true, avisoId: noticeRef.id, notice };
        });
        state.notices = [
            ...state.notices.filter((notice) => notice.id !== result.avisoId),
            { ...result.notice, id: result.avisoId, timestamp: new Date().toISOString() }
        ];
        dispatch("coalerta:avisos-actualizados", state.notices);
        return { ok: true, avisoId: result.avisoId };
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
        const patrolSnapshot = await getDoc(patrolRef);
        if (patrolSnapshot.exists()) {
            const previousIncidentId = patrolSnapshot.get("incidenteId");
            let releaseDiscardedIncident = false;
            if (["Despachado", "En sitio"].includes(patrolSnapshot.get("estado")) &&
                typeof previousIncidentId === "string" && previousIncidentId) {
                const previousIncidentSnapshot = await getDoc(doc(db, "incidentes", previousIncidentId));
                releaseDiscardedIncident = previousIncidentSnapshot.exists() &&
                    previousIncidentSnapshot.get("estado") === "Descartada" &&
                    previousIncidentSnapshot.get("patrullaId") === patrolId;
            }
            const locationTimestamp = serverTimestamp();
            const batch = writeBatch(db);
            const patrolUpdate = {
                comunidadId,
                agenteUid: user.uid,
                latitud: location.latitud,
                longitud: location.longitud,
                precisionMetros: location.precisionMetros,
                updatedAt: locationTimestamp
            };
            if (releaseDiscardedIncident) {
                patrolUpdate.estado = "Disponible";
                patrolUpdate.incidenteId = null;
            }
            batch.update(patrolRef, patrolUpdate);
            batch.update(profileRef, {
                ultimaUbicacion: {
                    latitud: location.latitud,
                    longitud: location.longitud,
                    timestamp: locationTimestamp
                }
            });
            await batch.commit();
            return { ok: true, patrullaId: patrolId };
        }

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
                const patrol = snapshot.data();
                if ((patrol.estado === undefined || patrol.estado === null) &&
                    !patrol.incidenteId) {
                    updated.estado = "Disponible";
                }
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
        if (!nombre || !/^9\d{8}$/.test(telefono)) {
            throw new Error("El nombre o teléfono del perfil no es válido para actualizar el contacto comunitario.");
        }
        if (memberSnapshot.get("nombre") !== nombre || memberSnapshot.get("telefono") !== telefono) {
            await updateDoc(memberRef, { nombre, telefono });
        }
        if (Array.isArray(profile.contactosEmergencia)) {
            await synchronizeCommunityEmergencyContacts(uid, communityId, profile.contactosEmergencia);
        }
    }

    function normalizeEmergencyContacts(contacts) {
        if (!Array.isArray(contacts) || contacts.length > 2) {
            throw new TypeError("Puedes guardar hasta dos contactos.");
        }
        const sanitized = contacts.map((contact) => ({
            nombre: String(contact && contact.nombre || "").trim(),
            telefono: String(contact && contact.telefono || "").trim()
        }));
        if (sanitized.some((contact) => !contact.nombre || contact.nombre.length > 80 ||
            !/^9\d{8}$/.test(contact.telefono))) {
            throw new TypeError("Cada contacto debe tener un nombre y un celular válido que empiece con 9 y tenga 9 dígitos.");
        }
        return sanitized;
    }

    async function synchronizeCommunityEmergencyContacts(uid, communityId, contacts) {
        const sanitized = normalizeEmergencyContacts(contacts);
        const contactsRef = doc(db, "comunidades", communityId, "contactos_emergencia", uid);
        const snapshot = await getDoc(contactsRef);
        const currentContacts = snapshot.exists() ? snapshot.get("contactos") : null;
        if (JSON.stringify(currentContacts) === JSON.stringify(sanitized)) return;
        await setDoc(contactsRef, { contactos: sanitized });
    }

    async function synchronizeCurrentCommunityMemberProfile(profileUpdates) {
        const { user, profile } = requireActiveProfile();
        if (!profile.comunidadId || !["vecino", "seguridad"].includes(state.role)) return;
        await synchronizeCommunityMemberProfile(user.uid, profile.comunidadId, {
            ...profile,
            ...profileUpdates
        });
    }

    function synchronizeOwnIncidentsToCommunity(uid = state.uid, communityId = state.profile && state.profile.comunidadId) {
        if (!uid || !communityId) return Promise.resolve(0);
        const syncKey = `${uid}:${communityId}`;
        const existingSync = communityIncidentSyncs.get(syncKey);
        if (existingSync) return existingSync;

        const sync = (async () => {
            const snapshot = await getDocs(query(
                collection(db, "incidentes"),
                where("reporterUids", "array-contains", uid)
            ));
            const unassignedIncidents = snapshot.docs.filter((incident) => {
                const assignedCommunity = incident.get("comunidadId");
                return assignedCommunity === null || assignedCommunity === undefined ||
                    assignedCommunity === "";
            });
            let synchronized = 0;
            for (const incident of unassignedIncidents) {
                const publicRef = doc(db, "alertas_publicas", incident.id);
                const updated = await runTransaction(db, async (transaction) => {
                    const currentIncident = await transaction.get(incident.ref);
                    if (!currentIncident.exists()) return false;
                    const assignedCommunity = currentIncident.get("comunidadId");
                    if (assignedCommunity !== null && assignedCommunity !== undefined &&
                        assignedCommunity !== "") return false;
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
        })();
        communityIncidentSyncs.set(syncKey, sync);
        return sync.finally(() => {
            if (communityIncidentSyncs.get(syncKey) === sync) {
                communityIncidentSyncs.delete(syncKey);
            }
        });
    }

    async function saveCoverageZone(zone) {
        const { user, profile } = requireRole(["coordinador", "administrador", "admin"]);
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
        const communityId = String(profile.comunidadId || "").trim();
        const substituteUid = String(delegation && delegation.suplenteUid || "").trim();
        const start = new Date(delegation && delegation.inicio);
        const end = new Date(delegation && delegation.fin);
        if (!communityId) throw new Error("Tu cuenta no tiene una comunidad asignada.");
        if (!substituteUid || substituteUid === user.uid) {
            throw new TypeError("Selecciona un vecino distinto de tu cuenta.");
        }
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
            start.getTime() <= Date.now() || end <= start) {
            throw new TypeError("El inicio debe ser futuro y el fin debe ser posterior al inicio.");
        }
        if (end.getTime() - start.getTime() > 31 * 86400000) {
            throw new TypeError("La delegación no puede durar más de 31 días.");
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
        if (["pagina-mapa", "pagina-comunidad", "pagina-seguridad"]
            .some(hasPageClass)) {
            watchCommunityMembers(comunidadId);
        }
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
        const { profile } = requireRole(["coordinador"]);
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
        const { user, profile } = requireActiveProfile();
        const sanitized = normalizeEmergencyContacts(contacts);
        const profileRef = doc(db, "usuarios", user.uid);
        const outgoingMessageRefs = sanitized.map(() => doc(collection(db, "mensajes_salientes")));
        await runTransaction(db, async (transaction) => {
            transaction.set(profileRef, { contactosEmergencia: sanitized }, { merge: true });
            if (profile.comunidadId) {
                transaction.set(
                    doc(db, "comunidades", profile.comunidadId, "contactos_emergencia", user.uid),
                    { contactos: sanitized }
                );
            }
            sanitized.forEach((contact, index) => {
                transaction.set(outgoingMessageRefs[index], {
                    ...contact,
                    usuarioId: user.uid,
                    tipo: "asignacion_contacto_emergencia",
                    estado: "pendiente",
                    creadoEn: serverTimestamp()
                });
            });
        });
        return { ok: true, notificationSent: false, notificationQueued: sanitized.length };
    }

    async function getCommunityMemberEmergencyContacts(uid) {
        const { profile } = requireRole(["coordinador", "seguridad"]);
        const memberUid = String(uid || "").trim();
        if (!profile.comunidadId || !memberUid) {
            throw new TypeError("No se pudo identificar al miembro de la comunidad.");
        }
        const contactsRef = doc(db, "comunidades", profile.comunidadId, "contactos_emergencia", memberUid);
        const snapshot = await getDoc(contactsRef);
        if (!snapshot.exists()) return [];
        const contacts = snapshot.get("contactos");
        if (!Array.isArray(contacts)) {
            throw new Error("El formato de los contactos de emergencia del miembro no es válido.");
        }
        return contacts;
    }

    async function deleteAccount(dni) {
        const user = auth.currentUser;
        if (!user) throw new Error("Inicia sesión con la cuenta que deseas eliminar.");
        const profileRef = doc(db, "usuarios", user.uid);
        const profileSnapshot = await getDoc(profileRef);
        if (!profileSnapshot.exists()) return { ok: true, profileAlreadyDeleted: true };
        const profile = profileSnapshot.data();
        if (profile.activo !== true) throw new Error("La cuenta no está activa.");
        if (!["vecino", "coordinador", "seguridad", "agente"].includes(profile.rol)) {
            throw new Error("Este tipo de cuenta no puede eliminarse desde el perfil.");
        }
        if (profile.patrullaId) {
            throw new Error(
                "Antes de eliminar esta cuenta, solicita al administrador que retire la unidad asignada."
            );
        }
        const value = String(dni || "").trim();
        if (!/^\d{8}$/.test(value)) throw new TypeError("Ingresa un DNI válido de 8 dígitos.");
        if (String(profile.dni || "").trim() !== value) {
            throw new Error("El DNI no coincide con la cuenta activa. No se eliminó la cuenta.");
        }

        let communityId = String(profile.comunidadId || "").trim();
        if (profile.rol === "coordinador" && !communityId) {
            communityId = await ensureCoordinatorCommunity(user, profile);
        }
        const communityRef = profile.rol === "coordinador" && communityId
            ? doc(db, "comunidades", communityId)
            : null;
        if (profile.rol === "coordinador" && communityId) {
            await registerCommunityCoordinator(user.uid, communityId);
            const communitySnapshot = await getDoc(communityRef);
            const successorUid = communitySnapshot.get("coordinadorUid") === user.uid
                ? communitySnapshot.get("coordinadorAlternoUid")
                : communitySnapshot.get("coordinadorUid");
            if (!successorUid || successorUid === user.uid) {
                throw new Error(
                    "No puedes eliminar la cuenta porque eres el único coordinador registrado. " +
                    "Pide al administrador que habilite a otro coordinador y que esa persona inicie sesión antes de continuar."
                );
            }
        }

        if (communityId) {
            const memberRef = doc(db, "comunidades", communityId, "miembros", user.uid);
            const contactsRef = doc(db, "comunidades", communityId, "contactos_emergencia", user.uid);
            const [memberSnapshot, contactsSnapshot] = await Promise.all([
                getDoc(memberRef),
                getDoc(contactsRef)
            ]);
            if (memberSnapshot.exists()) await deleteDoc(memberRef);
            if (contactsSnapshot.exists()) await deleteDoc(contactsRef);

            const announcements = await getDocs(query(
                collection(db, "comunidades", communityId, "anuncios"),
                where("autorUid", "==", user.uid)
            ));
            for (const announcement of announcements.docs) {
                await updateDoc(announcement.ref, {
                    autorUid: null,
                    autorNombre: "Usuario eliminado"
                });
            }

            const zoneRef = doc(db, "zonas", communityId);
            const zoneSnapshot = await getDoc(zoneRef);
            if (zoneSnapshot.exists() && zoneSnapshot.get("updatedBy") === user.uid) {
                await updateDoc(zoneRef, {
                    updatedBy: null,
                    updatedAt: serverTimestamp()
                });
            }

            const delegationRef = doc(db, "delegaciones", communityId);
            const delegationSnapshot = await getDoc(delegationRef);
            if (delegationSnapshot.exists()) {
                if (delegationSnapshot.get("coordinadorUid") === user.uid) {
                    await deleteDoc(delegationRef);
                } else if (delegationSnapshot.get("suplenteUid") === user.uid) {
                    await updateDoc(delegationRef, { suplenteUid: null });
                }
            }

            const notices = await getDocs(query(
                collection(db, "avisos_publicos"),
                where("comunidadId", "==", communityId),
                where("autorUid", "==", user.uid)
            ));
            for (const notice of notices.docs) {
                await updateDoc(notice.ref, { autorUid: null });
            }

            const auditLogs = await getDocs(query(
                collection(db, "logs"),
                where("comunidadId", "==", communityId),
                where("operadorId", "==", user.uid)
            ));
            for (const log of auditLogs.docs) {
                await updateDoc(log.ref, { operadorId: null });
            }

            if (["seguridad", "agente"].includes(profile.rol)) {
                const patrols = await getDocs(query(
                    collection(db, "patrullas"),
                    where("comunidadId", "==", communityId),
                    where("agenteUid", "==", user.uid)
                ));
                for (const patrol of patrols.docs) {
                    await updateDoc(patrol.ref, {
                        agenteUid: null,
                        latitud: null,
                        longitud: null,
                        precisionMetros: null,
                        updatedAt: serverTimestamp()
                    });
                }
            }
        }

        const reportedIncidents = await getDocs(query(
            collection(db, "incidentes"),
            where("reporterUids", "array-contains", user.uid)
        ));
        const resolvedIncidents = await getDocs(query(
            collection(db, "incidentes"),
            where("resueltoPorUid", "==", user.uid)
        ));
        const incidents = new Map();
        [...reportedIncidents.docs, ...resolvedIncidents.docs].forEach((incident) => {
            incidents.set(incident.id, incident);
        });
        for (const incident of incidents.values()) {
            await deleteDoc(doc(db, "incidentes", incident.id, "calificaciones", user.uid));
            await runTransaction(db, async (transaction) => {
                const currentSnapshot = await transaction.get(incident.ref);
                if (!currentSnapshot.exists()) return;
                const current = currentSnapshot.data();
                const reporters = current.reporterUids;
                const changes = {};
                if (Array.isArray(reporters) && reporters.includes(user.uid)) {
                    changes.reporterUids = reporters.filter((uid) => uid !== user.uid);
                    changes.ultimaAgrupacionUid = current.ultimaAgrupacionUid === user.uid
                        ? null
                        : current.ultimaAgrupacionUid || null;
                }
                if (current.resueltoPorUid === user.uid) changes.resueltoPorUid = null;
                if (Object.keys(changes).length) transaction.update(incident.ref, changes);
            });
        }

        const ownAlerts = await getDocs(query(
            collection(db, "alertas"),
            where("creadorId", "==", user.uid)
        ));
        for (const alert of ownAlerts.docs) {
            await updateDoc(alert.ref, { creadorId: null });
        }

        const createdInvitations = await getDocs(query(
            collection(db, "invitaciones"),
            where("creadoPor", "==", user.uid)
        ));
        const usedInvitations = await getDocs(query(
            collection(db, "invitaciones"),
            where("usadoPor", "==", user.uid)
        ));
        const invitations = new Map();
        [...createdInvitations.docs, ...usedInvitations.docs].forEach((invitation) => {
            invitations.set(invitation.id, invitation);
        });
        for (const invitation of invitations.values()) {
            const changes = {};
            if (invitation.get("creadoPor") === user.uid) {
                changes.creadoPor = null;
                changes.activo = false;
            }
            if (invitation.get("usadoPor") === user.uid) changes.usadoPor = null;
            if (Object.keys(changes).length) await updateDoc(invitation.ref, changes);
        }

        const outgoingMessages = await getDocs(query(
            collection(db, "mensajes_salientes"),
            where("usuarioId", "==", user.uid)
        ));
        await deleteAccountDocuments(outgoingMessages.docs);

        const userCollections = ["alertas", "alertas_leidas", "avisos_leidos"];
        for (const collectionName of userCollections) {
            const documents = await getDocs(collection(profileRef, collectionName));
            await deleteAccountDocuments(documents.docs);
        }
        await deleteDoc(doc(db, "usuarios", user.uid, "limites", "reportes_emergencia"));
        await deleteDoc(doc(db, "limites_alertas_abiertas", user.uid));
        const dniRef = profile.dni ? doc(db, "dni_index", String(profile.dni)) : null;
        await runTransaction(db, async (transaction) => {
            const currentProfile = await transaction.get(profileRef);
            const communitySnapshot = communityRef
                ? await transaction.get(communityRef)
                : null;
            const dniSnapshot = dniRef ? await transaction.get(dniRef) : null;
            if (!currentProfile.exists()) return;
            if (currentProfile.get("activo") !== true) {
                throw new Error("La cuenta ya no está activa y no se puede eliminar desde esta sesión.");
            }
            if (communityRef && communitySnapshot && communitySnapshot.exists()) {
                const currentCoordinator = communitySnapshot.get("coordinadorUid");
                const currentAlternate = communitySnapshot.get("coordinadorAlternoUid");
                if (currentCoordinator === user.uid) {
                    if (!currentAlternate || currentAlternate === user.uid) {
                        throw new Error("La comunidad necesita otro coordinador antes de eliminar esta cuenta.");
                    }
                    transaction.update(communityRef, {
                        coordinadorUid: currentAlternate,
                        coordinadorAlternoUid: null,
                        updatedAt: serverTimestamp()
                    });
                } else if (currentAlternate === user.uid) {
                    transaction.update(communityRef, {
                        coordinadorAlternoUid: null,
                        updatedAt: serverTimestamp()
                    });
                }
            }
            if (dniRef && dniSnapshot && dniSnapshot.exists()) transaction.delete(dniRef);
            transaction.delete(profileRef);
        });
        state.ready = false;
        state.profile = null;
        return { ok: true, profileAlreadyDeleted: false };
    }

    async function deleteAccountDocuments(documents) {
        const batchSize = 400;
        for (let index = 0; index < documents.length; index += batchSize) {
            const batch = writeBatch(db);
            documents.slice(index, index + batchSize).forEach((document) => {
                batch.delete(document.ref);
            });
            await batch.commit();
        }
    }

    window.coalertaData = {
        isReady: () => state.ready,
        isRegistrationIncomplete: () => state.registrationIncomplete,
        waitForReady,
        getProfile: () => state.profile,
        getRole: () => effectiveRole(),
        isDelegationReady: () => state.delegationReady,
        refreshCurrentProfile,
        getAlerts,
        getIncidents,
        getMyAlerts,
        watchAssignedPatrolLocation,
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
        categoryCode,
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
        getCommunityMemberEmergencyContacts,
        deleteAccount
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
