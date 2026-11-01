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

## ⚙️ Instalación y Uso Local
Al ser un proyecto desarrollado con tecnologías web estándar (sin frameworks complejos), su ejecución local es muy sencilla:

1. **Clonar el repositorio:**
   ```bash
   git clone [https://github.com/spygil312/CoAlerta.git](https://github.com/spygil312/CoAlerta.git)

1. Abrir el proyecto: Abre la carpeta del proyecto en tu editor de código preferido (ej. Visual Studio Code).
2. Configurar Firebase: Asegúrate de que el archivo firebase-config.js contenga las credenciales de tu proyecto de Firebase.
3. Ejecutar servidor local: Usa la extensión Live Server en VS Code (o cualquier servidor HTTP local) para abrir el archivo index.html.(Nota: Para que el inicio de sesión con Google funcione localmente, asegúrate de que el puerto y localhost estén en los dominios autorizados de tu consola de Firebase).

---

## 👨‍💻 Créditos
Este proyecto es de código abierto y fue desarrollado por:
Giliam de la Rosa Toro

## 📄 Licencia
Este proyecto es de Código Abierto (Open Source). Está disponible de forma libre y gratuita para cualquier persona que tenga el enlace al repositorio, permitiendo su uso, estudio y modificación comunitaria.

   
