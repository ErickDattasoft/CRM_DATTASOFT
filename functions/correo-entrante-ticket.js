// Cloudflare Pages Function: recibe el correo que un cliente contesta a la notificación de un
// ticket, y lo guarda ligado al ticket correcto — sin tocar agenda/datos ni el arreglo de
// tickets (mismo motivo que tickets_adjuntos/tickets_publicos viven en su propia colección: un
// documento aparte por respuesta no puede chocar con el bug de "arreglo completo sobrescrito"
// que ya causó pérdidas de datos reales en este CRM).
//
// Tres intentos antes de llegar a este diseño (no repetir ninguno):
// 1. Brevo Inbound Parsing: requería un subdominio con registros MX propios en el DNS de
//    dattasoft.mx — vive en una cuenta de AWS que Erick no administra y le pidieron
//    explícitamente no tocar nada ahí.
// 2. Gmail API (OAuth): el scope necesario (gmail.modify) es "restricted" para Google — exige
//    una auditoría de seguridad externa (CASA) de semanas y costo recurrente. Además resultó que
//    el correo real de soporte no es Gmail/Workspace, es Zoho Mail.
// 3. Webhook saliente nativo de Zoho Mail (Developer Space): requiere ser ADMINISTRADOR de la
//    organización en Zoho — Erick no lo es, y el admin (Arturo) ya dijo que no va a configurar
//    nada adicional.
//
// Diseño final — nada de lo anterior, cero privilegios especiales de ningún lado:
// - Zoho SÍ permite, a cualquier usuario normal (sin ser admin), crear un FILTRO propio
//   (Configuración → Filtros) que reenvíe automáticamente un correo según una condición. Erick
//   configura: "si el Asunto contiene '[Ticket #', reenviar a <dirección de CloudMailin>".
// - CloudMailin (plan gratis, 10,000 correos/mes, sin tarjeta, sin dominio propio — asigna una
//   dirección ya lista tipo xxxxx@cloudmailin.net) convierte ese correo reenviado en un HTTP
//   POST a esta Function.
// - Cómo se identifica el ticket: NO se necesita ningún alias "+ticket<numero>" ni depender de
//   que un reenvío preserve el destinatario original (frágil) — el Asunto de todo correo de
//   ticket ya es "[Ticket #<numero>] <asunto>" desde que existe enviarNotificacionTicket() en
//   index.astro, y el Asunto SÍ sobrevive cualquier reenvío/respuesta (es parte del contenido
//   del mensaje, no un header de enrutamiento SMTP que se pierda en el camino).
//
// Formato del payload: JSON (Normalised) de CloudMailin — confirmado contra el código fuente de
// una librería que lo implementa (github.com/peterhellberg/cloudmailin), no solo su marketing:
// { headers: { from, to, subject, ... }, envelope: {...}, plain, html, attachments: [...] }

import { firestoreAdminAuth, toFirestoreFields, fromFirestoreFields } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const RE_TICKET = /\[Ticket #(\d+)\]/i;

// Se revisan varias ubicaciones posibles del asunto por seguridad — además del formato
// confirmado de CloudMailin (headers.subject), se admiten variantes planas por si el payload
// real difiere un poco de lo documentado (se vería en el log de abajo la primera vez).
function extraerNumeroTicket(payload) {
  const candidatos = [payload?.headers?.subject, payload?.subject, payload?.headers?.to, payload?.toAddress]
    .filter(Boolean)
    .map(String);
  for (const texto of candidatos) {
    const m = texto.match(RE_TICKET);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function remitenteDelPayload(payload) {
  return payload?.envelope?.from || payload?.headers?.from || payload?.from || "Cliente";
}

// Extrae el correo plano de un remitente tipo "Nombre <correo@dominio>" o ya plano.
function extraerEmail(texto) {
  const m = String(texto || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
  return m ? m[0].toLowerCase() : "";
}

function textoDelPayload(payload) {
  if (payload?.plain) return String(payload.plain).trim();
  if (payload?.summary) return String(payload.summary).trim();
  if (payload?.html) {
    return String(payload.html)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "(sin contenido legible)";
}

function asuntoDelPayload(payload) {
  return payload?.headers?.subject || payload?.subject || "";
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

    // IMPORTANTE: este asunto NO debe contener el patrón "[Ticket #" — este aviso se manda a la
    // misma casilla de soporte que tiene el filtro de Zoho que reenvía a CloudMailin cuando el
    // asunto contiene ese patrón. Si lo contuviera, el propio aviso se reenviaría a sí mismo en
    // un bucle infinito (pasó en producción el 2026-10-02: ~20 correos en minutos). El ticket se
    // identifica igual sin los corchetes, con el texto "Ticket #<numero>" sin más.
    const asuntoTicket = ticket ? ticket.asunto : "";
    const html = `<div style="font-family:sans-serif;">
      <p>💬 <strong>${remitente}</strong> respondió el ticket <strong>#${numero}</strong>${asuntoTicket ? ` — ${asuntoTicket}` : ""}:</p>
      <div style="background:#f9fafb; padding:12px; border-radius:6px; white-space:pre-wrap;">${mensaje.slice(0, 2000)}</div>
      <p><a href="https://crm-dattasoft.pages.dev" style="color:#4f46e5;">Ver en el CRM →</a></p>
    </div>`;

    await fetch("https://crm-dattasoft.pages.dev/send-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: destinatarios, subject: `💬 Respuesta de cliente — Ticket #${numero}${asuntoTicket ? ` — ${asuntoTicket}` : ""}`, html }),
    });
  } catch (err) {
    console.error("[correo-entrante-ticket] No se pudo avisar por correo:", err);
  }
}

export const onRequestPost = async (context) => {
  const { request, env } = context;

  // Protección: la dirección de CloudMailin ya es un identificador aleatorio no adivinable, y
  // además se exige este secreto fijo en la URL (?key=...) — mismo patrón que el resto de los
  // webhooks de este proyecto (brevo-webhook.js, cron-eventos.js). El nombre de la variable
  // (ZOHO_WEBHOOK_SECRET) quedó del diseño anterior (webhook directo de Zoho, descartado) — se
  // mantiene el mismo nombre porque ya está dado de alta en Cloudflare, sin motivo para pedirle
  // a Erick que repita ese paso solo por una etiqueta.
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

  const numero = extraerNumeroTicket(payload);
  if (!numero) {
    // Correo que el filtro de Zoho reenvió pero que no corresponde a ningún ticket reconocible —
    // se deja un log breve del asunto para poder diagnosticar casos futuros sin adivinar.
    console.log("[correo-entrante-ticket] No se identificó ningún ticket. Asunto:", asuntoDelPayload(payload).slice(0, 200));
    return jsonResponse({ ok: true, guardada: false });
  }

  const mensaje = textoDelPayload(payload);
  const remitente = remitenteDelPayload(payload);

  // Barrera anti-bucle: el aviso de "nueva respuesta" se manda desde esta misma casilla de
  // soporte (vía Brevo) a la misma casilla — si por cualquier motivo ese correo volviera a
  // reenviarse aquí (ej. el asunto vuelve a coincidir con el filtro de Zoho), NO se procesa como
  // respuesta real de cliente. Pasó en producción el 2026-10-02 antes de este guardia.
  const emailRemitente = extraerEmail(remitente);
  const emailSoporteDefault = String(env.BREVO_FROM || "erick.casas@dattasoft.mx").toLowerCase();
  if (emailRemitente && emailRemitente === emailSoporteDefault) {
    console.log("[correo-entrante-ticket] Ignorado: remitente es la propia casilla de soporte (posible bucle).", emailRemitente);
    return jsonResponse({ ok: true, guardada: false, motivo: "remitente_es_soporte" });
  }

  try {
    const auth = await firestoreAdminAuth(env);
    const createResp = await fetch(`${auth.base}/respuestas_tickets`, {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({
        fields: toFirestoreFields({
          ticketNumero: numero,
          de: remitente,
          nombreDe: remitente,
          asunto: asuntoDelPayload(payload),
          mensaje,
          fecha: new Date().toISOString(),
          leido: false,
        }),
      }),
    });
    if (!createResp.ok) {
      console.error("[correo-entrante-ticket] No se pudo guardar respuesta:", await createResp.text().catch(() => ""));
      return jsonResponse({ ok: false, error: "No se pudo guardar en Firestore" }, 500);
    }
    await avisarNuevaRespuesta(auth, numero, remitente, mensaje);
  } catch (err) {
    console.error("[correo-entrante-ticket] Error de auth/Firestore:", err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }

  return jsonResponse({ ok: true, guardada: true, ticket: numero });
};
