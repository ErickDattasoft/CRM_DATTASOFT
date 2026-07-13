import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, onSnapshot, addDoc, updateDoc, arrayUnion, serverTimestamp, enableMultiTabIndexedDbPersistence, runTransaction } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "firebase/auth";

// Configuración de Firebase — los valores web son públicos por diseño (seguridad via Firestore Rules)
const firebaseConfig = {
  apiKey:     import.meta.env.PUBLIC_FIREBASE_API_KEY     || "AIzaSyDT6EkBk0pMA9t_APJlLPku_EWco_OMM3Q",
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN || "agenda-crm-netlify.firebaseapp.com",
  projectId:  import.meta.env.PUBLIC_FIREBASE_PROJECT_ID  || "agenda-crm-netlify",
};

export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId
);

// Firestore rechaza valores `undefined` con "invalid-argument".
// JSON round-trip los elimina de objetos y los convierte a null en arrays.
const limpiar = (data) => JSON.parse(JSON.stringify(data ?? null));

// Muchas funciones guardarX() devuelven simplemente `false` en error, y varios call sites en
// index.astro nunca revisan ese valor de retorno — el usuario veía "guardado" aunque Firestore
// hubiera rechazado el escrito (ej. documento de 1MB lleno). En vez de perseguir cada call site,
// se dispara un evento global aquí mismo: index.astro escucha una sola vez y muestra un aviso
// sin importar si quien llamó revisó el resultado o no.
function avisarErrorGuardado(operacion, error) {
  console.error(`Error al guardar (${operacion}):`, error);
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("crm:write-error", {
      detail: { operacion, mensaje: error?.code || error?.message || String(error) }
    }));
  }
}

const app  = firebaseEnabled ? initializeApp(firebaseConfig) : null;
const db   = firebaseEnabled ? getFirestore(app) : null;
const auth = firebaseEnabled ? getAuth(app) : null;

// Persistencia offline (IndexedDB): permite leer el último snapshot conocido sin conexión y
// deja en cola las escrituras hasta reconectar. Multi-tab para no romper si el usuario tiene
// el CRM abierto en varias pestañas a la vez (la versión single-tab falla en ese caso).
if (db) {
  enableMultiTabIndexedDbPersistence(db).catch(err => {
    if (err.code === "failed-precondition") {
      console.warn("[CRM] Persistencia offline no disponible (múltiples pestañas sin soporte multi-tab).");
    } else if (err.code === "unimplemented") {
      console.warn("[CRM] Persistencia offline no soportada en este navegador.");
    } else {
      console.warn("[CRM] No se pudo activar persistencia offline:", err);
    }
  });
}


// Iniciar sesión anónima automáticamente al cargar el módulo.
// Resuelve una promesa cuando el auth está listo para que Firestore
// no reciba llamadas antes de tener credenciales.
let _authResolve;
export const authListo = new Promise(res => { _authResolve = res; });

/**
 * true si la sesión de Firebase Auth de este navegador es anónima (o no hay ninguna) —
 * es decir, este dispositivo específico nunca inició sesión con una cuenta segura real
 * (correo+contraseña). Las reglas de Firestore rechazan escrituras de sesiones anónimas,
 * así que si esto es true, cualquier guardado va a fallar sin importar que el login viejo
 * (usuario+contraseña local) haya "funcionado" para entrar a la UI.
 */
export function sesionEsAnonima() {
  return auth?.currentUser?.isAnonymous ?? true;
}

if (auth) {
  onAuthStateChanged(auth, user => {
    if (user) {
      _authResolve(user);
    } else {
      signInAnonymously(auth)
        .then(cred => _authResolve(cred.user))
        .catch(err => { console.warn("[CRM] Auth anónima falló:", err); _authResolve(null); });
    }
  });
} else {
  _authResolve(null);
}

/**
 * Suscribe al documento principal del CRM con onSnapshot para sync en tiempo real.
 * callback(datos, hasPendingWrites) — llama inmediatamente con el estado actual y cada vez que cambie.
 * onError(error) opcional — antes un error de permisos (ej. reglas de Firestore rechazando una
 * sesión anónima) solo se registraba en la consola del navegador, sin avisarle nada al usuario;
 * la app tardaba 7s en mostrar un mensaje genérico de "error de conexión" que no explicaba que
 * hacía falta iniciar sesión con la cuenta segura.
 * Retorna la función de unsuscribe para limpiar el listener.
 */
export function suscribirCRM(callback, onError) {
  if (!firebaseEnabled) return () => {};
  const docRef = doc(db, "agenda", "datos");
  return onSnapshot(
    docRef,
    (docSnap) => callback(
      docSnap.exists() ? docSnap.data() : null,
      docSnap.metadata.hasPendingWrites
    ),
    (error) => {
      console.error("[CRM] Error en listener Firebase:", error);
      if (onError) onError(error);
    }
  );
}

/**
 * Carga todos los datos del CRM desde Firestore (clientes, versiones, cartas, plantilla, tickets, contactos, config).
 * Retorna null si el documento no existe.
 */
export async function cargarDatosCRM() {
  try {
    const docRef = doc(db, "agenda", "datos");
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
    return null;
  } catch (error) {
    console.error("Error al cargar datos de Firestore:", error);
    throw error;
  }
}

/**
 * Guarda los datos de clientes actualizados en Firestore.
 */
export async function guardarClientes(clientes) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { clientes: limpiar(clientes) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("clientes", error);
    return { error: error?.code || error?.message || String(error) };
  }
}

/**
 * Guarda las versiones oficiales y los links de cartas técnicas en Firestore.
 */
export async function guardarConfiguracion(versionesMercado, cartasTecnicas) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { versionesMercado, cartasTecnicas }, { merge: true });
    return { ok: true };
  } catch (error) {
    avisarErrorGuardado("configuración de versiones", error);
    return { ok: false, msg: error?.message || error?.code || String(error) };
  }
}

/**
 * Guarda la plantilla de notificaciones en Firestore.
 */
export async function guardarPlantilla(plantillaMensaje) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { plantillaMensaje }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("plantilla de mensaje", error);
    return false;
  }
}

/**
 * Guarda los tickets de soporte en Firestore.
 */
export async function guardarTickets(tickets) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { tickets: limpiar(tickets) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("tickets", error);
    return false;
  }
}

/**
 * Guarda los contactos del CRM en Firestore.
 */
export async function guardarContactos(contactos) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { contactos: limpiar(contactos) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("contactos", error);
    return false;
  }
}

/**
 * Guarda la configuración de campos de tickets (tipos, estados, grupos, agentes, etc.) en Firestore.
 * Escribe cada campo recibido como una ruta anidada ("configTickets.estados", "configTickets.sla", ...)
 * para que un guardado parcial (ej. solo SLA) nunca pise otros campos (ej. estados) que otra
 * sesión haya modificado mientras tanto — antes se mandaba el objeto configTickets completo,
 * lo que provocaba que guardados de una sesión con datos desactualizados borraran cambios recientes.
 */
export async function guardarConfigTickets(configTickets) {
  try {
    const docRef = doc(db, "agenda", "datos");
    const data = {};
    for (const [key, value] of Object.entries(configTickets)) {
      data[`configTickets.${key}`] = value;
    }
    await updateDoc(docRef, data);
    return true;
  } catch (error) {
    avisarErrorGuardado("configuración de tickets", error);
    return false;
  }
}

/**
 * Lee todos los tickets enviados desde el portal público (colección tickets_publicos).
 */
export async function cargarTicketsPublicos() {
  try {
    const colRef = collection(db, "tickets_publicos");
    const snap = await getDocs(colRef);
    return snap.docs.map(d => ({ _fbId: d.id, ...d.data() }));
  } catch (error) {
    console.error("Error al cargar tickets públicos:", error);
    return [];
  }
}

/**
 * Guarda la lista de usuarios del CRM en Firestore.
 */
export async function guardarUsuarios(usuarios) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { usuarios }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("usuarios", error);
    return false;
  }
}

/**
 * Guarda los eventos del CRM en Firestore.
 */
export async function guardarEventosFB(eventos) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { eventos }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("eventos", error);
    return false;
  }
}

/**
 * Guarda la papelera de tickets en Firestore.
 */
export async function guardarPapelera(papelera) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { papelera }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("papelera", error);
    return false;
  }
}

/**
 * Guarda el contenido del Acerca De en Firestore.
 */
export async function guardarAcercaDe(acercaDe) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { acercaDe }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("Acerca De", error);
    return false;
  }
}

/**
 * Guarda la configuración del proveedor de correo en Firestore.
 */
export async function guardarConfigCorreo(configCorreo) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { configCorreo }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("configuración de correo", error);
    return false;
  }
}

/**
 * Guarda la configuración de automatizaciones n8n (webhook, destinatarios de WhatsApp,
 * reglas de notificación) en Firestore.
 */
export async function guardarConfigN8n(n8n) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { n8n: limpiar(n8n) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("configuración de n8n", error);
    return false;
  }
}

/**
 * Sobrescribe por completo la bitácora del CRM en Firestore. Úsalo solo para operaciones que de
 * verdad quieren reemplazar el arreglo entero (limpiar toda la bitácora, recortar entradas de
 * +60 días justo después de leer un snapshot fresco) — nunca para agregar una entrada suelta:
 * dos sesiones que llamen esto casi al mismo tiempo, cada una con su propia copia en memoria del
 * arreglo, se pisan entre sí y la que escribe al final borra silenciosamente lo que la otra
 * acababa de agregar. Para agregar una entrada, usa agregarEntradaBitacora().
 */
export async function guardarBitacora(bitacora) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { bitacora }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("bitácora", error);
    return false;
  }
}

/**
 * Agrega una sola entrada a la bitácora de forma atómica (arrayUnion), sin necesitar leer ni
 * mandar el arreglo completo. A diferencia de guardarBitacora(bitacora_completa), esto no se
 * pierde aunque otra sesión escriba al mismo tiempo con una copia desactualizada del arreglo —
 * cada entrada nueva sencillamente se agrega en el servidor, nunca sobrescribe lo que ya había.
 */
export async function agregarEntradaBitacora(entry) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await updateDoc(docRef, { bitacora: arrayUnion(limpiar(entry)) });
    return true;
  } catch (error) {
    avisarErrorGuardado("bitácora", error);
    return false;
  }
}

// ================================================================
// COTIZACIONES
// ================================================================

/**
 * Reserva de forma atómica el siguiente folio consecutivo de cotización para el año dado
 * (ej. 3 → "COT-2026-003"). Usa runTransaction para que, si dos pestañas llaman esto casi al
 * mismo tiempo, Firestore serialice ambas lecturas+escrituras y ninguna calcule el mismo número
 * — a diferencia de Math.max(...tickets.map(t=>t.numero))+1 (el patrón que usan hoy los Tickets),
 * que sí puede duplicarse bajo uso concurrente, la misma clase de condición de carrera que causó
 * la pérdida real de entradas de Bitácora arreglada en agregarEntradaBitacora(). El contador vive
 * en agenda/datos.contadorCotizaciones = { "2026": 3, ... }.
 */
export async function obtenerSiguienteFolioCotizacion(anio) {
  try {
    const docRef = doc(db, "agenda", "datos");
    const numero = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(docRef);
      const contador = snap.exists() ? (snap.data().contadorCotizaciones || {}) : {};
      const actual = contador[String(anio)] || 0;
      const siguiente = actual + 1;
      transaction.update(docRef, { [`contadorCotizaciones.${anio}`]: siguiente });
      return siguiente;
    });
    const folio = `COT-${anio}-${String(numero).padStart(3, "0")}`;
    return { ok: true, numero, folio };
  } catch (error) {
    avisarErrorGuardado("folio de cotización", error);
    return { ok: false, error: error?.code || error?.message || String(error) };
  }
}

/**
 * Agrega una sola cotización nueva de forma atómica (arrayUnion), igual que
 * agregarEntradaBitacora(): nunca sobrescribe cotizaciones creadas por otra pestaña casi al
 * mismo tiempo. Úsalo solo para el primer guardado de una cotización nueva (o al duplicar); para
 * editar una cotización ya existente usa guardarCotizaciones() con el arreglo completo.
 */
export async function agregarCotizacion(cotizacion) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await updateDoc(docRef, { cotizaciones: arrayUnion(limpiar(cotizacion)) });
    return true;
  } catch (error) {
    avisarErrorGuardado("cotización", error);
    return false;
  }
}

/**
 * Guarda el arreglo completo de cotizaciones en Firestore. Úsalo para ediciones sobre
 * cotizaciones ya existentes (cambio de estado, editar conceptos, etc.) — no para crear una
 * cotización nueva (usa agregarCotizacion() para eso, ver por qué en su comentario).
 */
export async function guardarCotizaciones(cotizaciones) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { cotizaciones: limpiar(cotizaciones) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("cotizaciones", error);
    return false;
  }
}

/**
 * Guarda la configuración de Cotizaciones (términos/condiciones por defecto y catálogo de
 * conceptos rápidos) en Firestore.
 */
export async function guardarConfigCotizaciones(configCotizaciones) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { configCotizaciones: limpiar(configCotizaciones) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("configuración de cotizaciones", error);
    return false;
  }
}

// ================================================================
// BASE DE CONOCIMIENTO (KB)
// ================================================================

export async function cargarKB() {
  try {
    const snap = await getDocs(collection(db, "knowledge_base"));
    return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  } catch (e) { console.error("[KB] Error al cargar:", e); return []; }
}

export async function crearDocKB(data) {
  try {
    const ref = await addDoc(collection(db, "knowledge_base"), {
      ...data, created_at: serverTimestamp(), updated_at: serverTimestamp(), content_updated_at: serverTimestamp()
    });
    return ref.id;
  } catch (e) { console.error("[KB] Error al crear:", e); return null; }
}

export async function actualizarDocKB(id, data) {
  try {
    await updateDoc(doc(db, "knowledge_base", id), { ...data, updated_at: serverTimestamp(), content_updated_at: serverTimestamp() });
    return true;
  } catch (e) { console.error("[KB] Error al actualizar:", e); return false; }
}

// Actualiza solo el sourcePath sin modificar updated_at ni content_updated_at
export async function actualizarSourcePathKB(id, sourcePath) {
  try {
    await updateDoc(doc(db, "knowledge_base", id), { sourcePath });
    return true;
  } catch (e) { console.error("[KB] Error al actualizar sourcePath:", e); return false; }
}

export async function eliminarDocKB(id) {
  try {
    await deleteDoc(doc(db, "knowledge_base", id));
    return true;
  } catch (e) { console.error("[KB] Error al eliminar:", e); return false; }
}

export async function guardarKBAcceso(kbAcceso) {
  try {
    await setDoc(doc(db, "agenda", "datos"), { kbAcceso }, { merge: true });
    return true;
  } catch (e) { console.error("[KB] Error al guardar acceso:", e); return false; }
}

export function suscribirKB(callback) {
  if (!firebaseEnabled) return () => {};
  return onSnapshot(
    collection(db, "knowledge_base"),
    snap => callback(snap.docs.map(d => ({ _id: d.id, ...d.data() }))),
    err => console.error("[KB] Error en listener:", err)
  );
}

/**
 * Guarda el logotipo de empresa (base64 comprimido) en Firestore.
 */
export async function guardarLogo(logoBase64) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { logoEmpresa: logoBase64 }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("logo", error);
    return false;
  }
}

/**
 * Elimina un ticket del área pública (tras ser importado al CRM o rechazado).
 */
export async function eliminarTicketPublico(fbId) {
  try {
    await deleteDoc(doc(db, "tickets_publicos", fbId));
    return true;
  } catch (error) {
    console.error("Error al eliminar ticket público:", error);
    return false;
  }
}

export async function guardarInteracciones(interacciones) {
  try {
    await setDoc(doc(db, "agenda", "datos"), { interacciones: limpiar(interacciones) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("interacciones", error);
    return false;
  }
}

export async function guardarTareas(tareas) {
  try {
    await setDoc(doc(db, "agenda", "datos"), { tareas: limpiar(tareas) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("tareas", error);
    return false;
  }
}

export async function guardarFiltrosGuardados(filtrosGuardados) {
  try {
    await setDoc(doc(db, "agenda", "datos"), { filtrosGuardados: limpiar(filtrosGuardados) }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("filtros guardados", error);
    return false;
  }
}

export async function guardarAlertasVencimiento(alertasVencimiento) {
  try {
    await setDoc(doc(db, "agenda", "datos"), { alertasVencimiento }, { merge: true });
    return true;
  } catch (error) {
    avisarErrorGuardado("alertas de vencimiento", error);
    return false;
  }
}

/**
 * Documento aparte y reducido (agenda/publico) con SOLO lo que las páginas públicas sin login
 * (registro-evento.astro, ticket-publico.astro) necesitan mostrar: logo, nombre de empresa,
 * correo de soporte y los datos públicos de eventos. Antes esas páginas leían agenda/datos
 * completo (clientes, tickets con notas internas, todo) solo para sacar 3 campos.
 */
export async function guardarConfigPublica(datos) {
  try {
    await setDoc(doc(db, "agenda", "publico"), limpiar(datos), { merge: false });
    return true;
  } catch (error) {
    avisarErrorGuardado("configuración pública", error);
    return false;
  }
}

/**
 * Paso 1 de la migración a autenticación real (sin tocar el login viejo todavía):
 * crea una cuenta real de Firebase (correo + contraseña).
 *
 * Al crearla, Firebase cambia automáticamente la sesión del navegador de anónima (o de quien
 * sea que esté activa) a esta cuenta nueva — eso es lo que queremos cuando alguien activa SU
 * PROPIA cuenta (permanecer=true, default), pero NO cuando un admin la crea para otra persona
 * que no está presente: en ese caso, con permanecer=false, se restaura la sesión anónima justo
 * después de crearla, para no dejar al admin "metido" con la identidad de otra persona en su
 * propio navegador.
 */
export async function activarCuentaSegura(email, password, permanecer = true) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    // Es para alguien que YA es miembro legítimo del CRM (se autoactivó, o un admin la creó
    // por él) — se le otorga acceso real de una vez, a diferencia de solicitarAcceso() para
    // gente nueva, que se queda pendiente de aprobación.
    await otorgarAccesoStaff(email);
    if (!permanecer) {
      await signOut(auth);
      await signInAnonymously(auth);
    }
    return { ok: true, uid: cred.user.uid };
  } catch (error) {
    console.error("Error al activar cuenta segura:", error);
    let mensaje = error?.message || String(error);
    if (error?.code === "auth/email-already-in-use") mensaje = "Ese correo ya tiene una cuenta segura activada.";
    else if (error?.code === "auth/weak-password") mensaje = "La contraseña debe tener al menos 6 caracteres.";
    else if (error?.code === "auth/invalid-email") mensaje = "Correo inválido.";
    else if (error?.code === "auth/operation-not-allowed") mensaje = "El inicio de sesión con correo/contraseña no está habilitado en Firebase todavía — avísale a Erick.";
    return { ok: false, error: error?.code || "error", mensaje };
  }
}

/**
 * Inicia sesión con la cuenta segura ya activada (correo + contraseña reales de Firebase),
 * en vez de crear una nueva. Es la contraparte de activarCuentaSegura() para entrar día a día
 * desde cualquier dispositivo, no solo el que se usó para activarla.
 */
export async function iniciarSesionSegura(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    // Respaldo: si por lo que sea a esta cuenta le faltaba el documento de acceso (ej. se activó
    // antes de que existiera este sistema), se rellena solo en el primer login exitoso.
    await otorgarAccesoStaff(email);
    return { ok: true, uid: cred.user.uid };
  } catch (error) {
    console.error("Error al iniciar sesión segura:", error);
    let mensaje = error?.message || String(error);
    if (error?.code === "auth/invalid-credential" || error?.code === "auth/wrong-password") mensaje = "Correo o contraseña incorrectos.";
    else if (error?.code === "auth/user-not-found") mensaje = "No hay ninguna cuenta segura con ese correo.";
    else if (error?.code === "auth/too-many-requests") mensaje = "Demasiados intentos — espera un momento y vuelve a intentar.";
    return { ok: false, error: error?.code || "error", mensaje };
  }
}

/**
 * Lectura del documento público reducido (agenda/publico) — se usa, entre otras cosas, para
 * saber a qué correo mandar el aviso de una solicitud de acceso nueva desde la pantalla de
 * login, donde todavía no hay sesión de CRM ni datos cargados.
 */
export async function cargarConfigPublica() {
  try {
    const snap = await getDoc(doc(db, "agenda", "publico"));
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    console.error("Error al cargar configuración pública:", error);
    return null;
  }
}

/**
 * Documento cuya sola existencia (staff_aprobado/{correo}) es lo que las reglas de Firestore
 * exigirán, junto con sesión real (no anónima), para leer/escribir los datos del CRM. Separado
 * de "tener cuenta segura": una solicitud de acceso nueva SÍ tiene cuenta real de Firebase
 * (correo+contraseña) pero NO este documento hasta que un admin la apruebe — así el rechazo/
 * pendiente es un candado real de datos, no solo una pantalla que se puede saltar.
 */
export async function otorgarAccesoStaff(correo) {
  try {
    await setDoc(doc(db, "staff_aprobado", correo.toLowerCase()), { fecha: serverTimestamp() });
    return true;
  } catch (error) {
    avisarErrorGuardado("acceso de staff", error);
    return false;
  }
}

export async function quitarAccesoStaff(correo) {
  try {
    await deleteDoc(doc(db, "staff_aprobado", correo.toLowerCase()));
    return true;
  } catch (error) {
    avisarErrorGuardado("acceso de staff (quitar)", error);
    return false;
  }
}

/**
 * Alguien nuevo (nunca antes en el CRM) pide acceso desde la pantalla de login. Crea su cuenta
 * real de Firebase pero NO le da acceso a los datos (no toca staff_aprobado) — queda pendiente
 * hasta que un admin la apruebe desde Configuración → Usuarios.
 */
export async function solicitarAcceso(email, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return { ok: true, uid: cred.user.uid };
  } catch (error) {
    console.error("Error al solicitar acceso:", error);
    let mensaje = error?.message || String(error);
    if (error?.code === "auth/email-already-in-use") mensaje = "Ya existe una cuenta con ese correo.";
    else if (error?.code === "auth/weak-password") mensaje = "La contraseña debe tener al menos 6 caracteres.";
    else if (error?.code === "auth/invalid-email") mensaje = "Correo inválido.";
    else if (error?.code === "auth/operation-not-allowed") mensaje = "El registro no está habilitado todavía — avísale a un administrador.";
    return { ok: false, error: error?.code || "error", mensaje };
  }
}

/**
 * Colección aparte (no un campo dentro de agenda/datos) — mismo patrón que tickets_publicos:
 * cualquiera con sesión (real o anónima) puede crear una solicitud, pero solo se puede LEER con
 * acceso de staff. Si viviera dentro de agenda/datos, alguien pidiendo acceso por primera vez no
 * podría ni siquiera guardar su propia solicitud una vez cerradas las reglas (necesitaría acceso
 * que todavía no tiene, para pedir el acceso que le falta).
 */
export async function crearSolicitudAcceso(nombre, correo) {
  try {
    await addDoc(collection(db, "solicitudes_acceso"), { nombre, correo, fecha: serverTimestamp() });
    return true;
  } catch (error) {
    console.error("Error al crear solicitud de acceso:", error);
    return false;
  }
}

export async function obtenerSolicitudesAcceso() {
  try {
    const snap = await getDocs(collection(db, "solicitudes_acceso"));
    return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  } catch (error) {
    console.error("Error al obtener solicitudes de acceso:", error);
    return [];
  }
}

export async function eliminarSolicitudAcceso(id) {
  try {
    await deleteDoc(doc(db, "solicitudes_acceso", id));
    return true;
  } catch (error) {
    console.error("Error al eliminar solicitud de acceso:", error);
    return false;
  }
}

export async function guardarInscripcionEvento(eventoId, registro) {
  try {
    const colRef = collection(db, "inscripciones_evento");
    await addDoc(colRef, { eventoId, ...registro, fechaRegistro: serverTimestamp() });
    return true;
  } catch (error) {
    console.error("Error al guardar inscripción:", error);
    return false;
  }
}

export async function obtenerInscripcionesEvento(eventoId) {
  try {
    const snap = await getDocs(collection(db, "inscripciones_evento"));
    return snap.docs
      .map(d => ({ _id: d.id, ...d.data() }))
      .filter(d => d.eventoId === eventoId);
  } catch (error) {
    console.error("Error al obtener inscripciones:", error);
    return [];
  }
}

