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

  // Reproduce exactamente la consulta compuesta (where + orderBy) que usa el CRM, para ver si
  // Firestore exige un índice compuesto que todavía no existe (causaría FAILED_PRECONDITION).
  const parent = auth.base.replace(/\/documents$/, "/documents");
  const runQueryUrl = auth.base.replace(/\/documents$/, "/documents:runQuery");
  const structuredQuery = {
    structuredQuery: {
      from: [{ collectionId: "respuestas_tickets" }],
      where: { fieldFilter: { field: { fieldPath: "ticketNumero" }, op: "EQUAL", value: { integerValue: "1070" } } },
      orderBy: [{ field: { fieldPath: "fecha" }, direction: "ASCENDING" }],
    },
  };
  const qResp = await fetch(runQueryUrl, { method: "POST", headers: auth.headers, body: JSON.stringify(structuredQuery) });
  const qText = await qResp.text();

  return new Response(JSON.stringify({ total: docs.length, docs, consultaCompuesta: { status: qResp.status, body: qText.slice(0, 2000) } }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
