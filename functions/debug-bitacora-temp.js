// TEMPORAL — prueba puntual de agregarEntradaBitacoraServidor (arrayUnion vía REST). Se borra
// después de confirmar que funciona.
import { firestoreAdminAuth, toFirestoreFields } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const auth = await firestoreAdminAuth(env);
  const resourceBase = auth.base.replace("https://firestore.googleapis.com/v1/", "");
  const entry = { fecha: new Date().toISOString(), msg: "🧪 Prueba de bitácora desde servidor (borrar si la ves)", icon: "🧪", usuario: "Sistema" };
  const body = {
    writes: [{
      transform: {
        document: `${resourceBase}/agenda/datos`,
        fieldTransforms: [{ fieldPath: "bitacora", appendMissingElements: { values: [{ mapValue: { fields: toFirestoreFields(entry) } }] } }],
      },
    }],
  };
  const resp = await fetch(`${auth.base}:commit`, { method: "POST", headers: auth.headers, body: JSON.stringify(body) });
  const text = await resp.text();
  return new Response(JSON.stringify({ status: resp.status, body: text }, null, 2), { headers: { "Content-Type": "application/json" } });
};
