// Cloudflare Pages Function: recibe los avisos de entrega de Brevo (webhook de eventos
// transaccionales) y actualiza el semáforo de correo (correoEstado) de la inscripción
// correspondiente en Firestore. Brevo se configura para llamar esta URL cada vez que un correo
// se entrega, rebota, se bloquea, etc.
//
// Cómo sabe a qué inscripción corresponde un aviso: registrar-evento.js le pone a cada correo de
// confirmación una "tag" con el ID del documento (insc_<docId>) al mandarlo — Brevo regresa esa
// misma tag tal cual en cada evento del webhook, así no hace falta buscar por correo (que podría
// repetirse entre eventos o cambiar de estado en registros viejos).

import { firestoreAdminAuth } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// Solo se actualiza en estos dos casos — son los únicos con significado claro y definitivo.
// soft_bounce/deferred se ignoran a propósito: pueden reintentarse y entregarse después, marcar
// "rebotado" ahí sería un falso negativo.
const EVENTOS_ENTREGADO = new Set(["delivered"]);
const EVENTOS_REBOTADO = new Set(["hard_bounce", "invalid_email", "blocked"]);

export const onRequestPost = async (context) => {
  const { request, env } = context;

  // Protección mínima: sin esto, cualquiera que adivine la URL podría mandar avisos falsos de
  // "entregado"/"rebotado". Brevo permite poner query params fijos en la URL del webhook al
  // configurarlo, así que el secreto vive ahí (?key=...), no en un header especial.
  const url = new URL(request.url);
  if (!env.BREVO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.BREVO_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "No autorizado" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
  }

  // Brevo manda un evento por llamada en la configuración normal, pero se admite también un
  // arreglo por si acaso (algunos webhooks de terceros sí agrupan varios eventos en un POST).
  const eventos = Array.isArray(payload) ? payload : [payload];

  let auth = null;
  let actualizados = 0;
  for (const ev of eventos) {
    const tags = Array.isArray(ev?.tags) ? ev.tags : [];
    const tagInsc = tags.find(t => typeof t === "string" && t.startsWith("insc_"));
    if (!tagInsc) continue;
    const docId = tagInsc.slice("insc_".length);
    if (!docId) continue;

    let nuevoEstado = null;
    if (EVENTOS_ENTREGADO.has(ev.event)) nuevoEstado = "entregado";
    else if (EVENTOS_REBOTADO.has(ev.event)) nuevoEstado = "rebotado";
    if (!nuevoEstado) continue;

    try {
      if (!auth) auth = await firestoreAdminAuth(env);
      const patchResp = await fetch(
        `${auth.base}/inscripciones_evento/${docId}?updateMask.fieldPaths=correoEstado`,
        { method: "PATCH", headers: auth.headers, body: JSON.stringify({ fields: { correoEstado: { stringValue: nuevoEstado } } }) }
      );
      if (patchResp.ok) actualizados++;
      else console.error("[brevo-webhook] No se pudo actualizar", docId, await patchResp.text().catch(() => ""));
    } catch (err) {
      console.error("[brevo-webhook] Error de auth/Firestore:", err);
    }
  }

  return jsonResponse({ ok: true, recibidos: eventos.length, actualizados });
};
