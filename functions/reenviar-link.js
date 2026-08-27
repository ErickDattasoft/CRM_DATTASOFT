// Cloudflare Pages Function: reenvía el correo de confirmación (con el link del webinar) a
// alguien que ya se había registrado antes y no lo encuentra. Se dispara desde el estado "Ya
// estás registrado" de registro-evento.astro.
//
// No usa Turnstile: solo puede reenviar a un correo que YA estaba en la base (no permite mandar
// a direcciones nuevas), así que el riesgo es mucho menor que el registro mismo — el único abuso
// posible es hostigar a un registrante real con reenvíos repetidos, y eso se corta con el
// enfriamiento de 5 minutos de abajo.

import { toFirestoreValue, fromFirestoreFields, firestoreAdminAuth } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const PLANTILLA_EVENTO_DEFAULT = "Hola [nombre] 👋\n\nQuedaste registrado en [evento].\n📅 [fecha] [hora]\n🔗 Liga de acceso: [link]\n\nPara mayores informes, contáctanos por WhatsApp: [contacto_whatsapp]\n\n¡Nos vemos ahí!\n\n— [contacto_nombre]";

function resolverPlantillaEvento(plantilla, ev, datosInscrito) {
  const fechaFmt = ev.fecha
    ? new Date(ev.fecha + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "";
  return (plantilla || PLANTILLA_EVENTO_DEFAULT)
    .replace(/\[nombre\]/g, datosInscrito.nombre || "")
    .replace(/\[evento\]/g, ev.nombre || "")
    .replace(/\[fecha\]/g, fechaFmt)
    .replace(/\[hora\]/g, ev.hora || "")
    .replace(/\[sistema\]/g, ev.sistema || "")
    .replace(/\[link\]/g, ev.link || "")
    .replace(/\[contacto_nombre\]/g, ev.contactoNombre || "")
    .replace(/\[contacto_whatsapp\]/g, ev.contactoWhatsapp || "");
}

export const onRequestPost = async (context) => {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
  }

  const eventoId = String(payload.eventoId || "").trim();
  const correo = String(payload.correo || "").trim().toLowerCase();
  if (!eventoId || !correo || !isValidEmail(correo)) return jsonResponse({ ok: false, error: "Correo inválido" }, 400);

  let base, headers;
  try {
    ({ base, headers } = await firestoreAdminAuth(env));
  } catch (err) {
    console.error("[reenviar-link] Error de auth con Firebase:", err);
    return jsonResponse({ ok: false, error: "Error de autenticación con Firebase" }, 500);
  }

  // Respuesta genérica siempre, exista o no el correo — evita que este endpoint sirva para
  // confirmar qué correos están registrados (mismo motivo por el que registrar-evento nunca dice
  // "ese correo no existe").
  const generico = { ok: true, mensaje: "Si el correo está registrado en este evento, te reenviamos el acceso en unos segundos." };

  const qBody = {
    structuredQuery: {
      from: [{ collectionId: "inscripciones_evento" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "eventoId" }, op: "EQUAL", value: toFirestoreValue(eventoId) } },
            { fieldFilter: { field: { fieldPath: "correo" }, op: "EQUAL", value: toFirestoreValue(correo) } },
          ],
        },
      },
      limit: 1,
    },
  };
  const qResp = await fetch(`${base}:runQuery`, { method: "POST", headers, body: JSON.stringify(qBody) });
  const rows = qResp.ok ? await qResp.json().catch(() => []) : [];
  const match = Array.isArray(rows) ? rows.find(r => r && r.document) : null;
  if (!match) return jsonResponse(generico);

  const docId = match.document.name.split("/").pop();
  const inscrito = fromFirestoreFields(match.document.fields || {});

  const ahora = Date.now();
  const ultimo = inscrito.ultimoReenvio ? new Date(inscrito.ultimoReenvio).getTime() : 0;
  if (ahora - ultimo < 5 * 60 * 1000) return jsonResponse(generico);

  const pubResp = await fetch(`${base}/agenda/publico`, { headers });
  const pubDoc = pubResp.ok ? await pubResp.json().catch(() => null) : null;
  const pubData = pubDoc ? fromFirestoreFields(pubDoc.fields || {}) : {};
  const evento = (pubData.eventos || []).find(e => e.id === eventoId);
  if (!evento) return jsonResponse(generico);

  const mensaje = resolverPlantillaEvento(evento.plantilla, evento, inscrito).replace(/\n/g, "<br>");
  const html = `
<div style="font-family:'Segoe UI',sans-serif;max-width:580px;margin:0 auto;background:#0f1117;border-radius:16px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 32px 24px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:8px;">🔗</div>
    <h1 style="color:#fff;font-size:1.4rem;font-weight:800;margin:0;">Aquí está tu acceso</h1>
  </div>
  <div style="padding:28px 32px;background:#141827;color:#cbd5e1;">
    <p style="font-size:0.95rem;line-height:1.7;">${mensaje}</p>
  </div>
  <div style="padding:16px 32px;background:#0f1117;text-align:center;">
    <p style="font-size:0.75rem;color:#334155;margin:0;">${pubData.nombreEmpresa || "DATTASOFT"}</p>
  </div>
</div>`;

  const origin = new URL(request.url).origin;
  await fetch(`${origin}/send-email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: correo, subject: `🔗 Tu acceso — ${evento.nombre || "Evento"}`, html }),
  }).catch(() => {});

  await fetch(`${base}/inscripciones_evento/${docId}?updateMask.fieldPaths=ultimoReenvio`, {
    method: "PATCH", headers, body: JSON.stringify({ fields: { ultimoReenvio: { stringValue: new Date().toISOString() } } }),
  }).catch(() => {});

  return jsonResponse(generico);
};
