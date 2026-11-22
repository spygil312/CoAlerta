# 🚨 CoAlerta

**Sistema comunitario de alertas de seguridad en tiempo real.**

CoAlerta es una aplicación web progresiva diseñada para mejorar la seguridad vecinal mediante la geolocalización, el reporte de incidentes en tiempo real y la gestión eficiente del personal de seguridad. Permite a los vecinos y transeúntes reportar emergencias que son gestionadas por coordinadores y atendidas por patrullas asignadas.

---

## 🚀 Demo en Vivo
El proyecto se encuentra desplegado y accesible para el público a través de GitHub Pages:
🔗 **https://spygil312.github.io/CoAlerta/**

---

## ✨ Características Principales

### 👥 Sistema de Roles Jerárquico
- **Administrador:** Gestiona las solicitudes de acceso, aprueba coordinadores y asigna unidades móviles (patrullas) al personal de seguridad.
- **Coordinador Vecinal:** Administra su comunidad, genera invitaciones de acceso para vecinos y filtra/valida las alertas de su sector.
- **Personal de Seguridad:** Recibe las alertas validadas y las emergencias públicas. Cuenta con un botón de "Despachar" que se habilita únicamente si tienen una unidad asignada y su GPS está activo.
- **Vecino:** Puede visualizar las alertas de su comunidad y reportar incidentes.
- **Usuario Anónimo:** Cualquier persona puede usar el botón de pánico en la pantalla de inicio para reportar emergencias públicas en un radio cercano.

### 🗺️ Geolocalización Inteligente
- Integración de mapas interactivos que muestran marcadores de incidentes en tiempo real.
- Uso de la **Fórmula de Haversine** en el cliente para calcular distancias y mostrar a los usuarios sin registro únicamente las emergencias abiertas en un radio de 5 km.
- Privacidad de datos: Las alertas comunitarias están restringidas exclusivamente a los miembros de dicha comunidad.

### 🔐 Autenticación y Seguridad
- Inicio de sesión dual (Google Sign-In y Correo/Contraseña) con vinculación automática de cuentas (Account Linking).
- Acceso rápido para emergencias mediante **Firebase Anonymous Authentication**.
- Eliminación de cuenta iniciada por el titular, con limpieza y anonimización de referencias mediante reglas de Firestore.
- Reglas de seguridad quirúrgicas (Firestore Rules) para evitar spam, modificaciones no autorizadas y proteger la privacidad de cada comunidad.

---

## 🛠️ Tecnologías Utilizadas
- **Frontend:** HTML5, CSS3, JavaScript.
- **Backend as a Service (BaaS):** Firebase (Spark Plan).
  - *Firebase Authentication* (Google, Email/Password, Anónimo).
  - *Cloud Firestore* (Base de datos NoSQL en tiempo real).
  - *Firestore Security Rules*.
- **Despliegue:** GitHub Pages.

---

## 👨‍💻 Créditos
Giliam de la Rosa Toro
Gerardo Altamirano
Alejandro Condori
Félix Vargas
Rafael Miranda

## 📄 Licencia
Este proyecto es de Código Abierto (Open Source). Está disponible de forma libre y gratuita para cualquier persona que tenga el enlace al repositorio, permitiendo su uso, estudio y modificación comunitaria.
