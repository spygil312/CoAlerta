(function () {
    let hasAuthenticatedProfile = false;
    let accountPreferences = {};
    let cachedAccountUid = "";

    function readCachedTheme() {
        try {
            const cachedProfile = JSON.parse(localStorage.getItem("coalerta_usuario") || "null");
            if (!cachedProfile || typeof cachedProfile.uid !== "string") return {};
            cachedAccountUid = cachedProfile.uid;
            const preferences = JSON.parse(
                localStorage.getItem(`coalertaPreferencias:${cachedAccountUid}`) || "null"
            );
            if (preferences && typeof preferences === "object" && !Array.isArray(preferences)) {
                return preferences;
            }
            return cachedProfile.preferencias &&
                typeof cachedProfile.preferencias === "object" &&
                !Array.isArray(cachedProfile.preferencias)
                ? cachedProfile.preferencias
                : {};
        } catch (error) {
            console.error("No se pudo recuperar el tema guardado:", error);
            return {};
        }
    }

    function readPreferences() {
        const uid = typeof auth !== "undefined" && auth.currentUser ? auth.currentUser.uid : "";
        if (!uid) return {};
        try {
            const preferences = JSON.parse(localStorage.getItem(`coalertaPreferencias:${uid}`) || "{}");
            return preferences && typeof preferences === "object" && !Array.isArray(preferences)
                ? preferences
                : {};
        } catch (error) {
            console.error("No se pudieron leer las preferencias de tema:", error);
            return {};
        }
    }

    function applyTheme(preferences) {
        const dark = Boolean(preferences && preferences.temaOscuro);
        document.documentElement.dataset.theme = dark ? "dark" : "light";
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.content = dark ? "#10191f" : "#168A5B";
    }

    function clearAccountTheme() {
        hasAuthenticatedProfile = false;
        accountPreferences = {};
        applyTheme({});
    }

    accountPreferences = readCachedTheme();
    applyTheme(accountPreferences);
    window.addEventListener("coalerta:perfil-cargando", (event) => {
        const user = event.detail && event.detail.user;
        if (user && user.uid === cachedAccountUid) return;
        clearAccountTheme();
    });
    window.addEventListener("coalerta:preferencias-cargadas", (event) => {
        accountPreferences = event.detail && typeof event.detail === "object"
            ? event.detail
            : {};
        if (hasAuthenticatedProfile) applyTheme(accountPreferences);
    });
    window.addEventListener("coalerta:preferencias-cambiadas", (event) => {
        if (!hasAuthenticatedProfile) return;
        accountPreferences = event.detail && typeof event.detail === "object"
            ? event.detail
            : readPreferences();
        applyTheme(accountPreferences);
    });
    window.addEventListener("coalerta:sesion-cambiada", (event) => {
        const session = event.detail || {};
        if (!session.user || !session.profile || session.registrationIncomplete) {
            clearAccountTheme();
            return;
        }
        hasAuthenticatedProfile = true;
        accountPreferences = session.profile.preferencias &&
            typeof session.profile.preferencias === "object" &&
            !Array.isArray(session.profile.preferencias)
            ? session.profile.preferencias
            : accountPreferences;
        applyTheme(accountPreferences);
    });
    window.addEventListener("storage", (event) => {
        const uid = typeof auth !== "undefined" && auth.currentUser ? auth.currentUser.uid : "";
        if (hasAuthenticatedProfile && uid && event.key === `coalertaPreferencias:${uid}`) {
            accountPreferences = readPreferences();
            applyTheme(accountPreferences);
        }
    });
})();
