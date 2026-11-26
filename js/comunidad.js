import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";
import {
    configurarCierreSesion as configurarCierreSesionCompartido,
    formatearRolVisible
} from "./general.js?v=shared-core-20261106";

let usuarioActual = null;
let ubicacionCercanaActual = null;
let serviciosOpenStreetMap = 0;
let lugaresServiciosOpenStreetMap = [];
let lugaresImportantesOpenStreetMap = [];
let avisosExpiryTimer = null;
let stopWatchingAnnouncements = null;
let watchingAnnouncementsUid = null;
let watchingAnnouncementsCommunityId = null;
let solicitudPerfilVecino = 0;
let elementoEnfoqueAntesDeSalir = null;
const listasAmpliables = new Map();
const configuracionListas = {
    miembros: {
        contenedorId: 'contenedor-vecinos',
        botonId: 'btn-ver-todos-miembros',
        titulo: 'Miembros de la comunidad',
        vacio: 'No hay miembros registrados en esta comunidad.'
    },
    anuncios: {
        contenedorId: 'contenedor-anuncios',
        botonId: 'btn-ver-todos-anuncios',
        titulo: 'Anuncios de la comunidad',
        vacio: 'No hay anuncios publicados.',
        maxVisible: 1
    },
    comunicados: {
        contenedorId: 'listaAvisosOficiales',
        botonId: 'btn-ver-todos-comunicados',
        titulo: 'Comunicados oficiales',
        vacio: 'No hay comunicados oficiales para tu comunidad.',
        maxVisible: 1
    },
    serviciosCercanos: {
        contenedorId: 'listaServiciosCercanos',
        botonId: 'btn-ver-servicios-cercanos',
        titulo: 'Comisarías, Serenazgo y personal activo',
        vacio: 'No se encontraron comisarías, bases de Serenazgo ni personal activo.',
        maxVisible: 2
    },
    lugaresCercanos: {
        contenedorId: 'listaLugaresCercanos',
        botonId: 'btn-ver-lugares-cercanos',
        titulo: 'Zonas y lugares importantes',
        vacio: 'No se encontraron centros de salud, municipalidades ni estaciones de bomberos.',
        maxVisible: 3
    }
};

document.addEventListener('DOMContentLoaded', () => {
    configurarCierreSesionCompartido({
        auth,
        signOut,
        clearCachedSession: false,
        replaceLocation: true
    });
    Object.entries(configuracionListas).forEach(([clave, configuracion]) => {
        document.getElementById(configuracion.botonId)?.addEventListener('click', () => {
            mostrarListaCompleta(clave);
        });
    });
    document.getElementById('btn-salir-comunidad')?.addEventListener(
        'click',
        abrirConfirmacionSalida
    );
    document.getElementById('btn-cancelar-salida')?.addEventListener(
        'click',
        cerrarConfirmacionSalida
    );
    document.getElementById('btn-confirmar-salida')?.addEventListener(
        'click',
        confirmarSalidaComunidad
    );
    document.getElementById('modal-salir-comunidad')?.addEventListener('click', (evento) => {
        if (evento.target === evento.currentTarget) cerrarConfirmacionSalida();
    });
    document.addEventListener('keydown', (evento) => {
        const modal = document.getElementById('modal-salir-comunidad');
        if (evento.key === 'Escape' && modal?.classList.contains('activo')) {
            cerrarConfirmacionSalida();
        }
        if (evento.key === 'Tab' && modal?.classList.contains('activo')) {
            const focusable = [...modal.querySelectorAll(
                'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
            )];
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!modal.contains(document.activeElement)) {
                evento.preventDefault();
                (evento.shiftKey ? last : first).focus();
            } else if (evento.shiftKey && document.activeElement === first) {
                evento.preventDefault();
                last.focus();
            } else if (!evento.shiftKey && document.activeElement === last) {
                evento.preventDefault();
                first.focus();
            }
        }
    });
    document.getElementById('modal-lista-comunidad')?.addEventListener('click', (evento) => {
        if (evento.target === evento.currentTarget) cerrarModal('modal-lista-comunidad');
    });
    mostrarPerfilLocal();
    configurarUbicacionCercana();
    renderizarAvisosOficiales();
    window.addEventListener('coalerta:avisos-actualizados', renderizarAvisosOficiales);
    window.addEventListener('coalerta:datos-listos', renderizarAvisosOficiales);
    window.addEventListener('coalerta:miembros-actualizados', (event) => {
        actualizarListaAmpliable(
            'miembros',
            event.detail || [],
            crearFilaMiembro,
            document.getElementById('contenedor-vecinos')
        );
        renderizarPersonalSeguridadCercano();
    });
    window.setInterval(renderizarPersonalSeguridadCercano, 30000);
    window.addEventListener('coalerta:comunidad-asignada', (event) => {
        const comunidadId = event.detail && event.detail.comunidadId;
        if (!usuarioActual || !comunidadId || usuarioActual.comunidadId === comunidadId) return;
        usuarioActual.comunidadId = comunidadId;
        inicializarInterfazReal();
    });
    window.addEventListener('coalerta:error', (event) => {
        if (event.detail && event.detail.area === 'comunicados') {
            actualizarListaAmpliable(
                'comunicados',
                [],
                crearFilaComunicado,
                document.getElementById('listaAvisosOficiales')
            );
            mostrarMensajeEnContenedor(
                document.getElementById('listaAvisosOficiales'),
                event.detail.message || 'No se pudieron sincronizar los comunicados.'
            );
        }
    });

    Object.assign(window, {
        abrirModal,
        cerrarModal,
        guardarAnuncio,
        copiarCodigo,
        procesarUnion
    });

    onAuthStateChanged(auth, (user) => {
        if (!user) {
            usuarioActual = null;
            if (stopWatchingAnnouncements) stopWatchingAnnouncements();
            stopWatchingAnnouncements = null;
            watchingAnnouncementsUid = null;
            watchingAnnouncementsCommunityId = null;
            return;
        }
        buscarLugaresCercanos();
        const profile = window.coalertaData && window.coalertaData.getProfile();
        if (profile && profile.uid === user.uid) initializeCommunityProfile(user, profile);
    });
    window.addEventListener('coalerta:datos-listos', (event) => {
        const user = auth.currentUser;
        const detail = event.detail || {};
        if (user && detail.uid === user.uid && detail.profile) {
            initializeCommunityProfile(user, detail.profile);
        }
    });
    window.addEventListener('coalerta:delegacion-actualizada', () => {
        if (!usuarioActual) return;
        const role = obtenerRolEfectivo(usuarioActual.rol);
        if (role === usuarioActual.rol) return;
        usuarioActual.rol = role;
        configurarSegunRol();
        actualizarDatosSidebar();
    });

    function initializeCommunityProfile(user, datosUsuario) {
        const role = obtenerRolEfectivo(datosUsuario.rol);
        if (usuarioActual && usuarioActual.uid === user.uid &&
            usuarioActual.comunidadId === datosUsuario.comunidadId) {
            usuarioActual = {
                ...usuarioActual,
                ...datosUsuario,
                uid: user.uid,
                rol: role,
                nombre: datosUsuario.nombre ||
                    [datosUsuario.nombres, datosUsuario.apellidos].filter(Boolean).join(' ') ||
                    user.displayName ||
                    (user.email ? user.email.split('@')[0] : 'Usuario')
            };
            usuarioActual.rol = role;
        } else {
            usuarioActual = {
                ...datosUsuario,
                uid: user.uid,
                fotoBase64: datosUsuario.fotoBase64 || leerFotoLocalUsuario(user.uid),
                photoURL: datosUsuario.photoURL || user.photoURL || '',
                nombre: datosUsuario.nombre ||
                    [datosUsuario.nombres, datosUsuario.apellidos].filter(Boolean).join(' ') ||
                    user.displayName ||
                    (user.email ? user.email.split('@')[0] : 'Usuario'),
                correo: datosUsuario.correo || datosUsuario.email || user.email || '',
                rol: role
            };
        }
        inicializarInterfazReal();
    }

    function obtenerRolEfectivo(rolFallback) {
        const role = window.coalertaData &&
            typeof window.coalertaData.getRole === 'function'
            ? window.coalertaData.getRole()
            : rolFallback;
        return String(role || 'vecino').trim().toLowerCase();
    }

    function renderizarAvisosOficiales() {
        const contenedor = document.getElementById('listaAvisosOficiales');
        if (!contenedor) return;
        if (avisosExpiryTimer !== null) {
            window.clearTimeout(avisosExpiryTimer);
            avisosExpiryTimer = null;
        }
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            mostrarMensajeEnContenedor(contenedor, 'Conectando los avisos de tu comunidad…');
            return;
        }

        try {
            const ahora = Date.now();
            const vigenciaMs = 24 * 60 * 60 * 1000;
            const avisos = window.coalertaData.getNotices()
                .filter((aviso) => aviso.comunidadId === (usuarioActual && usuarioActual.comunidadId))
                .filter((aviso) => {
                    const fecha = new Date(aviso.timestamp).getTime();
                    return Number.isFinite(fecha) && ahora - fecha < vigenciaMs;
                });
            const fechaExpiracion = avisos.reduce((proxima, aviso) => {
                const expiracion = new Date(aviso.timestamp).getTime() + vigenciaMs;
                return expiracion > ahora ? Math.min(proxima, expiracion) : proxima;
            }, Infinity);
            if (Number.isFinite(fechaExpiracion)) {
                avisosExpiryTimer = window.setTimeout(
                    renderizarAvisosOficiales,
                    Math.max(1, fechaExpiracion - ahora + 50)
                );
            }
            actualizarListaAmpliable(
                'comunicados',
                avisos,
                crearFilaComunicado,
                contenedor
            );
        } catch (error) {
            console.error('No se pudieron cargar los comunicados:', error);
            mostrarMensajeEnContenedor(contenedor, 'No se pudieron cargar los comunicados.');
        }
    }

    window.coalertaRenderizarAvisosOficiales = renderizarAvisosOficiales;

    let solicitudUbicacionActual = 0;

    function configurarUbicacionCercana() {
        const boton = document.getElementById('btnActualizarUbicacion');
        if (boton) boton.addEventListener('click', () => buscarLugaresCercanos(true));
    }

    function buscarLugaresCercanos(forzarActualizacion = false) {
        const solicitud = ++solicitudUbicacionActual;
        const boton = document.getElementById('btnActualizarUbicacion');
        lugaresServiciosOpenStreetMap = [];
        lugaresImportantesOpenStreetMap = [];
        serviciosOpenStreetMap = 0;
        ubicacionCercanaActual = null;
        establecerTextoCercano('contadorServiciosSeguridad', 0);
        establecerTextoCercano('contadorZonas', 0);
        establecerTextoCercano('contadorLugares', 0);
        establecerEstadoUbicacion('Solicitando tu ubicación actual...', 'cargando');
        establecerListaCercana('listaServiciosCercanos', 'Buscando comisarías y serenazgo cercanos...');
        establecerListaCercana('listaLugaresCercanos', 'Buscando zonas y lugares cercanos...');

        if (boton) boton.disabled = true;
        if (typeof window.coalertaObtenerUbicacionActual !== 'function') {
            mostrarErrorUbicacion('No se pudo iniciar el servicio de ubicación. Recarga la página para intentarlo nuevamente.');
            return;
        }

        window.coalertaObtenerUbicacionActual(forzarActualizacion).then(async (ubicacion) => {
            if (solicitud !== solicitudUbicacionActual) return;
            const latitud = ubicacion.latitud;
            const longitud = ubicacion.longitud;
            establecerEstadoUbicacion('Buscando servicios y lugares a menos de 3 km...', 'cargando');

            try {
                actualizarNombreArea(latitud, longitud, solicitud).catch((error) => {
                    console.error('No se pudo identificar el nombre del área cercana:', error);
                });
                const elementos = await consultarOpenStreetMap(latitud, longitud);
                if (solicitud !== solicitudUbicacionActual) return;
                mostrarLugaresCercanos(elementos, latitud, longitud);
                ubicacionCercanaActual = { latitud, longitud };
                renderizarPersonalSeguridadCercano();
                establecerEstadoUbicacion('Resultados cercanos a tu ubicación actual. Se actualizan cuando pulsas “Actualizar ubicación”.', 'correcto');
            } catch (error) {
                if (solicitud !== solicitudUbicacionActual) return;
                console.error('No se pudieron consultar los lugares cercanos en OpenStreetMap:', error);
                mostrarErrorUbicacion(
                    'No se pudieron cargar los lugares cercanos porque los servidores de mapas no respondieron. Pulsa “Actualizar ubicación” para intentarlo de nuevo.',
                    { causa: 'red' }
                );
                renderizarPersonalSeguridadCercano();
            } finally {
                if (solicitud === solicitudUbicacionActual && boton) boton.disabled = false;
            }
        }).catch((error) => {
            if (solicitud !== solicitudUbicacionActual) return;
            mostrarErrorUbicacion(`${error.message} Activa el permiso y vuelve a intentarlo.`);
            if (boton) boton.disabled = false;
        });
    }

    const RADIO_BUSQUEDA_METROS = 3000;
    const VIGENCIA_CACHE_MS = 30 * 60 * 1000;
    const TIEMPO_MAXIMO_OVERPASS_MS = 20000;
    const RETARDO_ENTRE_ESPEJOS_MS = 1500;
    const SERVIDORES_OVERPASS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.openstreetmap.fr/api/interpreter'
    ];
    const CATEGORIAS_NOMINATIM = ['police', 'hospital', 'clinic', 'fire_station', 'townhall'];

    function pausa(ms, senal) {
        return new Promise((resolve, reject) => {
            if (senal && senal.aborted) {
                reject(new DOMException('Cancelado', 'AbortError'));
                return;
            }
            const temporizador = window.setTimeout(resolve, ms);
            if (senal) {
                senal.addEventListener('abort', () => {
                    window.clearTimeout(temporizador);
                    reject(new DOMException('Cancelado', 'AbortError'));
                }, { once: true });
            }
        });
    }

    async function pedirJson(url, opciones = {}, tiempoMaximoMs = 15000, senalExterna = null) {
        const controlador = new AbortController();
        const cancelar = () => controlador.abort(senalExterna && senalExterna.reason);
        if (senalExterna) {
            if (senalExterna.aborted) cancelar();
            else senalExterna.addEventListener('abort', cancelar, { once: true });
        }
        const temporizador = window.setTimeout(() => {
            controlador.abort(new DOMException('Tiempo de espera agotado', 'TimeoutError'));
        }, tiempoMaximoMs);
        try {
            const respuesta = await fetch(url, { ...opciones, signal: controlador.signal });
            if (!respuesta.ok) throw new Error(`${new URL(url).host} respondió con estado ${respuesta.status}.`);
            return await respuesta.json();
        } finally {
            window.clearTimeout(temporizador);
            if (senalExterna) senalExterna.removeEventListener('abort', cancelar);
        }
    }

    function construirConsultaOverpass(latitud, longitud, radio) {
        const alrededor = `(around:${radio},${latitud},${longitud})`;
        const filtros = [
            '["amenity"="police"]',
            '["amenity"="hospital"]',
            '["amenity"="clinic"]',
            '["amenity"="fire_station"]',
            '["emergency"="fire_station"]',
            '["amenity"="townhall"]'
        ];
        return `[out:json][timeout:25];(${filtros.map((f) => `nwr${f}${alrededor};`).join('')});out center tags 200;`;
    }

    function leerCacheLugares(clave, aceptarVencida) {
        try {
            const cache = JSON.parse(sessionStorage.getItem(clave) || 'null');
            if (!cache || !Array.isArray(cache.elements) || !Number.isFinite(cache.timestamp)) return null;
            const antiguedad = Date.now() - cache.timestamp;
            if (antiguedad < 0) return null;
            if (aceptarVencida || antiguedad < VIGENCIA_CACHE_MS) return cache.elements;
        } catch (error) {
            console.warn('No se pudo leer la caché temporal de lugares cercanos:', error);
        }
        return null;
    }

    function guardarCacheLugares(clave, elements) {
        if (!Array.isArray(elements) || elements.length === 0) return;
        try {
            sessionStorage.setItem(clave, JSON.stringify({ timestamp: Date.now(), elements }));
        } catch (error) {
            console.warn('No se pudo guardar la caché temporal de lugares cercanos:', error);
        }
    }

    async function consultarOverpass(latitud, longitud) {
        const consulta = construirConsultaOverpass(latitud, longitud, RADIO_BUSQUEDA_METROS);
        const grupo = new AbortController();
        try {
            return await Promise.any(SERVIDORES_OVERPASS.map(async (servidor, indice) => {
                await pausa(indice * RETARDO_ENTRE_ESPEJOS_MS, grupo.signal);
                const datos = await pedirJson(
                    servidor,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                        body: `data=${encodeURIComponent(consulta)}`
                    },
                    TIEMPO_MAXIMO_OVERPASS_MS,
                    grupo.signal
                );
                if (!Array.isArray(datos.elements)) {
                    throw new Error(`${servidor} no devolvió una lista de lugares.`);
                }
                if (typeof datos.remark === 'string' && /runtime error|timed out|out of memory/i.test(datos.remark)) {
                    throw new Error(`${servidor}: ${datos.remark}`);
                }
                return datos.elements;
            }));
        } catch (error) {
            if (error instanceof AggregateError) {
                error.errors.forEach((motivo, indice) =>
                    console.warn(`Overpass (${SERVIDORES_OVERPASS[indice]}) falló:`, motivo && motivo.message || motivo)
                );
            }
            throw error;
        } finally {
            grupo.abort(new DOMException('Consulta finalizada', 'AbortError'));
        }
    }

    async function consultarNominatimPorCategoria(latitud, longitud) {
        const deltaLatitud = RADIO_BUSQUEDA_METROS / 111320;
        const deltaLongitud = RADIO_BUSQUEDA_METROS / (111320 * Math.max(0.1, Math.cos(latitud * Math.PI / 180)));
        const viewbox = [
            longitud - deltaLongitud, latitud + deltaLatitud,
            longitud + deltaLongitud, latitud - deltaLatitud
        ].join(',');

        const elementos = [];
        let exitosas = 0;
        for (let i = 0; i < CATEGORIAS_NOMINATIM.length; i += 1) {
            if (i > 0) await pausa(1100);
            const categoria = CATEGORIAS_NOMINATIM[i];
            const parametros = new URLSearchParams({
                format: 'jsonv2',
                amenity: categoria,
                viewbox,
                bounded: '1',
                limit: '20',
                'accept-language': 'es'
            });
            try {
                const datos = await pedirJson(
                    `https://nominatim.openstreetmap.org/search?${parametros}`,
                    {},
                    10000
                );
                if (!Array.isArray(datos)) throw new Error('Nominatim no devolvió una lista.');
                exitosas += 1;
                datos.forEach((resultado) => {
                    elementos.push({
                        type: resultado.osm_type || 'nominatim',
                        id: resultado.osm_id || `${categoria}:${resultado.lat}:${resultado.lon}`,
                        lat: Number(resultado.lat),
                        lon: Number(resultado.lon),
                        tags: {
                            amenity: resultado.type || categoria,
                            name: resultado.name || (resultado.display_name || '').split(',')[0]
                        }
                    });
                });
            } catch (error) {
                console.warn(`Nominatim no respondió para "${categoria}":`, error && error.message || error);
            }
        }
        if (exitosas === 0) throw new Error('Nominatim no respondió a ninguna consulta.');
        return elementos;
    }

    async function consultarOpenStreetMap(latitud, longitud) {
        const claveCache = `coalerta_lugares_osm:${latitud.toFixed(3)}:${longitud.toFixed(3)}`;

        const cacheVigente = leerCacheLugares(claveCache, false);
        if (cacheVigente) return cacheVigente;

        try {
            const elementos = await consultarOverpass(latitud, longitud);
            guardarCacheLugares(claveCache, elementos);
            return elementos;
        } catch (errorOverpass) {
            console.warn('Overpass no respondió en ningún servidor; se usará un respaldo:', errorOverpass);
        }

        const cacheAntigua = leerCacheLugares(claveCache, true);
        if (cacheAntigua) {
            console.warn('Se muestran resultados guardados anteriormente para esta zona.');
            return cacheAntigua;
        }

        establecerEstadoUbicacion('Los servidores principales están lentos. Probando una búsqueda alternativa…', 'cargando');
        try {
            const elementos = await consultarNominatimPorCategoria(latitud, longitud);
            guardarCacheLugares(claveCache, elementos);
            return elementos;
        } catch (errorNominatim) {
            console.warn('El respaldo de Nominatim tampoco respondió:', errorNominatim);
            throw new Error('No respondieron los servidores de OpenStreetMap (Overpass ni Nominatim).');
        }
    }

    async function actualizarNombreArea(latitud, longitud, solicitud) {
        const controlador = new AbortController();
        const temporizador = window.setTimeout(() => controlador.abort(), 10000);
        try {
            const parametros = new URLSearchParams({
                format: 'jsonv2',
                lat: String(latitud),
                lon: String(longitud),
                zoom: '14',
                addressdetails: '1'
            });
            const respuesta = await fetch(`https://nominatim.openstreetmap.org/reverse?${parametros}`, {
                headers: { 'Accept-Language': 'es' },
                signal: controlador.signal
            });
            if (!respuesta.ok) throw new Error(`Geocodificador respondió con estado ${respuesta.status}.`);
            const datos = await respuesta.json();
            if (solicitud !== solicitudUbicacionActual) return;

            const direccion = datos.address || {};
            const zona = direccion.neighbourhood || direccion.suburb || direccion.city_district ||
                direccion.city || direccion.town || direccion.village || direccion.county ||
                direccion.state || '';
            const nombreArea = zona || direccion.country || '';
            if (!nombreArea) return;

            const titulo = document.getElementById('tituloAreaCercana');
            const resumen = document.getElementById('resumenUbicacion');
            if (titulo) titulo.textContent = `Lugares cercanos a ${nombreArea}`;
            if (resumen) resumen.textContent = nombreArea;
        } finally {
            window.clearTimeout(temporizador);
        }
    }

    function mostrarLugaresCercanos(elementos, latitud, longitud) {
        const servicios = [];
        const lugaresImportantes = [];
        const vistos = new Set();

        elementos.forEach((elemento) => {
            const etiquetas = elemento.tags || {};
            const coordenadas = elemento.center || elemento;
            const lat = Number(coordenadas.lat);
            const lon = Number(coordenadas.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const distancia = distanciaEnMetros(latitud, longitud, lat, lon);
            if (distancia > 5000) return;

            const llave = `${elemento.type}/${elemento.id}`;
            if (vistos.has(llave)) return;
            vistos.add(llave);

            const nombre = etiquetas.name || etiquetas['name:es'] || etiquetas.operator ||
                etiquetas.brand || 'Lugar sin nombre registrado';
            const detalle = {
                nombre,
                distancia,
                latitud: lat,
                longitud: lon,
                tipo: clasificarLugarCercano(etiquetas, nombre)
            };

            if (detalle.tipo === 'serenazgo' || detalle.tipo === 'comisaria') {
                servicios.push(detalle);
            } else if (['salud', 'municipalidad', 'bomberos'].includes(detalle.tipo)) {
                lugaresImportantes.push(detalle);
            }
        });

        servicios.sort((a, b) => a.distancia - b.distancia);
        lugaresImportantes.sort((a, b) => a.distancia - b.distancia);

        lugaresServiciosOpenStreetMap = servicios;
        lugaresImportantesOpenStreetMap = lugaresImportantes;
        guardarLugaresParaMapa([...servicios, ...lugaresImportantes]);
        serviciosOpenStreetMap = servicios.length;
        establecerTextoCercano(
            'contadorZonas',
            lugaresImportantes.filter((lugar) =>
                ['municipalidad', 'bomberos'].includes(lugar.tipo)
            ).length
        );
        establecerTextoCercano(
            'contadorLugares',
            lugaresImportantes.filter((lugar) => lugar.tipo === 'salud').length
        );
    }

    function guardarLugaresParaMapa(lugares) {
        try {
            const tiposEnMapa = ['salud', 'comisaria', 'serenazgo', 'bomberos', 'municipalidad'];
            const compactos = lugares
                .filter((lugar) => tiposEnMapa.includes(lugar.tipo))
                .map((lugar) => ({
                    nombre: lugar.nombre,
                    tipo: lugar.tipo,
                    latitud: lugar.latitud,
                    longitud: lugar.longitud
                }));
            sessionStorage.setItem('coalerta_lugares_mapa', JSON.stringify({
                timestamp: Date.now(),
                lugares: compactos
            }));
        } catch (error) {
            console.warn('No se pudieron guardar los lugares cercanos para el mapa:', error);
        }
    }

    function crearEnlaceMapa(elemento) {
        const parametros = new URLSearchParams({
            lat: String(elemento.latitud),
            lng: String(elemento.longitud)
        });
        if (!elemento.esPersonal) {
            parametros.set('tipo', elemento.tipo || 'lugar');
            parametros.set('nombre', String(elemento.nombre || '').slice(0, 120));
        }
        return `mapa.html?${parametros.toString()}`;
    }

    function renderizarPersonalSeguridadCercano() {
        const data = window.coalertaData;
        const miembros = data && data.isReady()
            ? data.getCommunityMembers()
                .filter((miembro) => miembro.rol === 'seguridad' &&
                    (miembro.estado === 'Activo' || miembro.activo === true))
                .map((miembro) => {
                    const actualizado = obtenerMilisegundos(miembro.ubicacionActualizadaAt);
                    const latitud = Number(miembro.latitud);
                    const longitud = Number(miembro.longitud);
                    const tieneUbicacion = miembro.ubicacionCompartida === true &&
                        Number.isFinite(actualizado) && Date.now() >= actualizado &&
                        Date.now() - actualizado <= 2 * 60 * 1000 &&
                        Number.isFinite(latitud) && latitud >= -90 && latitud <= 90 &&
                        Number.isFinite(longitud) && longitud >= -180 && longitud <= 180;
                    const distancia = tieneUbicacion && ubicacionCercanaActual
                        ? distanciaEnMetros(
                            ubicacionCercanaActual.latitud,
                            ubicacionCercanaActual.longitud,
                            latitud,
                            longitud
                        )
                        : null;
                    return {
                        nombre: miembro.nombre || 'Personal de serenazgo',
                        tipo: 'serenazgo',
                        distancia,
                        latitud: tieneUbicacion ? latitud : null,
                        longitud: tieneUbicacion ? longitud : null,
                        esPersonal: true,
                        tieneUbicacion
                    };
                })
                .filter((miembro) => miembro.distancia === null || miembro.distancia <= 5000)
            : [];
        miembros.sort((primero, segundo) =>
            (primero.distancia ?? Infinity) - (segundo.distancia ?? Infinity)
        );
        const servicios = [...lugaresServiciosOpenStreetMap, ...miembros]
            .sort((primero, segundo) =>
                (primero.distancia ?? Infinity) - (segundo.distancia ?? Infinity)
            );
        renderizarListaCercana('listaServiciosCercanos', servicios, 'servicio');
        renderizarListaCercana('listaLugaresCercanos', lugaresImportantesOpenStreetMap, 'lugar');
        establecerTextoCercano('contadorServiciosSeguridad', serviciosOpenStreetMap + miembros.length);
    }

    function clasificarLugarCercano(etiquetas, nombre) {
        if (etiquetas.tipo === 'bomberos' || etiquetas.categoria === 'bomberos' ||
            etiquetas.amenity === 'fire_station' || etiquetas.emergency === 'fire_station' ||
            /bombero|compa(?:ñ|n)[ií]a|fire/i.test(nombre)) return 'bomberos';
        if (/serenazgo|seguridad ciudadana/i.test(nombre)) return 'serenazgo';
        if (etiquetas.amenity === 'police' ||
            /comisar[ií]a|polic[ií]a|PNP/i.test(nombre)) return 'comisaria';
        if (etiquetas.amenity === 'townhall' || etiquetas.government === 'municipality' ||
            /municipalidad|municipio/i.test(nombre)) return 'municipalidad';
        if (['hospital', 'clinic', 'doctors'].includes(etiquetas.amenity) ||
            ['hospital', 'clinic', 'health_post', 'doctor'].includes(etiquetas.healthcare) ||
            /posta|centro de salud/i.test(nombre)) return 'salud';
        return null;
    }

    function renderizarListaCercana(id, elementos, tipoLista) {
        const contenedor = document.getElementById(id);
        if (!contenedor) return;
        const clave = tipoLista === 'servicio' ? 'serviciosCercanos' : 'lugaresCercanos';
        actualizarListaAmpliable(
            clave,
            elementos,
            (elemento) => crearFilaLugarCercano(elemento, tipoLista),
            contenedor
        );
    }

    function crearFilaLugarCercano(elemento, tipoLista) {
            const fila = document.createElement('article');
            fila.className = tipoLista === 'servicio'
                ? 'item-autoridad card-interna'
                : 'item-lugar';
            const icono = document.createElement('div');
            icono.className = tipoLista === 'servicio' ? 'autoridad-icono' : 'lugar-icono';
            const iconoI = document.createElement('i');
            iconoI.className = `fa-solid ${obtenerIconoLugar(elemento.tipo)}`;
            iconoI.setAttribute('aria-hidden', 'true');
            icono.appendChild(iconoI);

            const info = document.createElement('div');
            info.className = tipoLista === 'servicio' ? 'autoridad-info' : 'lugar-info';
            const titulo = document.createElement('h4');
            titulo.textContent = elemento.nombre;
            const descripcion = document.createElement('p');
            const detalleDistancia = Number.isFinite(elemento.distancia)
                ? formatearDistancia(elemento.distancia)
                : elemento.esPersonal
                    ? 'Ubicación no compartida'
                    : '';
            descripcion.textContent = detalleDistancia
                ? `${elemento.esPersonal ? 'Personal activo' : etiquetaTipoLugar(elemento.tipo)} · ${detalleDistancia}`
                : etiquetaTipoLugar(elemento.tipo);
            info.append(titulo, descripcion);

            const tieneCoordenadas = Number.isFinite(elemento.latitud) &&
                Number.isFinite(elemento.longitud);
            if (!tieneCoordenadas) {
                fila.append(icono, info);
                return fila;
            }
            const enlace = document.createElement('a');
            enlace.className = tipoLista === 'servicio' ? 'enlace-lugar-cercano' : 'icono-flecha';
            // Se abre en el panel de mapa de CoAlerta (misma pestaña), no en OpenStreetMap.
            enlace.href = crearEnlaceMapa(elemento);
            enlace.setAttribute('aria-label', elemento.esPersonal
                ? `Ver la ubicación compartida de ${elemento.nombre} en el mapa`
                : `Ver ${elemento.nombre} en el mapa de CoAlerta`);
            if (tipoLista === 'servicio') {
                enlace.textContent = 'Ver mapa';
            } else {
                const flecha = document.createElement('i');
                flecha.className = 'fa-solid fa-chevron-right';
                flecha.setAttribute('aria-hidden', 'true');
                enlace.appendChild(flecha);
            }
            fila.append(icono, info, enlace);
            return fila;
    }

    function obtenerMilisegundos(valor) {
        if (valor && typeof valor.toMillis === 'function') return valor.toMillis();
        if (valor && typeof valor.toDate === 'function') return valor.toDate().getTime();
        const fecha = new Date(valor || 0).getTime();
        return Number.isFinite(fecha) ? fecha : NaN;
    }

    function obtenerIconoLugar(tipo) {
        const iconos = {
            serenazgo: 'fa-user-shield',
            comisaria: 'fa-shield-halved',
            salud: 'fa-kit-medical',
            municipalidad: 'fa-landmark',
            bomberos: 'fa-fire-extinguisher'
        };
        return iconos[tipo] || 'fa-location-dot';
    }

    function etiquetaTipoLugar(tipo) {
        const etiquetas = {
            serenazgo: 'Serenazgo',
            comisaria: 'Comisaría / policía',
            salud: 'Centro de salud',
            municipalidad: 'Municipalidad',
            bomberos: 'Estación de bomberos',
            lugar: 'Lugar importante'
        };
        return etiquetas[tipo] || etiquetas.lugar;
    }

    function distanciaEnMetros(lat1, lon1, lat2, lon2) {
        const [primeraLatitud, primeraLongitud, segundaLatitud, segundaLongitud] =
            [lat1, lon1, lat2, lon2].map(Number);
        if (![primeraLatitud, primeraLongitud, segundaLatitud, segundaLongitud]
            .every(Number.isFinite)) return NaN;

        return window.coalertaData.distanceMeters(
            { latitud: primeraLatitud, longitud: primeraLongitud },
            { latitud: segundaLatitud, longitud: segundaLongitud }
        );
    }

    function formatearDistancia(metros) {
        return window.coalertaFormatearDistancia(metros);
    }

    function establecerEstadoUbicacion(mensaje, estado) {
        const elemento = document.getElementById('estadoUbicacion');
        if (!elemento) return;
        elemento.textContent = mensaje;
        elemento.dataset.estado = estado;
    }

    function establecerListaCercana(id, mensaje) {
        const contenedor = document.getElementById(id);
        if (!contenedor) return;
        const entrada = Object.entries(configuracionListas)
            .find(([, configuracion]) => configuracion.contenedorId === id);
        if (entrada) {
            actualizarListaAmpliable(entrada[0], [], () => document.createElement('span'), contenedor);
        }
        agregarMensajeCercano(contenedor, mensaje);
    }

    function agregarMensajeCercano(contenedor, mensaje) {
        const parrafo = document.createElement('p');
        parrafo.className = 'sin-datos';
        parrafo.textContent = mensaje;
        contenedor.replaceChildren(parrafo);
    }

    function establecerTextoCercano(id, texto) {
        const elemento = document.getElementById(id);
        if (elemento) elemento.textContent = String(texto);
    }

    function mostrarErrorUbicacion(mensaje, { causa = 'permiso' } = {}) {
        establecerEstadoUbicacion(mensaje, 'error');
        if (causa === 'red') {
            establecerListaCercana('listaServiciosCercanos', 'No se pudo consultar el mapa en este momento. Pulsa “Actualizar ubicación” para reintentar.');
            establecerListaCercana('listaLugaresCercanos', 'No se pudo consultar el mapa en este momento. Pulsa “Actualizar ubicación” para reintentar.');
        } else {
            establecerListaCercana('listaServiciosCercanos', 'Activa el permiso de ubicación y pulsa “Actualizar ubicación” para volver a buscar.');
            establecerListaCercana('listaLugaresCercanos', 'Los resultados dependen del permiso de ubicación y de los datos disponibles en OpenStreetMap.');
        }
        const boton = document.getElementById('btnActualizarUbicacion');
        if (boton) boton.disabled = false;
    }
});

function inicializarInterfazReal() {
    configurarSegunRol();
    actualizarDatosSidebar();

    if (!usuarioActual.comunidadId) {
        if (stopWatchingAnnouncements) stopWatchingAnnouncements();
        stopWatchingAnnouncements = null;
        watchingAnnouncementsUid = null;
        watchingAnnouncementsCommunityId = null;
        mostrarSinComunidad();
        return;
    }

    cargarVecinosEnTiempoReal();
    cargarAnunciosEnTiempoReal();
    window.coalertaRenderizarAvisosOficiales?.();
}

function cargarVecinosEnTiempoReal() {
    const contenedor = document.getElementById('contenedor-vecinos');
    const data = window.coalertaData;
    if (!contenedor || !data) return;
    const miembros = data.getCommunityMembers().map((miembro) => ({
        ...miembro,
        uid: miembro.uid || miembro.id
    }));
    actualizarListaAmpliable('miembros', miembros, crearFilaMiembro, contenedor);
}

function cargarAnunciosEnTiempoReal() {
    const contenedor = document.getElementById('contenedor-anuncios');
    if (!contenedor || !usuarioActual || !usuarioActual.uid || !usuarioActual.comunidadId) return;

    const uid = usuarioActual.uid;
    const communityId = usuarioActual.comunidadId;
    if (stopWatchingAnnouncements &&
        watchingAnnouncementsUid === uid &&
        watchingAnnouncementsCommunityId === communityId) return;
    if (stopWatchingAnnouncements) stopWatchingAnnouncements();

    watchingAnnouncementsUid = uid;
    watchingAnnouncementsCommunityId = communityId;
    const anunciosRef = collection(db, "comunidades", communityId, "anuncios");
    stopWatchingAnnouncements = onSnapshot(anunciosRef, (snapshot) => {
        if (!usuarioActual || usuarioActual.uid !== uid ||
            usuarioActual.comunidadId !== communityId) return;
        const anuncios = snapshot.docs.map((documento) => ({
            ...documento.data(),
            id: documento.id
        }));
        anuncios.sort((primero, segundo) =>
            obtenerFechaAnuncio(segundo) - obtenerFechaAnuncio(primero)
        );
        actualizarListaAmpliable('anuncios', anuncios, crearFilaAnuncio, contenedor);
    }, (error) => {
        if (!usuarioActual || usuarioActual.uid !== uid ||
            usuarioActual.comunidadId !== communityId) return;
        console.error('Error al cargar anuncios de la comunidad:', error);
        const mensaje = error.code === 'permission-denied'
            ? 'No tienes permiso para leer los anuncios de esta comunidad. Verifica que tu perfil activo pertenezca a la comunidad y que las reglas estén publicadas en el proyecto correcto.'
            : 'No se pudieron cargar los anuncios de la comunidad. Inténtalo nuevamente más tarde.';
        mostrarMensajeEnContenedor(contenedor, mensaje);
    });
}

function obtenerFechaAnuncio(anuncio) {
    const fecha = anuncio.fecha || anuncio.timestamp || anuncio.createdAt;
    if (fecha && typeof fecha.toMillis === 'function') return fecha.toMillis();
    if (fecha && typeof fecha.toDate === 'function') return fecha.toDate().getTime();
    const milisegundos = fecha ? new Date(fecha).getTime() : 0;
    return Number.isFinite(milisegundos) ? milisegundos : 0;
}

function actualizarListaAmpliable(clave, elementos, crearElemento, contenedor) {
    const configuracion = configuracionListas[clave];
    if (!configuracion || !contenedor) return;
    const lista = Array.isArray(elementos) ? elementos : [];
    listasAmpliables.set(clave, { elementos: lista, crearElemento });
    contenedor.replaceChildren();
    const boton = document.getElementById(configuracion.botonId);
    if (boton) {
        const maxVisible = configuracion.maxVisible || 3;
        boton.hidden = lista.length <= maxVisible;
        boton.textContent = `Ver todos (${lista.length})`;
        boton.setAttribute('aria-label', `Ver todos los ${configuracion.titulo.toLocaleLowerCase()}`);
    }
    if (!lista.length) {
        const vacio = document.createElement('p');
        vacio.className = 'sin-datos';
        vacio.textContent = configuracion.vacio;
        contenedor.append(vacio);
        return;
    }
    lista.slice(0, configuracion.maxVisible || 3)
        .forEach((elemento) => contenedor.append(crearElemento(elemento)));
}

function mostrarListaCompleta(clave) {
    const lista = listasAmpliables.get(clave);
    const configuracion = configuracionListas[clave];
    const modal = document.getElementById('modal-lista-comunidad');
    const contenido = document.getElementById('modal-lista-contenido');
    const titulo = document.getElementById('modal-lista-titulo');
    if (!lista || !configuracion || !modal || !contenido || !titulo) return;

    titulo.textContent = `${configuracion.titulo} (${lista.elementos.length})`;
    contenido.replaceChildren(...lista.elementos.map(lista.crearElemento));
    modal.classList.add('activo');
}

function crearFilaMiembro(vecino) {
    const nombre = vecino.nombre || 'Vecino';
    const rol = vecino.rol === 'seguridad'
        ? 'Personal de serenazgo'
        : vecino.rol || 'Vecino';
    const fila = document.createElement('button');
    fila.type = 'button';
    fila.className = 'item-fila';
    fila.setAttribute('aria-label', `Ver perfil de ${nombre}`);
    fila.addEventListener('click', () => {
        cerrarModal('modal-lista-comunidad');
        verPerfilVecino(vecino);
    });

    const avatar = document.createElement('span');
    avatar.className = 'avatar-letras avatar-verde';
    const imagenVecino = vecino.fotoURL || vecino.photoURL || vecino.fotoBase64;
    if (imagenVecino) {
        const imagen = document.createElement('img');
        imagen.src = imagenVecino;
        imagen.alt = '';
        imagen.setAttribute('aria-hidden', 'true');
        imagen.addEventListener('error', () => {
            avatar.textContent = obtenerIniciales(nombre);
        }, { once: true });
        avatar.appendChild(imagen);
    } else {
        avatar.textContent = obtenerIniciales(nombre);
    }

    const info = document.createElement('span');
    info.className = 'item-info';
    const nombreElemento = document.createElement('h4');
    nombreElemento.textContent = nombre;
    const badge = document.createElement('span');
    badge.className = `badge ${vecino.estado === 'Activo' ? 'badge-activo' : 'badge-inactivo'}`;
    badge.textContent = rol;
    info.append(nombreElemento, badge);

    const flecha = document.createElement('i');
    flecha.className = 'fa-solid fa-chevron-right icono-flecha';
    flecha.setAttribute('aria-hidden', 'true');
    fila.append(avatar, info, flecha);
    return fila;
}

function crearFilaAnuncio(anuncio) {
    const fila = document.createElement('article');
    fila.className = 'item-anuncio';

    const info = document.createElement('div');
    info.className = 'anuncio-info';
    const titulo = document.createElement('h4');
    titulo.textContent = anuncio.titulo || 'Anuncio';
    const descripcion = document.createElement('p');
    descripcion.textContent = anuncio.descripcion || '';
    const autor = document.createElement('small');
    autor.className = 'anuncio-autor';
    autor.textContent = `Por: ${anuncio.autorNombre || 'Vecino'}`;
    info.append(titulo, descripcion, autor);
    fila.appendChild(info);

    if (usuarioActual.rol === 'coordinador') {
        const botonBorrar = document.createElement('button');
        botonBorrar.type = 'button';
        botonBorrar.className = 'btn-borrar-anuncio';
        botonBorrar.setAttribute('aria-label', 'Eliminar anuncio');
        botonBorrar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
        botonBorrar.addEventListener('click', () => borrarAnuncioReal(anuncio.id));
        fila.appendChild(botonBorrar);
    }
    return fila;
}

function crearFilaComunicado(aviso) {
    const articulo = document.createElement('article');
    articulo.className = 'item-anuncio item-aviso-oficial';
    const contenido = document.createElement('div');
    contenido.className = 'anuncio-info';
    const titulo = document.createElement('h4');
    titulo.textContent = aviso.titulo || 'Comunicado oficial';
    const mensaje = document.createElement('p');
    mensaje.textContent = aviso.mensaje || '';
    const autor = document.createElement('small');
    autor.className = 'anuncio-autor';
    autor.textContent = `${aviso.autor || 'Coordinación'} · ${new Date(aviso.timestamp).toLocaleString()}`;
    contenido.append(titulo, mensaje, autor);
    articulo.append(contenido);
    return articulo;
}

async function guardarAnuncio() {
    if (!usuarioActual || !usuarioActual.comunidadId) {
        alert('Primero debes pertenecer a una comunidad.');
        return;
    }

    const titulo = document.getElementById('anuncio-titulo').value.trim();
    const descripcion = document.getElementById('anuncio-desc').value.trim();

    if (!titulo || !descripcion) {
        alert("Completa todos los campos obligatorios.");
        return;
    }

    try {
        await window.coalertaData.createCommunityAnnouncement({ title: titulo, description: descripcion });

        cerrarModal('modal-publicar');
        document.getElementById('anuncio-titulo').value = '';
        document.getElementById('anuncio-desc').value = '';
    } catch (error) {
        console.error("Error al publicar el anuncio:", error);
        alert("Ocurrió un error al guardar el anuncio.");
    }
}

async function borrarAnuncioReal(anuncioId) {
    if (confirm("¿Estás seguro de que deseas eliminar este anuncio permanentemente?")) {
        try {
            await window.coalertaData.deleteCommunityAnnouncement(anuncioId);
        } catch (error) {
            console.error("Error al borrar el anuncio:", error);
            alert("No se pudo eliminar el anuncio. Inténtalo nuevamente.");
        }
    }
}

async function abrirModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    if (!usuarioActual) {
        alert('Espera a que se cargue tu perfil e inténtalo nuevamente.');
        return;
    }

    if (id === 'modal-publicar' && (!usuarioActual.comunidadId || usuarioActual.rol !== 'coordinador')) {
        alert('Solo un coordinador de la comunidad puede publicar anuncios.');
        return;
    }

    if (id === 'modal-codigo') {
        if (usuarioActual.rol !== 'coordinador') {
            alert('Solo un coordinador puede generar códigos para su comunidad.');
            return;
        }

        try {
            const result = await window.coalertaData.generateCommunityInvite();
            document.getElementById('codigo-generado').textContent = result.code;
            usuarioActual.comunidadId = result.comunidadId;
            configurarSegunRol();
        } catch (error) {
            console.error('Error al generar código de invitación:', error);
            alert(error.code === 'permission-denied'
                ? 'Firestore rechazó la operación. Publica las reglas actualizadas de firestore.rules y vuelve a intentarlo.'
                : error.message || 'No se pudo generar el código de invitación. Inténtalo nuevamente.');
            return;
        }
    }

    modal.classList.add('activo');
}

async function procesarUnion() {
    if (!usuarioActual) {
        alert('Espera a que se cargue tu perfil e inténtalo nuevamente.');
        return;
    }

    const codigoIngresado = document.getElementById('codigo-ingresado').value.trim();

    if (!codigoIngresado) {
        alert("Ingresa un código.");
        return;
    }

    try {
        await window.coalertaData.joinCommunity(codigoIngresado);

        alert(usuarioActual.rol === 'seguridad'
            ? 'Te uniste a la comunidad. Para mostrar tu ubicación como serenazgo en el mapa, activa “Compartir ubicación de serenazgo” desde tu panel de seguridad.'
            : '¡Te has unido exitosamente a la comunidad!');
        location.reload();
    } catch (error) {
        console.error("Error al unirse:", error);
        alert(error.code === 'permission-denied'
            ? 'Firestore rechazó la unión. Publica las reglas actualizadas de firestore.rules e inténtalo nuevamente.'
            : error.message || "No se pudo completar la unión. Verifica el código y vuelve a intentarlo.");
    }
}

function abrirConfirmacionSalida() {
    const role = usuarioActual?.rol;
    if (!usuarioActual?.comunidadId || !['vecino', 'seguridad'].includes(role)) return;

    const modal = document.getElementById('modal-salir-comunidad');
    const cancelButton = document.getElementById('btn-cancelar-salida');
    const status = document.getElementById('estado-salida-comunidad');
    if (!modal || !cancelButton || !status) return;

    elementoEnfoqueAntesDeSalir = document.activeElement;
    status.textContent = '';
    modal.classList.add('activo');
    cancelButton.focus();
}

function cerrarConfirmacionSalida() {
    const modal = document.getElementById('modal-salir-comunidad');
    const confirmButton = document.getElementById('btn-confirmar-salida');
    if (!modal || confirmButton?.disabled) return;
    modal.classList.remove('activo');
    if (elementoEnfoqueAntesDeSalir instanceof HTMLElement) {
        elementoEnfoqueAntesDeSalir.focus();
    }
    elementoEnfoqueAntesDeSalir = null;
}

async function confirmarSalidaComunidad() {
    if (!usuarioActual?.comunidadId || !['vecino', 'seguridad'].includes(usuarioActual.rol)) {
        cerrarConfirmacionSalida();
        return;
    }

    const cancelButton = document.getElementById('btn-cancelar-salida');
    const confirmButton = document.getElementById('btn-confirmar-salida');
    const status = document.getElementById('estado-salida-comunidad');
    if (!confirmButton || !status) return;

    confirmButton.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
    status.textContent = 'Procesando tu salida de la comunidad…';
    status.focus();
    try {
        await window.coalertaData.leaveCommunity();
        status.textContent = 'Salida confirmada. Actualizando tu cuenta…';
        location.reload();
    } catch (error) {
        console.error('No se pudo salir de la comunidad:', error);
        status.textContent = error.code === 'permission-denied'
            ? 'Firestore rechazó la operación. Verifica que las reglas actualizadas estén publicadas.'
            : error.message || 'No se pudo salir de la comunidad. Inténtalo nuevamente.';
        confirmButton.disabled = false;
        if (cancelButton) cancelButton.disabled = false;
    }
}

function obtenerIniciales(nombre) {
    if (!nombre) return "U";
    const partes = nombre.trim().split(/\s+/).filter(Boolean);
    return partes.length > 1
        ? (partes[0][0] + partes[partes.length - 1][0]).toUpperCase()
        : partes[0][0].toUpperCase();
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('activo');
}

function configurarSegunRol() {
    const esCoordinador = usuarioActual && usuarioActual.rol === 'coordinador';
    const invitar = document.getElementById('btn-generar-codigo');
    const publicar = document.getElementById('btn-nuevo-anuncio');
    const unirse = document.getElementById('btn-unirse-comunidad');
    const salir = document.getElementById('btn-salir-comunidad');

    if (invitar) invitar.hidden = !esCoordinador;
    if (publicar) publicar.hidden = !esCoordinador || !usuarioActual.comunidadId;
    if (unirse) unirse.hidden = Boolean(usuarioActual.comunidadId) ||
        !['vecino', 'seguridad'].includes(usuarioActual.rol);
    if (salir) salir.hidden = !usuarioActual.comunidadId ||
        !['vecino', 'seguridad'].includes(usuarioActual.rol);
}

function actualizarDatosSidebar() {
    const nombre = document.getElementById('sidebarNombre');
    const rol = document.getElementById('sidebarRol');
    const primerNombre = String(usuarioActual.nombre || 'usuario').trim().split(/\s+/)[0];
    if (nombre) nombre.textContent = `Hola, ${primerNombre}`;
    if (rol) rol.textContent = formatearRolVisible(usuarioActual);

    const imagen = document.getElementById('sidebarAvatarImg');
    const icono = document.getElementById('sidebarAvatarIcon');
    const foto = usuarioActual.fotoBase64 || usuarioActual.fotoURL || usuarioActual.photoURL;
    if (imagen && foto) {
        imagen.addEventListener('error', () => {
            imagen.hidden = true;
            if (icono) icono.hidden = false;
        }, { once: true });
        imagen.src = foto;
        imagen.hidden = false;
        if (icono) icono.hidden = true;
    }
}

function mostrarPerfilLocal() {
    try {
        if (localStorage.getItem('coalertaSesion') !== 'activa') return;
        const usuarioLocal = JSON.parse(localStorage.getItem('coalerta_usuario') || '{}');
        if (!usuarioLocal || typeof usuarioLocal !== 'object') return;

        usuarioActual = {
            ...usuarioLocal,
            nombre: usuarioLocal.nombre ||
                [usuarioLocal.nombres, usuarioLocal.apellidos].filter(Boolean).join(' ') ||
                (usuarioLocal.correo ? usuarioLocal.correo.split('@')[0] : 'usuario')
        };
        actualizarDatosSidebar();
    } catch (error) {
        console.error('No se pudo mostrar el perfil guardado localmente:', error);
    }
}

function leerFotoLocalUsuario(uid) {
    try {
        const usuarioLocal = JSON.parse(localStorage.getItem('coalerta_usuario') || '{}');
        return usuarioLocal.uid === uid
            ? usuarioLocal.fotoBase64 || usuarioLocal.fotoURL || usuarioLocal.photoURL || ''
            : '';
    } catch (error) {
        console.error('No se pudo leer la foto de perfil guardada en este dispositivo:', error);
        return '';
    }
}

function mostrarSinComunidad() {
    const mensaje = 'Aún no perteneces a una comunidad. Usa el botón “Unirme a una comunidad” para ingresar un código.';
    actualizarListaAmpliable(
        'miembros',
        [],
        crearFilaMiembro,
        document.getElementById('contenedor-vecinos')
    );
    actualizarListaAmpliable(
        'anuncios',
        [],
        crearFilaAnuncio,
        document.getElementById('contenedor-anuncios')
    );
    mostrarMensajeEnContenedor(document.getElementById('contenedor-vecinos'), mensaje);
    mostrarMensajeEnContenedor(document.getElementById('contenedor-anuncios'), 'No hay anuncios disponibles.');
}

function mostrarMensajeEnContenedor(contenedor, mensaje) {
    if (!contenedor) return;
    const claveLista = Object.entries(configuracionListas)
        .find(([, configuracion]) => configuracion.contenedorId === contenedor.id);
    if (claveLista) {
        listasAmpliables.delete(claveLista[0]);
        const boton = document.getElementById(claveLista[1].botonId);
        if (boton) boton.hidden = true;
    }
    contenedor.replaceChildren();
    const parrafo = document.createElement('p');
    parrafo.className = 'sin-datos';
    parrafo.textContent = mensaje;
    contenedor.appendChild(parrafo);
}

async function verPerfilVecino(miembro) {
    const nombre = miembro.nombre || 'Vecino';
    const nombrePerfil = document.getElementById('perfil-nombre');
    const rolPerfil = document.getElementById('perfil-rol');
    const inicialesPerfil = document.getElementById('perfil-iniciales');
    const fechaIngreso = document.getElementById('perfil-fecha-ingreso');
    const telefonoPerfil = document.getElementById('perfil-telefono');
    const contactosPerfil = document.getElementById('perfil-contactos-emergencia');
    const listaContactos = document.getElementById('perfil-lista-contactos-emergencia');
    const solicitudActual = ++solicitudPerfilVecino;
    if (nombrePerfil) nombrePerfil.textContent = nombre || 'Vecino';
    if (rolPerfil) rolPerfil.textContent = miembro.rol === 'seguridad'
        ? 'Personal de serenazgo'
        : miembro.rol || 'Vecino';
    if (inicialesPerfil) inicialesPerfil.textContent = obtenerIniciales(nombre);
    const fecha = miembro.fechaIngreso && typeof miembro.fechaIngreso.toDate === 'function'
        ? miembro.fechaIngreso.toDate()
        : miembro.fechaIngreso
            ? new Date(miembro.fechaIngreso)
            : null;
    if (fechaIngreso) {
        fechaIngreso.textContent = !fecha || Number.isNaN(fecha.getTime())
            ? 'Fecha de ingreso no disponible.'
            : `Se unió el ${new Intl.DateTimeFormat('es-PE', { dateStyle: 'long' }).format(fecha)}.`;
    }
    if (telefonoPerfil) {
        const telefono = String(miembro.telefono || '').trim();
        telefonoPerfil.hidden = !/^9\d{8}$/.test(telefono);
        telefonoPerfil.textContent = telefonoPerfil.hidden ? '' : `Llamar: ${telefono}`;
        telefonoPerfil.href = telefonoPerfil.hidden ? '' : `tel:${telefono}`;
    }
    if (contactosPerfil) contactosPerfil.hidden = true;
    if (listaContactos) listaContactos.replaceChildren();
    document.getElementById('modal-perfil-vecino')?.classList.add('activo');

    if (!['coordinador', 'seguridad'].includes(obtenerRolEfectivo()) ||
        !contactosPerfil || !listaContactos) return;

    contactosPerfil.hidden = false;
    const estadoContactos = document.createElement('li');
    estadoContactos.textContent = 'Cargando contactos...';
    listaContactos.appendChild(estadoContactos);
    try {
        const contactos = await window.coalertaData.getCommunityMemberEmergencyContacts(
            miembro.id || miembro.uid
        );
        if (solicitudActual !== solicitudPerfilVecino) return;
        listaContactos.replaceChildren();
        if (!contactos.length) {
            const vacio = document.createElement('li');
            vacio.textContent = 'No hay contactos de emergencia registrados.';
            listaContactos.appendChild(vacio);
            return;
        }
        contactos.forEach((contacto) => {
            const nombreContacto = String(contacto.nombre || '').trim();
            const telefonoContacto = String(contacto.telefono || '').trim();
            if (!nombreContacto || !/^9\d{8}$/.test(telefonoContacto)) return;
            const item = document.createElement('li');
            const enlace = document.createElement('a');
            enlace.href = `tel:${telefonoContacto}`;
            enlace.textContent = `${nombreContacto}: ${telefonoContacto}`;
            item.appendChild(enlace);
            listaContactos.appendChild(item);
        });
        if (!listaContactos.childElementCount) {
            const vacio = document.createElement('li');
            vacio.textContent = 'No hay contactos de emergencia registrados.';
            listaContactos.appendChild(vacio);
        }
    } catch (error) {
        if (solicitudActual !== solicitudPerfilVecino) return;
        console.error('No se pudieron cargar los contactos de emergencia:', error);
        listaContactos.replaceChildren();
        const errorContactos = document.createElement('li');
        errorContactos.textContent = 'No se pudieron cargar los contactos de emergencia.';
        listaContactos.appendChild(errorContactos);
    }
}

async function copiarCodigo() {
    const codigo = document.getElementById('codigo-generado')?.textContent.trim();
    if (!codigo) return;

    try {
        await navigator.clipboard.writeText(codigo);
        alert('Código copiado.');
    } catch (error) {
        console.error('No se pudo copiar el código:', error);
        alert(`Copia este código: ${codigo}`);
    }
}