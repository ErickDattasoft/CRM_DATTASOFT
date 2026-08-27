// Cloudflare Pages Function: recordatorio automático antes del evento + seguimiento automático
// después. Cloudflare Pages Functions no soportan Cron Triggers directamente (eso es solo para
// Workers "planos", no para proyectos de Pages) — el disparador real vive en un GitHub Actions
// workflow programado (.github/workflows/cron-eventos.yml) que llama este endpoint cada hora.
//
// Por qué cada hora y no algo más preciso: es la cadencia mínima razonable sin depender de
// infraestructura nueva. Cada evento define en qué ventana de una hora le toca su recordatorio
// (fecha del evento menos `horasRecordatorio`) y su seguimiento (fecha del evento más
// `horasSeguimiento`) — si el cron corre puntual cada hora, cada evento cae en su ventana una
// sola vez, y el flag *Enviado en cada inscripción evita reenvíos si el cron se reintentara.

import { toFirestoreValue, fromFirestoreFields, firestoreAdminAuth } from "./_lib/firestore-admin.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
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

const HORAS_RECORDATORIO_DEFAULT = 24;
const HORAS_SEGUIMIENTO_DEFAULT = 24;
const UNA_HORA_MS = 3600000;

async function listarInscritosEvento(base, headers, eventoId) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: "inscripciones_evento" }],
      where: { fieldFilter: { field: { fieldPath: "eventoId" }, op: "EQUAL", value: toFirestoreValue(eventoId) } },
      limit: 500,
    },
  };
  const resp = await fetch(`${base}:runQuery`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) return [];
  const rows = await resp.json().catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && r.document)
    .map(r => ({ id: r.document.name.split("/").pop(), ...fromFirestoreFields(r.document.fields || {}) }));
}

async function enviarPendientes(base, headers, origin, ev, tipo, nombreEmpresaCRM) {
  const campoFlag = tipo === "recordatorio" ? "recordatorioEnviado" : "seguimientoEnviado";
  const plantillaTexto = tipo === "recordatorio" ? (ev.plantilla || PLANTILLA_EVENTO_DEFAULT) : ev.mensajeSeguimiento;
  if (!plantillaTexto) return 0;

  const cabecera = tipo === "recordatorio"
    ? { emoji: "⏰", titulo: "¡Tu webinar es pronto!" }
    : { emoji: "📩", titulo: "Gracias por tu interés" };
  const subject = tipo === "recordatorio"
    ? `⏰ Recordatorio: ${ev.nombre || "tu webinar"} es pronto`
    : `${ev.nombre || "Webinar"} — gracias por tu interés`;

  const inscritos = await listarInscritosEvento(base, headers, ev.id);
  let enviados = 0;
  for (const i of inscritos) {
    if (!i.correo || i[campoFlag]) continue;
    const mensaje = resolverPlantillaEvento(plantillaTexto, ev, i).replace(/\n/g, "<br>");
    const html = `
<div style="font-family:'Segoe UI',sans-serif;max-width:580px;margin:0 auto;background:#0f1117;border-radius:16px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 32px 24px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:8px;">${cabecera.emoji}</div>
    <h1 style="color:#fff;font-size:1.4rem;font-weight:800;margin:0;">${cabecera.titulo}</h1>
  </div>
  <div style="padding:28px 32px;background:#141827;color:#cbd5e1;">
    <p style="font-size:0.95rem;line-height:1.7;">${mensaje}</p>
  </div>
  <div style="padding:16px 32px;background:#0f1117;text-align:center;">
    <p style="font-size:0.75rem;color:#334155;margin:0;">${nombreEmpresaCRM}</p>
  </div>
</div>`;
    try {
      const resp = await fetch(`${origin}/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: i.correo, subject, html }),
      });
      if (resp.ok) {
        await fetch(`${base}/inscripciones_evento/${i.id}?updateMask.fieldPaths=${campoFlag}`, {
          method: "PATCH", headers, body: JSON.stringify({ fields: { [campoFlag]: { booleanValue: true } } }),
        });
        enviados++;
      } else {
        console.error(`[cron-eventos] send-email respondió ${resp.status} para`, i.correo);
      }
    } catch (err) {
      console.error(`[cron-eventos] Error enviando ${tipo} a`, i.correo, err);
    }
  }
  return enviados;
}

export const onRequestPost = async (context) => {
  const { request, env } = context;

  const url = new URL(request.url);
  if (!env.CRON_EVENTOS_SECRET || url.searchParams.get("key") !== env.CRON_EVENTOS_SECRET) {
    return jsonResponse({ ok: false, error: "No autorizado" }, 401);
  }

  let base, headers;
  try {
    ({ base, headers } = await firestoreAdminAuth(env));
  } catch (err) {
    console.error("[cron-eventos] Error de auth con Firebase:", err);
    return jsonResponse({ ok: false, error: "Error de autenticación con Firebase" }, 500);
  }

  const pubResp = await fetch(`${base}/agenda/publico`, { headers });
  if (!pubResp.ok) return jsonResponse({ ok: false, error: "No se pudo leer agenda/publico" }, 500);
  const pubDoc = await pubResp.json();
  const pubData = fromFirestoreFields(pubDoc.fields || {});
  const eventos = pubData.eventos || [];
  const nombreEmpresaCRM = pubData.nombreEmpresa || "DATTASOFT";
  const origin = url.origin;

  const ahora = Date.now();
  let recordatoriosEnviados = 0;
  let seguimientosEnviados = 0;

  for (const ev of eventos) {
    if (!ev.fecha) continue;
    const eventoTs = new Date(`${ev.fecha}T${ev.hora || "00:00"}:00`).getTime();
    if (!Number.isFinite(eventoTs)) continue;

    const horasRec = ev.horasRecordatorio === 0 ? 0 : (ev.horasRecordatorio || HORAS_RECORDATORIO_DEFAULT);
    if (horasRec > 0) {
      const objetivoRec = eventoTs - horasRec * UNA_HORA_MS;
      if (ahora >= objetivoRec && ahora < objetivoRec + UNA_HORA_MS) {
        recordatoriosEnviados += await enviarPendientes(base, headers, origin, ev, "recordatorio", nombreEmpresaCRM);
      }
    }

    if (ev.mensajeSeguimiento) {
      const horasSeg = ev.horasSeguimiento || HORAS_SEGUIMIENTO_DEFAULT;
      const objetivoSeg = eventoTs + horasSeg * UNA_HORA_MS;
      if (ahora >= objetivoSeg && ahora < objetivoSeg + UNA_HORA_MS) {
        seguimientosEnviados += await enviarPendientes(base, headers, origin, ev, "seguimiento", nombreEmpresaCRM);
      }
    }
  }

  return jsonResponse({ ok: true, recordatoriosEnviados, seguimientosEnviados });
};
