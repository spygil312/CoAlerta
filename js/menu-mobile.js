const btnMenu = document.getElementById("btnMenu");
const menuMobile = document.getElementById("menuMobile");

if (btnMenu && menuMobile) {
    function cerrarMenu() {
        menuMobile.classList.remove("mostrar");
        btnMenu.setAttribute("aria-expanded", "false");
        btnMenu.setAttribute("aria-label", "Abrir menú");
    }

    btnMenu.addEventListener("click", function () {
        const abierto = menuMobile.classList.toggle("mostrar");
        btnMenu.setAttribute("aria-expanded", String(abierto));
        btnMenu.setAttribute("aria-label", abierto ? "Cerrar menú" : "Abrir menú");
    });

    menuMobile.querySelectorAll("a").forEach(function (enlace) {
        enlace.addEventListener("click", cerrarMenu);
    });

    document.addEventListener("keydown", function (evento) {
        if (evento.key === "Escape") {
            cerrarMenu();
        }
    });
}
