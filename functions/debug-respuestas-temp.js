// TEMPORAL — diagnóstico puntual. Se borra después de usarse.
import { firestoreAdminAuth, fromFirestoreFields } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const numero = parseInt(url.searchParams.get("ticket") || "", 10);
  const auth = await firestoreAdminAuth(env);
  const resp = await fetch(`${auth.base}/respuestas_tickets?pageSize=100`, { headers: auth.headers });
  const data = await resp.json();
  const docs = (data.documents || []).map(d => ({
    id: d.name.split("/").pop(),
    ...fromFirestoreFields(d.fields || {}),
  })).filter(d => !numero || d.ticketNumero === numero);
  return new Response(JSON.stringify({ total: docs.length, docs }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
