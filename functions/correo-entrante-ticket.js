// Cloudflare Pages Function: recibe el webhook SALIENTE de Zoho Mail cuando llega un correo nuevo
// a la bandeja de soporte, y si es la respuesta de un cliente a un ticket la guarda ligada al
// ticket correcto — sin tocar agenda/datos ni el arreglo de tickets (mismo motivo que
// tickets_adjuntos/tickets_publicos viven en su propia colección: un documento aparte por
// respuesta no puede chocar con el bug de "arreglo completo sobrescrito" que ya causó pérdidas
// de datos reales en este CRM).
//
// Por qué Zoho y no Brevo/Gmail (los dos intentos anteriores, descartados):
// - Brevo Inbound Parsing requería un subdominio con registros MX propios en el DNS de
//   dattasoft.mx — ese DNS vive en una cuenta de AWS que Erick no administra y le pidieron
//   explícitamente no tocar.
// - Leer Gmail vía su API (para el mismo correo con un alias "+ticket<numero>") requiere el
//   scope gmail.modify, clasificado por Google como "restricted" — exige una auditoría de
//   seguridad externa (CASA) de varias semanas y costo recurrente, inviable aquí. Además resultó
//   que el correo real de soporte NO es Gmail/Workspace, es Zoho Mail.
//
// Cómo sabe a qué ticket corresponde: enviarNotificacionTicket() en index.astro pone el Reply-To
// como erick.casas+ticket<numero>@dattasoft.mx — Zoho entrega ese correo en la bandeja normal de
// erick.casas@dattasoft.mx (alias "+", función nativa de Zoho igual que Gmail, confirmada). Zoho
// reporta el destinatario real (toAddress) en el payload del webhook, de donde se extrae el
// número de ticket.
//
// Seguridad: Zoho firma cada webhook con un esquema HMAC propio (x-hook-secret/x-hook-signature)
// pero su documentación no explica bien el handshake inicial — en vez de depender de eso, se
// protege con un secreto fijo en la URL (?key=...), mismo patrón que el resto de los webhooks de
// este proyecto (brevo-webhook.js, cron-eventos.js): ese query param se configura directo en la
// "URL del webhook" al darlo de alta en Zoho Mail → Configuración → Integraciones → Developer
// Space → Webhooks salientes.

import { firestoreAdminAuth, toFirestoreFields, fromFirestoreFields } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const RE_TICKET = /\+ticket-?(\d+)@/i;

// El campo exacto donde Zoho reporta el destinatario no está 100% confirmado por su
// documentación (incompleta en ese punto) — se revisan varios nombres plausibles por seguridad,
// y de haber un formato distinto se vería en los logs de Cloudflare la primera vez que llegue un
// correo real de prueba, para ajustar sin perder ningún dato mientras tanto.
function extraerNumeroTicket(payload) {
  const candidatos = [payload?.toAddress, payload?.to, payload?.deliveredTo, payload?.subject, payload?.summary]
    .filter(Boolean)
    .map(String);
  for (const texto of candidatos) {
    const m = texto.match(RE_TICKET);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function avisarNuevaRespuesta(auth, numero, remitente, mensaje) {
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
      <div style="background:#f9fafb; padding:12px; border-radius:6px; white-space:pre-wrap;">${mensaje.slice(0, 2000)}</div>
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

// Zoho entrega el cuerpo en "summary" (texto) y/o "html" según su documentación — se prefiere
// texto plano si viene, igual que el resto del CRM guarda las respuestas.
function textoDelPayload(payload) {
  if (payload?.summary) return String(payload.summary);
  if (payload?.content) return String(payload.content);
  if (payload?.html) return String(payload.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "(sin contenido legible)";
}

export const onRequestPost = async (context) => {
  const { request, env } = context;

  const url = new URL(request.url);
  if (!env.ZOHO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.ZOHO_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "No autorizado" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
  }

  // No queda documentado si Zoho agrupa varios correos por POST — se admiten ambas formas por
  // seguridad, igual que ya se hizo con el webhook de Brevo en este mismo proyecto.
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [payload];

  let auth = null;
  let guardadas = 0;

  for (const item of items) {
    const numero = extraerNumeroTicket(item);
    if (!numero) continue; // correo normal de la bandeja, no es respuesta de ningún ticket

    const mensaje = textoDelPayload(item);
    const remitente = item.fromAddress || item.from || "Cliente";

    try {
      if (!auth) auth = await firestoreAdminAuth(env);
      const createResp = await fetch(`${auth.base}/respuestas_tickets`, {
        method: "POST", headers: auth.headers,
        body: JSON.stringify({
          fields: toFirestoreFields({
            ticketNumero: numero,
            de: remitente,
            nombreDe: remitente,
            asunto: item.subject || "",
            mensaje,
            fecha: new Date().toISOString(),
            leido: false,
          }),
        }),
      });
      if (createResp.ok) {
        guardadas++;
        await avisarNuevaRespuesta(auth, numero, remitente, mensaje);
      } else {
        console.error("[correo-entrante-ticket] No se pudo guardar respuesta:", await createResp.text().catch(() => ""));
      }
    } catch (err) {
      console.error("[correo-entrante-ticket] Error de auth/Firestore:", err);
    }
  }

  // Log explícito del payload completo cuando NO se identificó ningún ticket — necesario para la
  // primera prueba real (confirmar en qué campo exacto llega el destinatario con el "+alias",
  // ya que la documentación de Zoho no lo deja claro) sin tener que adivinar dos veces.
  if (!guardadas) console.log("[correo-entrante-ticket] Payload recibido, ningún ticket identificado:", JSON.stringify(payload).slice(0, 3000));

  return jsonResponse({ ok: true, recibidos: items.length, guardadas });
};
