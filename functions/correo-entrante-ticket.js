// Cloudflare Pages Function: recibe el webhook de "Inbound Parsing" de Brevo cuando un cliente
// RESPONDE al correo de notificación de un ticket, y guarda esa respuesta ligada al ticket
// correcto — sin tocar el documento agenda/datos ni el arreglo de tickets (mismo motivo que
// tickets_adjuntos/tickets_publicos viven en su propia colección: un documento aparte por
// respuesta no puede chocar con el bug de "arreglo completo sobrescrito" que ya causó pérdidas
// de datos reales en este CRM).
//
// Cómo sabe a qué ticket corresponde: enviarNotificacionTicket() en index.astro pone el Reply-To
// del correo como ticket-<numero>@respuestas.dattasoft.mx (un subdominio dedicado, solo para
// recibir — nunca se usa para enviar, así que un problema de configuración ahí no puede afectar
// el correo real @dattasoft.mx). Cuando el cliente responde, su correo llega a esa dirección, y
// Brevo la reporta en el campo "To" del webhook.

import { firestoreAdminAuth, toFirestoreFields, fromFirestoreFields } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const RE_TICKET = /^ticket-(\d+)@/i;

function extraerNumeroTicket(item) {
  const destinatarios = Array.isArray(item?.To) ? item.To : [];
  for (const d of destinatarios) {
    const m = String(d?.Address || "").match(RE_TICKET);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function avisarNuevaRespuesta(auth, env, numero, remitente, mensaje) {
  // No bloquea el guardado de la respuesta si esto falla — la respuesta ya quedó en Firestore y
  // es visible en el CRM aunque el aviso por correo no llegue.
  try {
    const docResp = await fetch(`${auth.base}/agenda/datos`, { headers: auth.headers });
    if (!docResp.ok) return;
    const datos = fromFirestoreFields((await docResp.json()).fields || {});
    const ticket = (datos.tickets || []).find(t => t.numero === numero);
    const correoSoporte = datos.configTickets?.correoSoporte || "";
    const destinatarios = correoSoporte.split(",").map(s => s.trim()).filter(Boolean);
    if (!destinatarios.length) return;

    const asunto = ticket ? `[Ticket #${numero}] ${ticket.asunto}` : `Ticket #${numero}`;
    const html = `<div style="font-family:sans-serif;">
      <p>💬 <strong>${remitente}</strong> respondió el ticket <strong>#${numero}</strong>${ticket ? ` — ${ticket.asunto}` : ""}:</p>
      <div style="background:#f9fafb; padding:12px; border-radius:6px; white-space:pre-wrap;">${mensaje}</div>
      <p><a href="https://crm-dattasoft.pages.dev" style="color:#4f46e5;">Ver en el CRM →</a></p>
    </div>`;

    await fetch("https://crm-dattasoft.pages.dev/send-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: destinatarios, subject: `💬 Respuesta de cliente — ${asunto}`, html }),
    });
  } catch (err) {
    console.error("[correo-entrante-ticket] No se pudo avisar por correo:", err);
  }
}

export const onRequestPost = async (context) => {
  const { request, env } = context;

  // Mismo patrón que brevo-webhook.js: el secreto va en la URL (?key=...), que es donde Brevo
  // permite fijar query params al configurar un webhook.
  const url = new URL(request.url);
  if (!env.BREVO_INBOUND_SECRET || url.searchParams.get("key") !== env.BREVO_INBOUND_SECRET) {
    return jsonResponse({ ok: false, error: "No autorizado" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  let auth = null;
  let guardadas = 0;

  for (const item of items) {
    const numero = extraerNumeroTicket(item);
    if (!numero) continue; // correo que no corresponde a ningún ticket (dirección mal escrita, spam, etc.)

    const mensaje = item.ExtractedMarkdownMessage || item.RawTextBody || "(sin contenido legible)";
    const remitenteNombre = item.From?.Name || item.From?.Address || "Desconocido";

    try {
      if (!auth) auth = await firestoreAdminAuth(env);
      const createResp = await fetch(`${auth.base}/respuestas_tickets`, {
        method: "POST", headers: auth.headers,
        body: JSON.stringify({
          fields: toFirestoreFields({
            ticketNumero: numero,
            de: item.From?.Address || "",
            nombreDe: remitenteNombre,
            asunto: item.Subject || "",
            mensaje,
            fecha: new Date().toISOString(),
            leido: false,
          }),
        }),
      });
      if (createResp.ok) {
        guardadas++;
        await avisarNuevaRespuesta(auth, env, numero, remitenteNombre, mensaje);
      } else {
        console.error("[correo-entrante-ticket] No se pudo guardar respuesta:", await createResp.text().catch(() => ""));
      }
    } catch (err) {
      console.error("[correo-entrante-ticket] Error de auth/Firestore:", err);
    }
  }

  return jsonResponse({ ok: true, recibidos: items.length, guardadas });
};
