// TEMPORAL — diagnóstico puntual de tickets creados hoy. Se borra después de usarse.
import { firestoreAdminAuth, fromFirestoreFields } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const auth = await firestoreAdminAuth(env);
  const resp = await fetch(`${auth.base}/agenda/datos`, { headers: auth.headers });
  const datos = fromFirestoreFields((await resp.json()).fields || {});
  const tickets = datos.tickets || [];
  const hoy = new Date().toISOString().slice(0, 10);
  const deHoy = tickets.filter(t => (t.fechaCreacion || "").slice(0, 10) === hoy);
  return new Response(JSON.stringify({ total: deHoy.length, tickets: deHoy }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
