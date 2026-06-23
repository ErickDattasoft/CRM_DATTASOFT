import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc } from "firebase/firestore";

// Configuración de Firebase usando las variables de entorno de Astro
const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
};

export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId
);

const app = firebaseEnabled ? initializeApp(firebaseConfig) : null;
const db = firebaseEnabled ? getFirestore(app) : null;

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
    await setDoc(docRef, { clientes }, { merge: true });
    return true;
  } catch (error) {
    console.error("Error al guardar clientes en Firestore:", error);
    return false;
  }
}

/**
 * Guarda las versiones oficiales y los links de cartas técnicas en Firestore.
 */
export async function guardarConfiguracion(versionesMercado, cartasTecnicas) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { versionesMercado, cartasTecnicas }, { merge: true });
    return true;
  } catch (error) {
    console.error("Error al guardar configuración en Firestore:", error);
    return false;
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
    console.error("Error al guardar la plantilla en Firestore:", error);
    return false;
  }
}

/**
 * Guarda los tickets de soporte en Firestore.
 */
export async function guardarTickets(tickets) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { tickets }, { merge: true });
    return true;
  } catch (error) {
    console.error("Error al guardar tickets en Firestore:", error);
    return false;
  }
}

/**
 * Guarda los contactos del CRM en Firestore.
 */
export async function guardarContactos(contactos) {
  try {
    const docRef = doc(db, "agenda", "datos");
    await setDoc(docRef, { contactos }, { merge: true });
    return true;
  } catch (error) {
    console.error("Error al guardar contactos en Firestore:", error);
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
    console.error("Error al guardar configuración de tickets en Firestore:", error);
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
    console.error("Error al guardar usuarios:", error);
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
    console.error("Error al guardar eventos en Firestore:", error);
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
