// Cloudflare Pages Function: único punto de entrada para registrarse a un evento público.
//
// Antes, registro-evento.astro escribía directo a Firestore desde el navegador (reglas
// `allow create: if true` en inscripciones_evento) — cualquier bot podía llenar Inscritos de
// basura sin siquiera tocar el formulario. Esta función mueve el guardado aquí: valida el
// captcha de Turnstile, vuelve a validar los datos (nunca confiar en lo que mande el cliente),
// lee el evento real desde Firestore (no lo que diga el payload), y solo entonces escribe.

import { toFirestoreValue, toFirestoreFields, fromFirestoreFields, firestoreAdminAuth } from "./_lib/firestore-admin.js";
import { DOMINIOS_DESECHABLES } from "./_lib/dominios-desechables.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(s) {
  return (s === null || s === undefined) ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// No bloquea el registro (un falso positivo perdería un prospecto real) — solo marca el correo
// para que el staff lo vea reflejado como 🚩 en Inscritos y decida si vale la pena darle seguimiento.
const esCorreoDesechable = (correo) => DOMINIOS_DESECHABLES.has(correo.split("@").pop() || "");

function isValidTelefono(t) {
  const digitos = t.replace(/[^\d]/g, "");
  if (digitos.length < 10 || digitos.length > 13) return false;
  if (/^(\d)\1+$/.test(digitos)) return false;
  const secuencias = ["0123456789", "1234567890", "9876543210"];
  if (secuencias.some(s => digitos.includes(s.slice(0, 10)))) return false;
  return true;
}

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

// ── Firestore: helpers específicos de este flujo ────────────────────────────────────────────

async function runQueryExiste(base, headers, filtros) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: "inscripciones_evento" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: filtros.map(f => ({
            fieldFilter: { field: { fieldPath: f.field }, op: "EQUAL", value: toFirestoreValue(f.value) }
          })),
        },
      },
      limit: 1,
    },
  };
  const resp = await fetch(`${base}:runQuery`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) return false;
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows.some(r => r && r.document);
}

async function existeInscripcion(base, headers, eventoId, correo, telefono) {
  if (correo && await runQueryExiste(base, headers, [{ field: "eventoId", value: eventoId }, { field: "correo", value: correo }])) return true;
  if (telefono && await runQueryExiste(base, headers, [{ field: "eventoId", value: eventoId }, { field: "telefono", value: telefono }])) return true;
  return false;
}

// ── Correos de confirmación (reutiliza /send-email, que ya habla con Brevo) ────────────────

async function enviarCorreosConfirmacion(origin, evento, correoAdmin, nombreEmpresaCRM, datos, docId) {
  const { nombre, empresa, correo, telefono, fuente, usaSistema, asistira, deseaCanalWhatsapp } = datos;
  const fechaLarga = evento.fecha
    ? new Date(evento.fecha + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "";

  const mensajePlantilla = resolverPlantillaEvento(evento.plantilla, evento, { nombre }).replace(/\n/g, "<br>");
  const htmlCliente = `
<div style="font-family:'Segoe UI',sans-serif;max-width:580px;margin:0 auto;background:#0f1117;border-radius:16px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 32px 24px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:8px;">🎉</div>
    <h1 style="color:#fff;font-size:1.4rem;font-weight:800;margin:0;">¡Registro confirmado!</h1>
  </div>
  <div style="padding:28px 32px;background:#141827;color:#cbd5e1;">
    <p style="font-size:0.95rem;line-height:1.7;">${mensajePlantilla}</p>
  </div>
  <div style="padding:16px 32px;background:#0f1117;text-align:center;">
    <p style="font-size:0.75rem;color:#334155;margin:0;">${nombreEmpresaCRM}</p>
  </div>
</div>`;

  const htmlAdmin = `
<div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;">
  <h2 style="color:#1e293b;border-bottom:2px solid #6366f1;padding-bottom:8px;">🔔 Nuevo registro en evento</h2>
  <p style="color:#475569;margin-bottom:16px;"><strong>${escapeHtml(evento.nombre || "")}</strong>${fechaLarga ? " — " + fechaLarga : ""}</p>
  <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
    <tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;width:36%;">Nombre</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(nombre)}</td></tr>
    ${empresa ? `<tr><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">Empresa</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(empresa)}</td></tr>` : ""}
    ${correo ? `<tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">Correo</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><a href="mailto:${escapeHtml(correo)}" style="color:#6366f1;">${escapeHtml(correo)}</a></td></tr>` : ""}
    ${telefono ? `<tr><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">Teléfono</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(telefono)}</td></tr>` : ""}
    <tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">¿Asistirá?</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(asistira)}</td></tr>
    ${usaSistema ? `<tr><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">¿Usa ${escapeHtml(evento.sistema || "")}?</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(usaSistema)}</td></tr>` : ""}
    ${fuente ? `<tr><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">Fuente</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(fuente)}</td></tr>` : ""}
    <tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;color:#334155;">Canal WhatsApp</td><td style="padding:10px 14px;">${deseaCanalWhatsapp ? "✅ Sí quiere unirse" : "No"}</td></tr>
  </table>
  <p style="margin-top:20px;font-size:0.78rem;color:#94a3b8;">Puedes ver todos los inscritos en CRM → Eventos → 👥 Inscritos.</p>
</div>`;

  // correoSoporte puede traer varios correos separados por coma en un solo string (ej. "a@x.com,
  // b@x.com") — Brevo espera una lista, no un único destinatario con comas adentro.
  const adminList = correoAdmin.split(",").map(s => s.trim()).filter(Boolean);

  // Fallos silenciosos a propósito (Promise.allSettled, sin then/catch de cada uno) — un correo
  // que no se pudo mandar no debe tumbar el registro, que ya quedó guardado en Firestore.
  await Promise.allSettled([
    adminList.length
      ? fetch(`${origin}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: adminList, subject: `🔔 Nuevo registro: ${nombre} — ${evento.nombre || evento.id}`, html: htmlAdmin }) })
      : Promise.resolve(null),
    correo
      // La tag "insc_<docId>" es lo único que le permite al webhook de Brevo (ver
      // functions/brevo-webhook.js) saber a qué inscripción corresponde un aviso de
      // entregado/rebotado — Brevo la regresa tal cual en cada evento del webhook. Sin docId
      // (no debería pasar, pero por si acaso) se manda sin tag en vez de una tag rota.
      ? fetch(`${origin}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: correo, subject: `✅ Confirmación de registro — ${evento.nombre || "Evento"}`, html: htmlCliente, ...(docId ? { tags: [`insc_${docId}`] } : {}) }) })
      : Promise.resolve(null),
  ]);
}

// ── Handler ──────────────────────────────────────────────────────────────────────────────

export const onRequestPost = async (context) => {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
  }

  const eventoId = String(payload.eventoId || "").trim();
  const nombre = String(payload.nombre || "").trim();
  const empresa = String(payload.empresa || "").trim();
  const correo = String(payload.correo || "").trim().toLowerCase();
  const telefono = String(payload.telefono || "").trim();
  const fuente = String(payload.fuente || "").trim();
  const usaSistemaPayload = String(payload.usaSistema || "").trim();
  const asistira = String(payload.asistira || "").trim();
  const deseaCanalWhatsapp = !!payload.deseaCanalWhatsapp;
  const turnstileToken = payload.turnstileToken;

  if (!eventoId || !nombre) return jsonResponse({ ok: false, error: "Faltan campos obligatorios" }, 400);
  if (!asistira) return jsonResponse({ ok: false, error: "Indica si asistirás al webinar" }, 400);
  if (!correo && !telefono) return jsonResponse({ ok: false, error: "Ingresa al menos un correo o un teléfono" }, 400);
  if (correo && !isValidEmail(correo)) return jsonResponse({ ok: false, error: "Correo inválido" }, 400);
  if (telefono && !isValidTelefono(telefono)) return jsonResponse({ ok: false, error: "Teléfono inválido" }, 400);

  if (!env.TURNSTILE_SECRET) return jsonResponse({ ok: false, error: "Turnstile no configurado en el servidor" }, 500);
  if (!turnstileToken) return jsonResponse({ ok: false, error: "Falta verificación anti-bots" }, 403);

  const tsResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: turnstileToken,
      remoteip: request.headers.get("CF-Connecting-IP") || "",
    }),
  });
  const tsData = await tsResp.json().catch(() => null);
  if (!tsData || !tsData.success) {
    console.error("[registrar-evento] siteverify rechazado:", JSON.stringify(tsData));
    return jsonResponse({ ok: false, error: "No se pudo verificar que eres una persona real" }, 403);
  }

  let base, headers;
  try {
    ({ base, headers } = await firestoreAdminAuth(env));
  } catch (err) {
    console.error("[registrar-evento] Error de auth con Firebase:", err);
    return jsonResponse({ ok: false, error: "Error de autenticación con Firebase" }, 500);
  }

  // Datos del evento SIEMPRE desde Firestore, nunca desde lo que mande el navegador — evita que
  // alguien invente un nombre/link de evento distinto pasando solo un eventoId real.
  const pubResp = await fetch(`${base}/agenda/publico`, { headers });
  if (!pubResp.ok) return jsonResponse({ ok: false, error: "No se pudo leer la configuración pública" }, 500);
  const pubDoc = await pubResp.json();
  const pubData = fromFirestoreFields(pubDoc.fields || {});
  const evento = (pubData.eventos || []).find(e => e.id === eventoId);
  if (!evento) return jsonResponse({ ok: false, error: "Evento no encontrado" }, 404);

  // "¿Usas [sistema]?" y "¿Asistirás?" son ahora solo informativos (se guardan y se muestran en
  // Inscritos) — ya no bloquean el registro. Antes, responder "No" al sistema rechazaba el
  // registro por completo; se decidió que es mejor dejar que todos se registren.
  if (evento.sistema && !usaSistemaPayload) return jsonResponse({ ok: false, error: `Indica si utilizas ${evento.sistema}` }, 400);

  const yaExiste = await existeInscripcion(base, headers, eventoId, correo, telefono);
  if (yaExiste) return jsonResponse({ ok: true, duplicado: true });

  const nuevaInscripcion = {
    eventoId, eventoNombre: evento.nombre || "", nombre, empresa, correo, telefono, fuente,
    usaSistema: usaSistemaPayload, asistira, deseaCanalWhatsapp, fechaRegistro: new Date().toISOString(),
    correoSospechoso: correo ? esCorreoDesechable(correo) : false,
  };
  const createResp = await fetch(`${base}/inscripciones_evento`, {
    method: "POST", headers, body: JSON.stringify({ fields: toFirestoreFields(nuevaInscripcion) }),
  });
  if (!createResp.ok) {
    console.error("[registrar-evento] Error al crear documento:", await createResp.text().catch(() => ""));
    return jsonResponse({ ok: false, error: "No se pudo guardar el registro" }, 500);
  }
  // "name" viene como projects/.../documents/inscripciones_evento/<ID> — el último segmento es
  // el ID real del documento, se usa para etiquetar el correo de confirmación (ver más abajo).
  const createdDoc = await createResp.json().catch(() => null);
  const docId = createdDoc?.name ? createdDoc.name.split("/").pop() : null;

  const origin = new URL(request.url).origin;
  await enviarCorreosConfirmacion(origin, evento, pubData.correoSoporte || "", pubData.nombreEmpresa || "DATTASOFT", nuevaInscripcion, docId);

  return jsonResponse({ ok: true, evento: { nombre: evento.nombre, fecha: evento.fecha, hora: evento.hora } });
};
