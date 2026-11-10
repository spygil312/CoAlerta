const roleLabels = {
    vecino: "Vecino",
    residente: "Vecino",
    coordinador: "Coordinador vecinal",
    seguridad: "Personal de seguridad",
    agente: "Personal de seguridad"
};

const requestedRoleLabels = {
    coordinador: "Coordinador vecinal",
    seguridad: "Personal de seguridad"
};

export function formatearRolVisible(usuario) {
    const profile = usuario || {};
    const value = String(profile.rol || "vecino").trim();
    const normalized = value.toLocaleLowerCase();
    const role = roleLabels[normalized] ||
        (["vecino / residente", "vecino/residente"].includes(normalized)
            ? "Vecino"
            : value.charAt(0).toLocaleUpperCase() + value.slice(1));

    if (normalized === "vecino" &&
        profile.estadoSolicitudRol === "pendiente" &&
        profile.rolSolicitud) {
        const requestedRole = String(profile.rolSolicitud);
        const label = requestedRoleLabels[requestedRole.toLocaleLowerCase()] || requestedRole;
        return `${label} (pendiente)`;
    }
    return role;
}

export function establecerTexto(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

export function configurarCierreSesion({
    auth,
    signOut,
    buttonIds = ["btnCerrarSesionLateral"],
    confirmationMessage = null,
    clearCachedSession = false,
    disableWhileSigningOut = false,
    replaceLocation = false,
    beforeSignOut = null,
    errorMessage = null
}) {
    buttonIds.forEach((id) => {
        const button = document.getElementById(id);
        if (!button) return;

        button.addEventListener("click", async (event) => {
            event.preventDefault();
            if (confirmationMessage && !window.confirm(confirmationMessage)) return;

            if (disableWhileSigningOut) button.disabled = true;
            try {
                if (beforeSignOut) await beforeSignOut();
                if (auth.currentUser) await signOut(auth);
                if (clearCachedSession) {
                    localStorage.removeItem("coalerta_usuario");
                    localStorage.removeItem("coalertaSesion");
                }
                if (replaceLocation) {
                    window.location.replace("login.html");
                } else {
                    window.location.href = "login.html";
                }
            } catch (error) {
                console.error("No se pudo cerrar la sesión:", error);
                window.alert(typeof errorMessage === "function"
                    ? errorMessage(error)
                    : "No se pudo cerrar la sesión. Inténtalo nuevamente.");
                if (disableWhileSigningOut) button.disabled = false;
            }
        });
    });
}
