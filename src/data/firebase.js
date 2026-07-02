import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, onSnapshot, addDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

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


// Iniciar sesión anónima automáticamente al cargar el módulo.
// Resuelve una promesa cuando el auth está listo para que Firestore
// no reciba llamadas antes de tener credenciales.
let _authResolve;
export const authListo = new Promise(res => { _authResolve = res; });

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
 * Retorna la función de unsuscribe para limpiar el listener.
 */
export function suscribirCRM(callback) {
  if (!firebaseEnabled) return () => {};
  const docRef = doc(db, "agenda", "datos");
  return onSnapshot(
    docRef,
    (docSnap) => callback(
      docSnap.exists() ? docSnap.data() : null,
      docSnap.metadata.hasPendingWrites
    ),
    (error) => console.error("[CRM] Error en listener Firebase:", error)
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
 */
export async function guardarConfigTickets(configTickets) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { configTickets }, { merge: true });
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
 * Guarda la bitácora del CRM en Firestore.
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

