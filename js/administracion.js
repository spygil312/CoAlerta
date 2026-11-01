import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection, doc, getDoc, getDocs, onSnapshot, query,
    runTransaction, serverTimestamp, updateDoc, writeBatch, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

const ADMIN_EMAIL = "mailig.lebam@gmail.com";
const DEFAULT_COMMUNITY_ID = "comunidad_general_1";
const aviso = document.getElementById("avisoAdministracion");
const panel = document.getElementById("panelSolicitudes");
const lista = document.getElementById("listaSolicitudes");
const cantidad = document.getElementById("cantidadSolicitudes");
const botonActualizar = document.getElementById("actualizarSolicitudes");
const asignacionesPanel = document.getElementById("panelAsignacionUnidades");
const listaAsignaciones = document.getElementById("listaAsignacionUnidades");
const estadoUnidades = document.getElementById("estadoUnidades");
const botonInicializarUnidades = document.getElementById("inicializarUnidades");
let stopWatchingRequests = null;
let stopWatchingSecurityStaff = null;
let stopWatchingUnits = null;
let securityStaff = [];
let units = [];

if (aviso && panel && lista && cantidad && botonActualizar) {
    onAuthStateChanged(auth, async (user) => {
        if (!user || String(user.email || "").toLowerCase() !== ADMIN_EMAIL) {
            stopAdminListeners();
            panel.hidden = true;
            if (asignacionesPanel) asignacionesPanel.hidden = true;
            botonActualizar.disabled = true;
            if (botonInicializarUnidades) botonInicializarUnidades.disabled = true;
            setNotice("No tienes autorización para acceder a este panel.", "error");
            return;
        }

        botonActualizar.disabled = true;
        if (botonInicializarUnidades) botonInicializarUnidades.disabled = true;
        setNotice("Verificando y habilitando la cuenta administradora…");
        try {
            const profileRef = doc(db, "usuarios", user.uid);
            const profileSnapshot = await getDoc(profileRef);
            if (!profileSnapshot.exists() || profileSnapshot.get("activo") !== true) {
                throw new Error("La cuenta autorizada no tiene un perfil activo en Firestore.");
            }
            if (profileSnapshot.get("rol") === "coordinador") {
                await updateDoc(profileRef, { rol: "administrador" });
            } else if (!["administrador", "admin"].includes(profileSnapshot.get("rol"))) {
                throw new Error(
                    `La cuenta autorizada debe tener el rol coordinador o administrador. ` +
                    `El perfil tiene el rol "${profileSnapshot.get("rol") || "sin rol"}".`
                );
            }

            panel.hidden = false;
            if (asignacionesPanel) asignacionesPanel.hidden = false;
            botonActualizar.disabled = false;
            if (botonInicializarUnidades) botonInicializarUnidades.disabled = false;
            loadRequests();
            loadUnitAssignments();
        } catch (error) {
            console.error("No se pudo habilitar la cuenta administradora:", error);
            panel.hidden = true;
            if (asignacionesPanel) asignacionesPanel.hidden = true;
            setNotice(error.message || getErrorMessage(error), "error");
        }
    });

    botonActualizar.addEventListener("click", loadRequests);
    if (botonInicializarUnidades) {
        botonInicializarUnidades.addEventListener("click", initializeUnits);
    }
}

function stopAdminListeners() {
    [stopWatchingRequests, stopWatchingSecurityStaff, stopWatchingUnits].forEach((stop) => {
        if (stop) stop();
    });
    stopWatchingRequests = null;
    stopWatchingSecurityStaff = null;
    stopWatchingUnits = null;
}

function loadRequests() {
    if (!auth.currentUser || String(auth.currentUser.email || "").toLowerCase() !== ADMIN_EMAIL) return;
    if (stopWatchingRequests) stopWatchingRequests();
    botonActualizar.disabled = true;
    setNotice("Sincronizando solicitudes pendientes…");
    lista.replaceChildren();

    stopWatchingRequests = onSnapshot(query(
        collection(db, "usuarios"),
        where("estadoSolicitudRol", "==", "pendiente")
    ), (requests) => {
        const pending = requests.docs
            .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
            .filter((request) =>
                request.rol === "vecino" &&
                ["coordinador", "seguridad"].includes(request.rolSolicitud)
            )
            .sort((first, second) => getTimestamp(second.fechaRegistro) - getTimestamp(first.fechaRegistro));

        cantidad.textContent = `${pending.length} ${pending.length === 1 ? "solicitud" : "solicitudes"}`;
        if (!pending.length) {
            lista.append(createEmptyState("No hay solicitudes pendientes."));
            setNotice("No hay solicitudes pendientes de revisión.", "correcto");
            botonActualizar.disabled = false;
            return;
        }

        pending.forEach((request) => lista.append(createRequestCard(request)));
        setNotice("Solicitudes cargadas. Solo esta cuenta autorizada puede resolverlas.", "correcto");
        botonActualizar.disabled = false;
    }, (error) => {
        console.error("No se pudieron cargar las solicitudes de rol:", error);
        setNotice(getErrorMessage(error), "error");
        botonActualizar.disabled = false;
    });
}

function loadUnitAssignments() {
    if (!auth.currentUser || String(auth.currentUser.email || "").toLowerCase() !== ADMIN_EMAIL) return;
    if (stopWatchingSecurityStaff) stopWatchingSecurityStaff();
    if (stopWatchingUnits) stopWatchingUnits();
    if (estadoUnidades) estadoUnidades.textContent = "Cargando unidades y personal aprobado…";

    stopWatchingSecurityStaff = onSnapshot(query(
        collection(db, "usuarios"),
        where("rol", "==", "seguridad")
    ), (snapshot) => {
        securityStaff = snapshot.docs
            .map((profile) => ({ uid: profile.id, ...profile.data() }))
            .filter((profile) => profile.activo === true &&
                profile.estadoSolicitudRol === "aprobada")
            .sort((first, second) => displayName(first).localeCompare(displayName(second), "es"));
        renderUnitAssignments();
    }, (error) => {
        console.error("No se pudo cargar el personal de seguridad:", error);
        if (estadoUnidades) estadoUnidades.textContent = getErrorMessage(error);
    });

    stopWatchingUnits = onSnapshot(collection(db, "unidades"), (snapshot) => {
        units = snapshot.docs
            .map((unit) => ({ id: unit.id, ...unit.data() }))
            .sort((first, second) => first.id.localeCompare(second.id));
        renderUnitAssignments();
    }, (error) => {
        console.error("No se pudieron cargar las unidades:", error);
        if (estadoUnidades) estadoUnidades.textContent = getErrorMessage(error);
    });
}

async function initializeUnits() {
    if (!auth.currentUser || String(auth.currentUser.email || "").toLowerCase() !== ADMIN_EMAIL) return;
    botonInicializarUnidades.disabled = true;
    if (estadoUnidades) estadoUnidades.textContent = "Preparando unidades predeterminadas…";
    let stage = "validar el perfil administrador";
    let adminProfile;
    try {
        const adminSnapshot = await getDoc(doc(db, "usuarios", auth.currentUser.uid));
        if (!adminSnapshot.exists()) {
            throw new Error("No existe tu perfil en Firestore. No se crearon unidades.");
        }
        adminProfile = adminSnapshot.data();
        if (adminProfile.activo !== true ||
            !["administrador", "admin"].includes(adminProfile.rol)) {
            throw new Error(
                `Tu perfil debe tener activo: true y rol "administrador" o "admin" para preparar unidades. ` +
                `Ahora figura activo: ${String(adminProfile.activo)}, rol: "${adminProfile.rol || "sin rol"}".`
            );
        }

        stage = "leer perfiles de seguridad";
        const profilesSnapshot = await getDocs(query(
            collection(db, "usuarios"),
            where("rol", "==", "seguridad")
        ));
        const assignedUnits = new Map();
        profilesSnapshot.docs.forEach((profile) => {
            if (profile.get("rol") !== "seguridad" ||
                profile.get("activo") !== true ||
                profile.get("estadoSolicitudRol") !== "aprobada") return;
            const assignedId = String(profile.get("patrullaId") || "");
            if (!/^Unidad-(?:0[1-9]|10)$/.test(assignedId)) return;
            if (assignedUnits.has(assignedId) && assignedUnits.get(assignedId) !== profile.id) {
                throw new Error(`Hay más de un perfil asignado a ${assignedId}. Resuelve esa duplicación antes de inicializar.`);
            }
            assignedUnits.set(assignedId, profile.id);
        });

        stage = "leer el inventario de unidades";
        const unitsSnapshot = await getDocs(collection(db, "unidades"));
        const existingIds = new Set(unitsSnapshot.docs.map((unit) => unit.id));
        const batch = writeBatch(db);
        let created = 0;
        for (let number = 1; number <= 10; number += 1) {
            const id = `Unidad-${String(number).padStart(2, "0")}`;
            if (existingIds.has(id)) continue;
            const uid = assignedUnits.get(id) || null;
            batch.set(doc(db, "unidades", id), {
                estado: uid ? "ocupada" : "disponible",
                asignadaA: uid
            });
            created += 1;
        }
        stage = "crear las unidades que faltan";
        if (created) await batch.commit();
        if (estadoUnidades) {
            estadoUnidades.textContent = created
                ? `Inicialización completada: se crearon ${created} unidad(es) sin sobrescribir las existentes.`
                : "Las 10 unidades ya estaban inicializadas.";
        }
    } catch (error) {
        console.error("No se pudieron inicializar las unidades:", error);
        if (estadoUnidades) {
            estadoUnidades.textContent = error.code === "permission-denied"
                ? `Firebase denegó el permiso al ${stage}. La cuenta debe ser ${ADMIN_EMAIL} y su perfil usuarios/{uid} debe tener activo: true y rol "administrador" o "admin". No se confirmó ningún cambio.`
                : error.message || "No se pudieron preparar las unidades. Inténtalo nuevamente.";
        }
    } finally {
        botonInicializarUnidades.disabled = false;
    }
}

function renderUnitAssignments() {
    if (!listaAsignaciones || !estadoUnidades) return;
    listaAsignaciones.replaceChildren();
    estadoUnidades.textContent = `${units.length} unidad(es) · ${securityStaff.length} personal aprobado`;
    if (!units.length) {
        listaAsignaciones.append(createEmptyState("Inicializa las 10 unidades para comenzar a asignarlas."));
        return;
    }
    if (!securityStaff.length) {
        listaAsignaciones.append(createEmptyState("No hay personal de seguridad aprobado para asignar."));
        return;
    }
    securityStaff.forEach((profile) => listaAsignaciones.append(createUnitAssignmentCard(profile)));
}

function createUnitAssignmentCard(profile) {
    const card = document.createElement("article");
    card.className = "administracion-solicitud";
    const details = document.createElement("div");
    details.className = "administracion-solicitud-datos";
    const name = document.createElement("h3");
    name.textContent = displayName(profile);
    const email = document.createElement("p");
    email.textContent = profile.correo || "Correo no disponible";
    const currentUnit = units.find((unit) =>
        unit.id === profile.patrullaId && unit.asignadaA === profile.uid
    );
    const assignment = document.createElement("span");
    assignment.className = "administracion-rol";
    assignment.textContent = currentUnit ? `Unidad asignada: ${currentUnit.id}` : "Sin unidad asignada";
    details.append(name, email, assignment);

    const actions = document.createElement("div");
    actions.className = "administracion-asignar-acciones";
    const select = document.createElement("select");
    select.className = "administracion-unidad-select";
    select.setAttribute("aria-label", `Unidad para ${displayName(profile)}`);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Selecciona una unidad disponible";
    select.append(placeholder);
    units.filter((unit) => unit.estado === "disponible" && !unit.asignadaA)
        .forEach((unit) => {
            const option = document.createElement("option");
            option.value = unit.id;
            option.textContent = unit.id;
            select.append(option);
        });
    const assign = document.createElement("button");
    assign.type = "button";
    assign.className = "administracion-aprobar";
    assign.textContent = "Asignar unidad";
    assign.disabled = select.options.length < 2;
    assign.addEventListener("click", () => assignUnit(profile.uid, select.value, assign));
    actions.append(select, assign);
    card.append(details, actions);
    return card;
}

async function assignUnit(uid, unitId, button) {
    if (!auth.currentUser || String(auth.currentUser.email || "").toLowerCase() !== ADMIN_EMAIL) return;
    if (!/^Unidad-(?:0[1-9]|10)$/.test(unitId)) {
        if (estadoUnidades) estadoUnidades.textContent = "Selecciona una unidad válida.";
        return;
    }
    const card = button.closest(".administracion-solicitud");
    const cardButtons = card.querySelectorAll("button, select");
    cardButtons.forEach((item) => { item.disabled = true; });
    if (estadoUnidades) estadoUnidades.textContent = `Asignando ${unitId}…`;
    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "usuarios", uid);
            const unitRef = doc(db, "unidades", unitId);
            const userSnapshot = await transaction.get(userRef);
            const unitSnapshot = await transaction.get(unitRef);
            if (!userSnapshot.exists() || userSnapshot.get("rol") !== "seguridad" ||
                userSnapshot.get("activo") !== true ||
                userSnapshot.get("estadoSolicitudRol") !== "aprobada") {
                throw new Error("El perfil ya no es personal de seguridad aprobado y activo.");
            }
            if (!unitSnapshot.exists() || unitSnapshot.get("estado") !== "disponible" ||
                unitSnapshot.get("asignadaA") !== null) {
                throw new Error("La unidad ya no está disponible. Actualiza la lista.");
            }
            const previousId = String(userSnapshot.get("patrullaId") || "");
            const previousRef = previousId && previousId !== unitId
                ? doc(db, "unidades", previousId)
                : null;
            const previousSnapshot = previousRef ? await transaction.get(previousRef) : null;
            if (previousSnapshot && previousSnapshot.exists() &&
                previousSnapshot.get("asignadaA") !== uid) {
                throw new Error("La unidad anterior está asignada a otro perfil; revisa el inventario.");
            }

            if (previousSnapshot && previousSnapshot.exists()) {
                transaction.update(previousRef, { estado: "disponible", asignadaA: null });
            }
            transaction.update(unitRef, { estado: "ocupada", asignadaA: uid });
            transaction.update(userRef, {
                patrullaId: unitId,
                codigoPatrulla: unitId,
                fechaAsignacion: serverTimestamp()
            });
        });
        if (estadoUnidades) estadoUnidades.textContent = `${unitId} asignada correctamente.`;
    } catch (error) {
        console.error("No se pudo asignar la unidad:", error);
        if (estadoUnidades) estadoUnidades.textContent = getErrorMessage(error);
        cardButtons.forEach((item) => { item.disabled = false; });
    }
}

function displayName(profile) {
    return profile.nombre || [profile.nombres, profile.apellidos].filter(Boolean).join(" ") || "Usuario";
}

function createRequestCard(request) {
    const card = document.createElement("article");
    card.className = "administracion-solicitud";
    const details = document.createElement("div");
    details.className = "administracion-solicitud-datos";

    const name = document.createElement("h3");
    name.textContent = request.nombre || [request.nombres, request.apellidos].filter(Boolean).join(" ") || "Usuario";
    const email = document.createElement("p");
    email.textContent = request.correo || "Correo no disponible";
    const role = document.createElement("span");
    role.className = "administracion-rol";
    role.textContent = request.rolSolicitud === "coordinador"
        ? "Coordinador vecinal"
        : "Personal de seguridad";
    details.append(name, email, role);

    const actions = document.createElement("div");
    actions.className = "administracion-acciones";
    actions.append(
        createDecisionButton("Aprobar", "administracion-aprobar", request, true),
        createDecisionButton("Rechazar", "administracion-rechazar", request, false)
    );
    card.append(details, actions);
    return card;
}

function createDecisionButton(label, className, request, approve) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", async () => {
        const card = button.closest(".administracion-solicitud");
        const buttons = card.querySelectorAll("button");
        buttons.forEach((item) => { item.disabled = true; });
        setNotice(`${approve ? "Aprobando" : "Rechazando"} la solicitud…`);

        try {
            await runTransaction(db, async (transaction) => {
                const profileRef = doc(db, "usuarios", request.id);
                const snapshot = await transaction.get(profileRef);
                if (!snapshot.exists()) throw new Error("El perfil de esta solicitud ya no existe.");
                const profile = snapshot.data();
                if (profile.rol !== "vecino" ||
                    profile.estadoSolicitudRol !== "pendiente" ||
                    profile.rolSolicitud !== request.rolSolicitud) {
                    throw new Error("La solicitud ya fue atendida o cambió. Actualiza la lista.");
                }
                const changes = {
                    rol: approve ? profile.rolSolicitud : "vecino",
                    estadoSolicitudRol: approve ? "aprobada" : "rechazada"
                };
                if (approve && profile.rolSolicitud === "coordinador") {
                    changes.comunidadId = DEFAULT_COMMUNITY_ID;
                }
                transaction.update(profileRef, changes);
            });
            setNotice(`Solicitud ${approve ? "aprobada" : "rechazada"} correctamente.`, "correcto");
        } catch (error) {
            console.error("No se pudo resolver la solicitud de rol:", error);
            setNotice(getErrorMessage(error), "error");
            buttons.forEach((item) => { item.disabled = false; });
        }
    });
    return button;
}

function createEmptyState(message) {
    const empty = document.createElement("p");
    empty.className = "administracion-vacio";
    empty.textContent = message;
    return empty;
}

function getTimestamp(value) {
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    const parsed = new Date(value || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function setNotice(message, state = "") {
    aviso.textContent = message;
    if (state) aviso.dataset.estado = state;
    else delete aviso.dataset.estado;
}

function getErrorMessage(error) {
    if (error.code === "permission-denied") {
        return "Firebase denegó el acceso. Confirma que las reglas actualizadas estén desplegadas y que iniciaste sesión con la cuenta autorizada.";
    }
    return error.message || "No se pudo completar la operación. Inténtalo nuevamente.";
}