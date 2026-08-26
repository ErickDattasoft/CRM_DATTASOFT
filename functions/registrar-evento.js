// Cloudflare Pages Function: único punto de entrada para registrarse a un evento público.
//
// Antes, registro-evento.astro escribía directo a Firestore desde el navegador (reglas
// `allow create: if true` en inscripciones_evento) — cualquier bot podía llenar Inscritos de
// basura sin siquiera tocar el formulario. Esta función mueve el guardado aquí: valida el
// captcha de Turnstile, vuelve a validar los datos (nunca confiar en lo que mande el cliente),
// lee el evento real desde Firestore (no lo que diga el payload), y solo entonces escribe.
//
// No hay SDK de firebase-admin disponible en el runtime de Cloudflare Workers/Pages (depende de
// Node puro) — se habla con Firestore por su API REST, autenticando con un JWT firmado con la
// cuenta de servicio (Web Crypto API, no Node crypto) y canjeándolo por un access token de Google.

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(s) {
  return (s === null || s === undefined) ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

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

// ── Firestore REST: codificación/decodificación de valores tipados ─────────────────────────

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[k] = toFirestoreValue(val);
  }
  return fields;
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

// ── Auth de cuenta de servicio (JWT Bearer → access token) ─────────────────────────────────

function base64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Extrae el payload base64 de un PEM sin asumir cómo haya quedado pegado en la variable de
// entorno: puede traer saltos de línea reales, "\n" escapados (dos caracteres, común al pegar
// una clave multilínea en un campo de una sola línea), o comillas/comas de sobra si alguien
// copió la línea completa del .json incluyendo la sintaxis JSON. Se quitan primero los "\n"
// escapados como si fueran saltos de línea (no se pueden tratar solo como "carácter inválido" —
// dejarían colada la "n" y corromperían la clave) y luego se descarta cualquier cosa que no sea
// alfabeto base64 válido.
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function obtenerAccessTokenGoogle(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(firma)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`No se pudo obtener access token de Google (HTTP ${resp.status})`);
  const data = await resp.json();
  return data.access_token;
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

async function enviarCorreosConfirmacion(origin, evento, correoAdmin, nombreEmpresaCRM, datos) {
  const { nombre, empresa, correo, telefono, fuente, usaSistema, deseaCanalWhatsapp } = datos;
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
    ${usaSistema ? `<tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">¿Usa ${escapeHtml(evento.sistema || "")}?</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(usaSistema)}</td></tr>` : ""}
    ${fuente ? `<tr><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e2e8f0;color:#334155;">Fuente</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${escapeHtml(fuente)}</td></tr>` : ""}
    <tr style="background:#f8fafc;"><td style="padding:10px 14px;font-weight:600;color:#334155;">Canal WhatsApp</td><td style="padding:10px 14px;">${deseaCanalWhatsapp ? "✅ Sí quiere unirse" : "No"}</td></tr>
  </table>
  <p style="margin-top:20px;font-size:0.78rem;color:#94a3b8;">Puedes ver todos los inscritos en CRM → Eventos → 👥 Inscritos.</p>
</div>`;

  await Promise.allSettled([
    correoAdmin
      ? fetch(`${origin}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: correoAdmin, subject: `🔔 Nuevo registro: ${nombre} — ${evento.nombre || evento.id}`, html: htmlAdmin }) })
      : Promise.resolve(),
    correo
      ? fetch(`${origin}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: correo, subject: `✅ Confirmación de registro — ${evento.nombre || "Evento"}`, html: htmlCliente }) })
      : Promise.resolve(),
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
  const deseaCanalWhatsapp = !!payload.deseaCanalWhatsapp;
  const turnstileToken = payload.turnstileToken;

  if (!eventoId || !nombre) return jsonResponse({ ok: false, error: "Faltan campos obligatorios" }, 400);
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
    // El detalle (error-codes de Cloudflare) se manda al cliente solo temporalmente, mientras se
    // depura el primer despliegue — no es información sensible (no expone el secreto).
    return jsonResponse({ ok: false, error: "No se pudo verificar que eres una persona real", debug: tsData }, 403);
  }

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return jsonResponse({ ok: false, error: "Credenciales de Firebase no configuradas en el servidor" }, 500);
  }

  let accessToken;
  try {
    accessToken = await obtenerAccessTokenGoogle(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
  } catch (err) {
    console.error("[registrar-evento] Error de auth con Firebase:", err);
    // Debug temporal — el mensaje de error no incluye la clave privada, solo la razón técnica.
    return jsonResponse({ ok: false, error: "Error de autenticación con Firebase", debug: String(err?.message || err) }, 500);
  }

  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  // Datos del evento SIEMPRE desde Firestore, nunca desde lo que mande el navegador — evita que
  // alguien invente un nombre/link de evento distinto pasando solo un eventoId real.
  const pubResp = await fetch(`${base}/agenda/publico`, { headers });
  if (!pubResp.ok) return jsonResponse({ ok: false, error: "No se pudo leer la configuración pública" }, 500);
  const pubDoc = await pubResp.json();
  const pubData = fromFirestoreFields(pubDoc.fields || {});
  const evento = (pubData.eventos || []).find(e => e.id === eventoId);
  if (!evento) return jsonResponse({ ok: false, error: "Evento no encontrado" }, 404);

  if (evento.sistema) {
    if (!usaSistemaPayload) return jsonResponse({ ok: false, error: `Indica si utilizas ${evento.sistema}` }, 400);
    if (usaSistemaPayload === "No") {
      return jsonResponse({ ok: true, bloqueadoPorSistema: true, sistema: evento.sistema, correoAdmin: pubData.correoSoporte || "" });
    }
  }

  const yaExiste = await existeInscripcion(base, headers, eventoId, correo, telefono);
  if (yaExiste) return jsonResponse({ ok: true, duplicado: true });

  const nuevaInscripcion = {
    eventoId, eventoNombre: evento.nombre || "", nombre, empresa, correo, telefono, fuente,
    usaSistema: usaSistemaPayload, deseaCanalWhatsapp, fechaRegistro: new Date().toISOString(),
  };
  const createResp = await fetch(`${base}/inscripciones_evento`, {
    method: "POST", headers, body: JSON.stringify({ fields: toFirestoreFields(nuevaInscripcion) }),
  });
  if (!createResp.ok) {
    console.error("[registrar-evento] Error al crear documento:", await createResp.text().catch(() => ""));
    return jsonResponse({ ok: false, error: "No se pudo guardar el registro" }, 500);
  }

  const origin = new URL(request.url).origin;
  await enviarCorreosConfirmacion(origin, evento, pubData.correoSoporte || "", pubData.nombreEmpresa || "DATTASOFT", nuevaInscripcion);

  return jsonResponse({ ok: true, evento: { nombre: evento.nombre, fecha: evento.fecha, hora: evento.hora } });
};
