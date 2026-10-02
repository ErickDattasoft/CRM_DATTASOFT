// TEMPORAL — diagnóstico puntual para confirmar qué hay en respuestas_tickets. Se borra después.
import { firestoreAdminAuth, fromFirestoreFields } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const auth = await firestoreAdminAuth(env);
  const resp = await fetch(`${auth.base}/respuestas_tickets?pageSize=50`, { headers: auth.headers });
  const data = await resp.json();
  const docs = (data.documents || []).map(d => ({
    id: d.name.split("/").pop(),
    ...fromFirestoreFields(d.fields || {}),
  }));
  return new Response(JSON.stringify({ total: docs.length, docs }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
