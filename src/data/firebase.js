import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// Configuración de Firebase usando las variables de entorno de Astro
const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/**
 * Carga todos los datos del CRM desde Firestore (clientes, versiones, cartas y plantilla).
 * Retorna null si el documento no existe.
 */
export async function cargarDatosCRM() {
  try {
    const docRef = doc(db, "agenda", "datos");
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
  } catch (error) {
    console.error("Error al cargar datos de Firestore:", error);
  }
  return null;
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
