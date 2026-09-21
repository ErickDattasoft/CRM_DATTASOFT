// Cloudflare Pages Function: sirve una imagen pegada en la descripción de un ticket
// (tickets_adjuntos/{id}) como archivo normal, para que el correo de notificación la muestre.
//
// Gmail/Outlook/Zoho no muestran imágenes incrustadas como data:URI dentro del cuerpo del correo,
// así que el correo ahora apunta a esta URL en vez de incrustar la imagen. El id es el id
// aleatorio de Firestore (20 caracteres, no adivinable): quien tiene el correo tiene el link.
// Solo sirve imágenes (nunca PDF/SVG/HTML) y no permite listar ni buscar nada.

import { firestoreAdminAuth } from "./_lib/firestore-admin.js";

const TIPOS_PERMITIDOS = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const noEncontrado = () => new Response("No encontrado", { status: 404 });

export const onRequestGet = async ({ request, env }) => {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9]{15,40}$/.test(id)) return noEncontrado();

  let base, headers;
  try {
    ({ base, headers } = await firestoreAdminAuth(env));
  } catch (err) {
    console.error("[adjunto] Error de auth con Firebase:", err);
    return new Response("Error del servidor", { status: 500 });
  }

  const resp = await fetch(`${base}/tickets_adjuntos/${id}`, { headers });
  if (!resp.ok) return noEncontrado();
  const doc = await resp.json();
  const dataUrl = doc?.fields?.data?.stringValue || "";
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s);
  if (!m || !TIPOS_PERMITIDOS.includes(m[1].toLowerCase())) return noEncontrado();

  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      "Content-Type": m[1].toLowerCase(),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
