// TEMPORAL — diagnóstico puntual para contar tickets de un agente por nombre (campo "agente" o
// "canalizado"), sin exponer nada públicamente. Se borra después de usarse una vez.
import { firestoreAdminAuth, fromFirestoreFields } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const nombre = (url.searchParams.get("nombre") || "").toLowerCase();
  if (!nombre) return new Response("Falta ?nombre=", { status: 400 });

  const auth = await firestoreAdminAuth(env);
  const resp = await fetch(`${auth.base}/agenda/datos`, { headers: auth.headers });
  const datos = fromFirestoreFields((await resp.json()).fields || {});
  const tickets = datos.tickets || [];

  const coincide = (v) => {
    const n = (v || "").trim().toLowerCase();
    return !!n && (n.includes(nombre) || nombre.includes(n));
  };

  const match = tickets.filter(t => coincide(t.agente) || coincide(t.canalizado));
  const resumen = match.map(t => ({ numero: t.numero, empresa: t.empresa, estado: t.estado, agente: t.agente, canalizado: t.canalizado }));

  return new Response(JSON.stringify({ total: match.length, tickets: resumen }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
