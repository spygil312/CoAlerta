/* =========================================================
   COALERTA - COMUNIDAD.JS
========================================================= */
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    orderBy,
    query
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db } from "./firebase-config.js?v=spark-direct-firestore-1";

let usuarioActual = null;
let ubicacionCercanaActual = null;
let serviciosOpenStreetMap = 0;

// =========================================================
// 1. DETECCIÓN DE SESIÓN Y CARGA DE DATOS REALES
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
    configurarCierreSesion();
    mostrarPerfilLocal();
    configurarUbicacionCercana();
    renderizarAvisosOficiales();
    window.addEventListener('coalerta:avisos-actualizados', renderizarAvisosOficiales);
    window.addEventListener('coalerta:datos-listos', renderizarAvisosOficiales);
    window.addEventListener('coalerta:miembros-actualizados', renderizarPersonalSeguridadCercano);
    window.setInterval(renderizarPersonalSeguridadCercano, 30000);
    window.addEventListener('coalerta:comunidad-asignada', (event) => {
        const comunidadId = event.detail && event.detail.comunidadId;
        if (!usuarioActual || !comunidadId || usuarioActual.comunidadId === comunidadId) return;
        usuarioActual.comunidadId = comunidadId;
        inicializarInterfazReal();
    });
    window.addEventListener('coalerta:error', (event) => {
        if (event.detail && event.detail.area === 'comunicados') {
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

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            buscarLugaresCercanos();
            try {
                const userDoc = await getDoc(doc(db, "usuarios", user.uid));
                if (!userDoc.exists()) throw new Error("No se encontró tu perfil en Firebase.");
                const datosUsuario = userDoc.data();

                usuarioActual = {
                    uid: user.uid,
                    ...datosUsuario,
                    fotoBase64: datosUsuario.fotoBase64 || leerFotoLocalUsuario(user.uid),
                    photoURL: datosUsuario.photoURL || user.photoURL || '',
                    nombre: datosUsuario.nombre ||
                        [datosUsuario.nombres, datosUsuario.apellidos].filter(Boolean).join(' ') ||
                        user.displayName ||
                        (user.email ? user.email.split('@')[0] : 'Usuario'),
                    correo: datosUsuario.correo || datosUsuario.email || user.email || ''
                };
                usuarioActual.rol = String(usuarioActual.rol || "vecino").trim().toLowerCase();

                inicializarInterfazReal();
            } catch (error) {
                console.error('Error al cargar el perfil de usuario:', error);
                mostrarErrorComunidad('No se pudo cargar tu perfil. Verifica tu conexión e inténtalo nuevamente.');
            }
        }
    });

    function renderizarAvisosOficiales() {
        const contenedor = document.getElementById('listaAvisosOficiales');
        if (!contenedor) return;
        if (!window.coalertaData || !window.coalertaData.isReady()) {
            contenedor.textContent = 'Conectando los avisos de tu comunidad…';
            return;
        }

        try {
            const avisos = window.coalertaData.getNotices().filter((aviso) =>
                !aviso.comunidadId || aviso.comunidadId === (usuarioActual && usuarioActual.comunidadId)
            );
            contenedor.replaceChildren();
            if (!avisos.length) {
                const vacio = document.createElement('p');
                vacio.className = 'sin-datos';
                vacio.textContent = 'No hay comunicados oficiales para tu comunidad.';
                contenedor.append(vacio);
                return;
            }
            avisos.forEach((aviso) => {
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
                contenedor.append(articulo);
            });
        } catch (error) {
            console.error('No se pudieron cargar los comunicados:', error);
            contenedor.textContent = 'No se pudieron cargar los comunicados.';
        }
    }

    let solicitudUbicacionActual = 0;

    function configurarUbicacionCercana() {
        const boton = document.getElementById('btnActualizarUbicacion');
        if (boton) boton.addEventListener('click', () => buscarLugaresCercanos(true));
    }

    function buscarLugaresCercanos(forzarActualizacion = false) {
        const solicitud = ++solicitudUbicacionActual;
        const boton = document.getElementById('btnActualizarUbicacion');
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
            establecerEstadoUbicacion('Buscando servicios y lugares a menos de 5 km...', 'cargando');

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
                mostrarErrorUbicacion('No se pudieron cargar los lugares cercanos. Comprueba tu conexión e inténtalo nuevamente.');
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

    async function consultarOpenStreetMap(latitud, longitud) {
        const radio = 5000;
        const entorno = (filtro) => `nwr(around:${radio},${latitud},${longitud})${filtro};`;
        const consulta = [
            '[out:json][timeout:12];',
            '(',
            entorno('["amenity"="police"]'),
            entorno('["name"~"serenazgo|seguridad ciudadana|comisaria|polic[ií]a",i]'),
            entorno('["leisure"~"park|playground"]'),
            entorno('["amenity"~"school|hospital|clinic|doctors|community_centre|marketplace"]'),
            entorno('["place"~"neighbourhood|suburb|quarter|village"]'),
            ');out center tags;'
        ].join('');
        const servidores = [
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass-api.de/api/interpreter'
        ];
        let ultimoError;

        for (const servidor of servidores) {
            const controlador = new AbortController();
            const temporizador = window.setTimeout(() => controlador.abort(), 8000);
            try {
                const respuesta = await fetch(servidor, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: `data=${encodeURIComponent(consulta)}`,
                    signal: controlador.signal
                });
                if (!respuesta.ok) throw new Error(`OpenStreetMap respondió con estado ${respuesta.status}.`);
                const datos = await respuesta.json();
                if (!Array.isArray(datos.elements)) throw new Error('La respuesta de OpenStreetMap no contiene lugares.');
                return datos.elements;
            } catch (error) {
                ultimoError = error;
                console.warn(`No respondió el servicio de mapas ${servidor}:`, error);
            } finally {
                window.clearTimeout(temporizador);
            }
        }
        throw ultimoError || new Error('No hay servicios de mapas disponibles.');
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
        const zonas = [];
        const lugares = [];
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
            } else if (detalle.tipo === 'zona') {
                zonas.push(detalle);
            } else {
                lugares.push(detalle);
            }
        });

        servicios.sort((a, b) => a.distancia - b.distancia);
        zonas.sort((a, b) => a.distancia - b.distancia);
        lugares.sort((a, b) => a.distancia - b.distancia);

        const cantidadServicios = servicios.length;
        serviciosOpenStreetMap = cantidadServicios;
        const lugaresConZona = [...zonas, ...lugares].sort((a, b) => a.distancia - b.distancia);
        renderizarListaCercana('listaServiciosCercanos', servicios.slice(0, 6), 'servicio');
        renderizarListaCercana('listaLugaresCercanos', lugaresConZona.slice(0, 8), 'lugar');
        establecerTextoCercano('contadorServiciosSeguridad', cantidadServicios);
        establecerTextoCercano('contadorZonas', zonas.length);
        establecerTextoCercano('contadorLugares', lugares.length);
    }

    function renderizarPersonalSeguridadCercano() {
        const contenedor = document.getElementById('listaServiciosCercanos');
        const data = window.coalertaData;
        if (!contenedor || !data || !data.isReady()) return;

        contenedor.querySelectorAll('[data-miembro-seguridad]').forEach((elemento) => elemento.remove());
        const miembros = data.getCommunityMembers()
            .filter((miembro) => miembro.rol === 'seguridad')
            .sort((primero, segundo) => String(primero.nombre || '').localeCompare(String(segundo.nombre || ''), 'es'));

        let personalCercanoCompartiendoUbicacion = 0;
        miembros.forEach((miembro) => {
            const actualizado = miembro.ubicacionActualizadaAt
                ? new Date(miembro.ubicacionActualizadaAt).getTime()
                : NaN;
            const tieneUbicacion = miembro.ubicacionCompartida === true &&
                Date.now() - actualizado <= 2 * 60 * 1000 &&
                Number.isFinite(Number(miembro.latitud)) &&
                Number.isFinite(Number(miembro.longitud));
            const distancia = tieneUbicacion && ubicacionCercanaActual
                ? distanciaEnMetros(
                    ubicacionCercanaActual.latitud,
                    ubicacionCercanaActual.longitud,
                    Number(miembro.latitud),
                    Number(miembro.longitud)
                )
                : null;
            if (distancia !== null && distancia > 5000) return;
            if (tieneUbicacion) personalCercanoCompartiendoUbicacion += 1;

            const fila = document.createElement('article');
            fila.className = 'item-autoridad card-interna';
            fila.dataset.miembroSeguridad = miembro.uid || miembro.id;

            const icono = document.createElement('div');
            icono.className = 'autoridad-icono';
            const iconoI = document.createElement('i');
            iconoI.className = 'fa-solid fa-user-shield';
            iconoI.setAttribute('aria-hidden', 'true');
            icono.appendChild(iconoI);

            const info = document.createElement('div');
            info.className = 'autoridad-info';
            const titulo = document.createElement('h4');
            titulo.textContent = miembro.nombre || 'Personal de serenazgo';
            const descripcion = document.createElement('p');
            descripcion.textContent = tieneUbicacion
                ? `Personal de serenazgo · ${distancia === null ? 'Ubicación compartida' : formatearDistancia(distancia)}`
                : 'Personal de serenazgo · Ubicación no compartida';
            info.append(titulo, descripcion);
            fila.append(icono, info);

            if (tieneUbicacion) {
                const enlace = document.createElement('a');
                enlace.className = 'enlace-lugar-cercano';
                enlace.href = `mapa.html?lat=${encodeURIComponent(miembro.latitud)}&lng=${encodeURIComponent(miembro.longitud)}`;
                enlace.textContent = 'Ver mapa';
                enlace.setAttribute('aria-label', `Ver la ubicación compartida de ${titulo.textContent} en el mapa`);
                fila.appendChild(enlace);
            }
            contenedor.appendChild(fila);
        });
        establecerTextoCercano(
            'contadorServiciosSeguridad',
            serviciosOpenStreetMap + personalCercanoCompartiendoUbicacion
        );
    }

    function clasificarLugarCercano(etiquetas, nombre) {
        if (/serenazgo/i.test(nombre)) return 'serenazgo';
        if (etiquetas.amenity === 'police') return 'comisaria';
        if (etiquetas.place) return 'zona';
        if (etiquetas.leisure === 'park' || etiquetas.leisure === 'playground') return 'parque';
        if (['hospital', 'clinic', 'doctors'].includes(etiquetas.amenity)) return 'salud';
        if (etiquetas.amenity === 'school') return 'educacion';
        if (etiquetas.amenity === 'community_centre') return 'comunidad';
        if (etiquetas.amenity === 'marketplace') return 'mercado';
        return 'lugar';
    }

    function renderizarListaCercana(id, elementos, tipoLista) {
        const contenedor = document.getElementById(id);
        if (!contenedor) return;
        contenedor.replaceChildren();

        if (!elementos.length) {
            const mensaje = tipoLista === 'servicio'
                ? 'OpenStreetMap no tiene comisarías o puntos de serenazgo registrados cerca de esta ubicación.'
                : 'No se encontraron zonas ni lugares importantes registrados en los alrededores.';
            agregarMensajeCercano(contenedor, mensaje);
            return;
        }

        elementos.forEach((elemento) => {
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
            descripcion.textContent = `${etiquetaTipoLugar(elemento.tipo)} · ${formatearDistancia(elemento.distancia)}`;
            info.append(titulo, descripcion);

            const enlace = document.createElement('a');
            enlace.className = tipoLista === 'servicio' ? 'enlace-lugar-cercano' : 'icono-flecha';
            enlace.href = `https://www.openstreetmap.org/?mlat=${elemento.latitud}&mlon=${elemento.longitud}#map=17/${elemento.latitud}/${elemento.longitud}`;
            enlace.target = '_blank';
            enlace.rel = 'noopener noreferrer';
            enlace.setAttribute('aria-label', `Ver ${elemento.nombre} en OpenStreetMap`);
            if (tipoLista === 'servicio') {
                enlace.textContent = 'Ver mapa';
            } else {
                const flecha = document.createElement('i');
                flecha.className = 'fa-solid fa-chevron-right';
                flecha.setAttribute('aria-hidden', 'true');
                enlace.appendChild(flecha);
            }
            fila.append(icono, info, enlace);
            contenedor.appendChild(fila);
        });
    }

    function obtenerIconoLugar(tipo) {
        const iconos = {
            serenazgo: 'fa-user-shield',
            comisaria: 'fa-shield-halved',
            parque: 'fa-tree',
            salud: 'fa-kit-medical',
            educacion: 'fa-school',
            comunidad: 'fa-people-group',
            mercado: 'fa-store',
            zona: 'fa-map-location-dot'
        };
        return iconos[tipo] || 'fa-location-dot';
    }

    function etiquetaTipoLugar(tipo) {
        const etiquetas = {
            serenazgo: 'Serenazgo',
            comisaria: 'Comisaría / policía',
            parque: 'Parque o zona recreativa',
            salud: 'Centro de salud',
            educacion: 'Centro educativo',
            comunidad: 'Centro comunitario',
            mercado: 'Mercado',
            zona: 'Zona o localidad',
            lugar: 'Lugar importante'
        };
        return etiquetas[tipo] || etiquetas.lugar;
    }

    function distanciaEnMetros(lat1, lon1, lat2, lon2) {
        const radianes = (grados) => grados * Math.PI / 180;
        const diferenciaLat = radianes(lat2 - lat1);
        const diferenciaLon = radianes(lon2 - lon1);
        const a = Math.sin(diferenciaLat / 2) ** 2 +
            Math.cos(radianes(lat1)) * Math.cos(radianes(lat2)) *
            Math.sin(diferenciaLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function formatearDistancia(metros) {
        return metros < 1000
            ? `${Math.round(metros)} m`
            : `${(metros / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} km`;
    }

    function establecerEstadoUbicacion(mensaje, estado) {
        const elemento = document.getElementById('estadoUbicacion');
        if (!elemento) return;
        elemento.textContent = mensaje;
        elemento.dataset.estado = estado;
    }

    function establecerListaCercana(id, mensaje) {
        const contenedor = document.getElementById(id);
        if (contenedor) agregarMensajeCercano(contenedor, mensaje);
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

    function mostrarErrorUbicacion(mensaje) {
        establecerEstadoUbicacion(mensaje, 'error');
        establecerListaCercana('listaServiciosCercanos', 'Activa el permiso de ubicación y pulsa “Actualizar ubicación” para volver a buscar.');
        establecerListaCercana('listaLugaresCercanos', 'Los resultados dependen del permiso de ubicación y de los datos disponibles en OpenStreetMap.');
        const boton = document.getElementById('btnActualizarUbicacion');
        if (boton) boton.disabled = false;
    }
});

// =========================================================
// 2. SUSCRIPCIONES EN TIEMPO REAL (FIRESTORE)
// =========================================================
function inicializarInterfazReal() {
    configurarSegunRol();
    actualizarDatosSidebar();

    if (!usuarioActual.comunidadId) {
        mostrarSinComunidad();
        return;
    }

    cargarVecinosEnTiempoReal();
    cargarAnunciosEnTiempoReal();
    renderizarAvisosOficiales();
}

// Escucha cambios en tiempo real en la colección 'vecinos' de la comunidad
function cargarVecinosEnTiempoReal() {
    const contenedor = document.getElementById('contenedor-vecinos');
    if (!contenedor) return;

    onSnapshot(collection(doc(db, "comunidades", usuarioActual.comunidadId), "miembros"), (snapshot) => {
          contenedor.replaceChildren();

          if (snapshot.empty) {
              mostrarMensajeEnContenedor(contenedor, 'No hay miembros registrados en esta comunidad.');
              return;
          }

          snapshot.forEach((doc) => {
              const vecino = doc.data();
              const nombre = vecino.nombre || 'Vecino';
              const rol = vecino.rol === 'seguridad'
                  ? 'Personal de serenazgo'
                  : vecino.rol || 'Vecino';
              const fila = document.createElement('button');
              fila.type = 'button';
              fila.className = 'item-fila';
              fila.setAttribute('aria-label', `Ver perfil de ${nombre}`);
              fila.addEventListener('click', () => verPerfilVecino(vecino));

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
              contenedor.appendChild(fila);
          });
      }, (error) => {
          console.error('Error al cargar vecinos:', error);
          mostrarMensajeEnContenedor(contenedor, 'No se pudieron cargar los vecinos.');
      });
}

// Escucha anuncios en tiempo real creados por los miembros
function cargarAnunciosEnTiempoReal() {
    const contenedor = document.getElementById('contenedor-anuncios');
    if (!contenedor) return;

    onSnapshot(query(
      collection(doc(db, "comunidades", usuarioActual.comunidadId), "anuncios"),
      orderBy("fecha", "desc")
    ), (snapshot) => {
          contenedor.innerHTML = '';

          if (snapshot.empty) {
              mostrarMensajeEnContenedor(contenedor, 'No hay anuncios publicados.');
              return;
          }

          snapshot.forEach((doc) => {
              const anuncio = doc.data();
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

              const esAutorOCoordinador =
                  usuarioActual.rol === 'coordinador' || anuncio.autorUid === usuarioActual.uid;
              if (esAutorOCoordinador) {
                  const botonBorrar = document.createElement('button');
                  botonBorrar.type = 'button';
                  botonBorrar.className = 'btn-borrar-anuncio';
                  botonBorrar.setAttribute('aria-label', 'Eliminar anuncio');
                  botonBorrar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
                  botonBorrar.addEventListener('click', () => borrarAnuncioReal(doc.id));
                  fila.appendChild(botonBorrar);
              }

              contenedor.appendChild(fila);
          });
      }, (error) => {
          console.error('Error al cargar anuncios:', error);
          mostrarMensajeEnContenedor(contenedor, 'No se pudieron cargar los anuncios.');
      });
}

// =========================================================
// 3. ACCIONES DE ESCRITURA REALES (INSERTAR / ELIMINAR)
// =========================================================

// Publicar un anuncio real en Firestore
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

// Eliminar un anuncio de la base de datos real
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

// Generación de código de invitación real registrado en la DB
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

// Unirse a una comunidad validando contra Firestore
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

// =========================================================
// 4. UTILIDADES
// =========================================================
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

    if (invitar) invitar.hidden = !esCoordinador;
    if (publicar) publicar.hidden = !esCoordinador || !usuarioActual.comunidadId;
    if (unirse) unirse.hidden = Boolean(usuarioActual.comunidadId) ||
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

function formatearRolVisible(usuario) {
    const valor = String(usuario.rol || 'vecino').trim();
    const normalizado = valor.toLocaleLowerCase();
    const roleLabels = {
        vecino: 'Vecino',
        residente: 'Vecino',
        coordinador: 'Coordinador vecinal',
        seguridad: 'Personal de seguridad',
        agente: 'Personal de seguridad'
    };
    const rol = roleLabels[normalizado] ||
        (['vecino / residente', 'vecino/residente'].includes(normalizado)
            ? 'Vecino'
            : valor.charAt(0).toLocaleUpperCase() + valor.slice(1));
    if (normalizado === 'vecino' && usuario.estadoSolicitudRol === 'pendiente' && usuario.rolSolicitud) {
        const solicitado = usuario.rolSolicitud === 'coordinador'
            ? 'Coordinador vecinal'
            : usuario.rolSolicitud === 'seguridad' ? 'Personal de seguridad' : usuario.rolSolicitud;
        return `${solicitado} (pendiente)`;
    }
    return rol;
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
    mostrarMensajeEnContenedor(document.getElementById('contenedor-vecinos'), mensaje);
    mostrarMensajeEnContenedor(document.getElementById('contenedor-anuncios'), 'No hay anuncios disponibles.');
}

function mostrarErrorComunidad(mensaje) {
    mostrarMensajeEnContenedor(document.getElementById('contenedor-vecinos'), mensaje);
    mostrarMensajeEnContenedor(document.getElementById('contenedor-anuncios'), mensaje);
}

function mostrarMensajeEnContenedor(contenedor, mensaje) {
    if (!contenedor) return;
    contenedor.replaceChildren();
    const parrafo = document.createElement('p');
    parrafo.className = 'sin-datos';
    parrafo.textContent = mensaje;
    contenedor.appendChild(parrafo);
}

function verPerfilVecino(miembro) {
    const nombre = miembro.nombre || 'Vecino';
    const nombrePerfil = document.getElementById('perfil-nombre');
    const rolPerfil = document.getElementById('perfil-rol');
    const inicialesPerfil = document.getElementById('perfil-iniciales');
    const fechaIngreso = document.getElementById('perfil-fecha-ingreso');
    const telefonoPerfil = document.getElementById('perfil-telefono');
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
        telefonoPerfil.hidden = !/^\d{9}$/.test(telefono);
        telefonoPerfil.textContent = telefonoPerfil.hidden ? '' : `Llamar: ${telefono}`;
        telefonoPerfil.href = telefonoPerfil.hidden ? '' : `tel:${telefono}`;
    }
    document.getElementById('modal-perfil-vecino')?.classList.add('activo');
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

function configurarCierreSesion() {
    const boton = document.getElementById('btnCerrarSesionLateral');
    if (!boton) return;

    boton.addEventListener('click', async (evento) => {
        evento.preventDefault();
        try {
            await signOut(auth);
            window.location.replace('login.html');
        } catch (error) {
            console.error('Error al cerrar sesión:', error);
            alert('No se pudo cerrar la sesión. Inténtalo nuevamente.');
        }
    });
}