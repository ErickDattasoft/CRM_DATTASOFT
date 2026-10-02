// TEMPORAL — borra el ruido de respuestas de prueba (bucle de correo) de un ticket. Se borra el
// archivo después de usarse una vez.
import { firestoreAdminAuth } from "./_lib/firestore-admin.js";

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const numero = parseInt(url.searchParams.get("ticket") || "", 10);
  if (!numero) return new Response("Falta ?ticket=", { status: 400 });

  const auth = await firestoreAdminAuth(env);
  const listResp = await fetch(`${auth.base}/respuestas_tickets?pageSize=200`, { headers: auth.headers });
  const data = await listResp.json();
  const docs = data.documents || [];
  let borrados = 0;
  for (const d of docs) {
    const ticketNumero = d.fields?.ticketNumero?.integerValue ?? d.fields?.ticketNumero?.doubleValue;
    if (Number(ticketNumero) === numero) {
      const resp = await fetch(`${auth.base}/${d.name.split("/documents/")[1]}`, { method: "DELETE", headers: auth.headers });
      if (resp.ok) borrados++;
    }
  }
  return new Response(JSON.stringify({ ok: true, borrados }, null, 2), { headers: { "Content-Type": "application/json" } });
};
