// Cloudflare Pages Function: revisa periódicamente la bandeja de Gmail/Workspace de soporte
// buscando respuestas de clientes a correos de tickets, y las guarda ligadas al ticket correcto
// — sin tocar agenda/datos ni el arreglo de tickets (mismo motivo que tickets_adjuntos/
// tickets_publicos viven en su propia colección: un documento aparte por respuesta no puede
// chocar con el bug de "arreglo completo sobrescrito" que ya causó pérdidas de datos reales).
//
// Cloudflare Pages no soporta Cron Triggers — el reloj real es un GitHub Actions workflow
// (.github/workflows/cron-respuestas-tickets.yml) que llama este endpoint cada pocos minutos.
//
// Por qué polling de Gmail y no un webhook (como el resto de las integraciones de correo de este
// proyecto): el dominio dattasoft.mx vive en una cuenta de AWS que Erick no administra y que le
// pidieron explícitamente no tocar — así que no se puede apuntar un subdominio dedicado a ningún
// proveedor de "inbound parsing". La alternativa sin tocar DNS: usar el correo real de soporte
// que YA existe (erick.casas@dattasoft.mx) con un alias "+ticket<numero>" (función nativa de
// Gmail/Workspace, sin configuración adicional) como Reply-To de cada notificación — el cliente
// sigue respondiendo a una dirección real, que cae en la bandeja normal igual que siempre, y este
// cron solo LEE esa bandeja buscando esos correos puntuales para copiarlos también al ticket.
//
// Qué SÍ y qué NO toca de la bandeja: el único cambio que este cron hace en Gmail es agregarle la
// etiqueta "CRM-Procesado" a los correos que identificó como respuesta de un ticket (para no
// volver a procesarlos la próxima corrida) — nunca los marca como leídos, nunca los mueve, nunca
// toca ningún otro correo que no tenga el patrón "+ticket<numero>" en el destinatario.

import { firestoreAdminAuth, toFirestoreFields, fromFirestoreFields } from "./_lib/firestore-admin.js";
import { obtenerAccessTokenGmail, extraerTextoPlano, headerValor } from "./_lib/gmail-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const RE_TICKET = /\+ticket-?(\d+)@/i;
const ETIQUETA = "CRM-Procesado";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function extraerNumeroTicket(headers) {
  // Se revisan To y Delivered-To (no el query de búsqueda de Gmail, cuyo tratamiento del "+alias"
  // no es confiable del todo) — así nunca depende de cómo Gmail indexa el plus-addressing.
  for (const nombre of ["Delivered-To", "To"]) {
    const m = headerValor(headers, nombre).match(RE_TICKET);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function obtenerOCrearEtiqueta(gmailHeaders) {
  const listResp = await fetch(`${GMAIL_API}/labels`, { headers: gmailHeaders });
  if (!listResp.ok) throw new Error(`No se pudo listar etiquetas de Gmail (HTTP ${listResp.status})`);
  const labels = (await listResp.json()).labels || [];
  const existente = labels.find(l => l.name === ETIQUETA);
  if (existente) return existente.id;

  const createResp = await fetch(`${GMAIL_API}/labels`, {
    method: "POST", headers: gmailHeaders,
    body: JSON.stringify({ name: ETIQUETA, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!createResp.ok) throw new Error(`No se pudo crear la etiqueta "${ETIQUETA}" (HTTP ${createResp.status})`);
  return (await createResp.json()).id;
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

export const onRequestPost = async (context) => {
  const { request, env } = context;

  // Mismo patrón que cron-eventos.js: el secreto va en la URL (?key=...), que es como GitHub
  // Actions llama a este endpoint cada pocos minutos.
  const url = new URL(request.url);
  if (!env.CRON_RESPUESTAS_SECRET || url.searchParams.get("key") !== env.CRON_RESPUESTAS_SECRET) {
    return jsonResponse({ ok: false, error: "No autorizado" }, 401);
  }

  let accessTokenGmail;
  try {
    accessTokenGmail = await obtenerAccessTokenGmail(env);
  } catch (err) {
    console.error("[correo-entrante-ticket] Error de auth con Gmail:", err);
    return jsonResponse({ ok: false, error: "Error de autenticación con Gmail" }, 500);
  }
  const gmailHeaders = { Authorization: `Bearer ${accessTokenGmail}`, "Content-Type": "application/json" };

  let etiquetaId;
  try {
    etiquetaId = await obtenerOCrearEtiqueta(gmailHeaders);
  } catch (err) {
    console.error("[correo-entrante-ticket]", err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }

  // Candidatos: correos recientes que el cron todavía no revisó. La ventana de 2 días (en vez de
  // depender de "no leído", que Erick podría cambiar con solo abrir el correo) es el único filtro
  // de Gmail; el filtro real — "¿es una respuesta de ticket?" — se hace abajo leyendo los headers
  // de cada uno, no confiando en que Gmail busque bien el "+alias" dentro de q=.
  const listResp = await fetch(
    `${GMAIL_API}/messages?q=${encodeURIComponent(`-label:${ETIQUETA} newer_than:2d in:inbox`)}&maxResults=50`,
    { headers: gmailHeaders }
  );
  if (!listResp.ok) {
    const texto = await listResp.text().catch(() => "");
    console.error("[correo-entrante-ticket] No se pudo listar mensajes:", texto);
    return jsonResponse({ ok: false, error: "No se pudo listar mensajes de Gmail" }, 500);
  }
  const mensajes = (await listResp.json()).messages || [];

  let auth = null;
  let guardadas = 0;
  let revisados = 0;

  for (const { id } of mensajes) {
    revisados++;
    // Primera pasada: solo headers (liviano) para decidir si corresponde a un ticket, sin bajar
    // el cuerpo completo de correos que no tienen nada que ver.
    const metaResp = await fetch(
      `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Delivered-To&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: gmailHeaders }
    );
    if (!metaResp.ok) continue;
    const meta = await metaResp.json();
    const numero = extraerNumeroTicket(meta.payload?.headers);
    if (!numero) continue; // correo normal de la bandeja, no es respuesta de ningún ticket — no se toca

    const fromHeader = headerValor(meta.payload?.headers, "From");
    const subjectHeader = headerValor(meta.payload?.headers, "Subject");
    const m = fromHeader.match(/^(.*?)\s*<(.+)>$/);
    const remitenteNombre = (m ? m[1] : fromHeader).replace(/"/g, "").trim() || fromHeader;
    const remitenteCorreo = m ? m[2] : fromHeader;

    // Ya sabemos que es un ticket: ahora sí se pide el cuerpo completo.
    const fullResp = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: gmailHeaders });
    const mensaje = fullResp.ok ? extraerTextoPlano((await fullResp.json()).payload).trim() : "(sin contenido legible)";

    try {
      if (!auth) auth = await firestoreAdminAuth(env);
      const createResp = await fetch(`${auth.base}/respuestas_tickets`, {
        method: "POST", headers: auth.headers,
        body: JSON.stringify({
          fields: toFirestoreFields({
            ticketNumero: numero,
            de: remitenteCorreo,
            nombreDe: remitenteNombre,
            asunto: subjectHeader,
            mensaje: mensaje || "(sin contenido legible)",
            fecha: new Date().toISOString(),
            leido: false,
          }),
        }),
      });
      if (createResp.ok) {
        guardadas++;
        await avisarNuevaRespuesta(auth, numero, remitenteNombre, mensaje);
      } else {
        console.error("[correo-entrante-ticket] No se pudo guardar respuesta:", await createResp.text().catch(() => ""));
      }
    } catch (err) {
      console.error("[correo-entrante-ticket] Error de auth/Firestore:", err);
    }

    // Se etiqueta SIEMPRE que se identificó como respuesta de ticket, incluso si el guardado en
    // Firestore falló — evita reintentar en bucle un correo cuyo problema es de formato, no de
    // conexión; el aviso de error de arriba ya queda en los logs para revisar a mano si hace falta.
    await fetch(`${GMAIL_API}/messages/${id}/modify`, {
      method: "POST", headers: gmailHeaders,
      body: JSON.stringify({ addLabelIds: [etiquetaId] }),
    }).catch(err => console.error("[correo-entrante-ticket] No se pudo etiquetar el mensaje:", err));
  }

  return jsonResponse({ ok: true, revisados, guardadas });
};
