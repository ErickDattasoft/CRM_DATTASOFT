// TEMPORAL — diagnóstico puntual de discrepancias en facturación. Se borra después de usarse.
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
  const bitacora = datos.bitacora || [];

  // Últimas veces que se marcó "Facturación cambiada a FACTURADO" por ticket, según bitácora.
  const marcadosFacturadoEnBitacora = {};
  for (const e of bitacora) {
    const m = (e.msg || "").match(/Ticket #(\d+): facturaci[oó]n cambiada a "([^"]+)"/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!marcadosFacturadoEnBitacora[num]) marcadosFacturadoEnBitacora[num] = [];
      marcadosFacturadoEnBitacora[num].push({ fecha: e.fecha, valor: m[2], usuario: e.usuario });
    }
  }

  // Tickets donde la bitácora dice que la ÚLTIMA vez se puso FACTURADO, pero el valor actual del
  // ticket ya no es FACTURADO — esa es la discrepancia real.
  const discrepancias = [];
  for (const [numStr, cambios] of Object.entries(marcadosFacturadoEnBitacora)) {
    const num = parseInt(numStr, 10);
    const ultimo = cambios.sort((a, b) => new Date(a.fecha) - new Date(b.fecha)).slice(-1)[0];
    const ticketActual = tickets.find(t => t.numero === num);
    if (ultimo.valor === "FACTURADO" && ticketActual && ticketActual.facturado !== "FACTURADO") {
      discrepancias.push({
        numero: num, empresa: ticketActual.empresa, asunto: ticketActual.asunto,
        facturadoActual: ticketActual.facturado, fechaActualizacion: ticketActual.fechaActualizacion,
        ultimoCambioFacturadoSegunBitacora: ultimo,
      });
    }
  }

  if (url.searchParams.get("raw") === "1") {
    const resumen = tickets.map(t => ({ numero: t.numero, empresa: t.empresa, facturado: t.facturado, estado: t.estado, fechaActualizacion: t.fechaActualizacion }));
    return new Response(JSON.stringify(resumen, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ totalTickets: tickets.length, totalDiscrepancias: discrepancias.length, discrepancias }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
