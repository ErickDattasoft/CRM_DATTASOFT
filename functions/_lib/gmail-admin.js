// Helper compartido para hablar con la Gmail API desde una Cloudflare Function, usando OAuth de
// Google (no hay SDK de Google disponible en el runtime de Cloudflare Workers/Pages). Se autoriza
// UNA SOLA VEZ (ver functions/gmail-oauth-callback.js) para obtener un refresh_token de larga
// duración, que se guarda como secret de Cloudflare (GMAIL_REFRESH_TOKEN) — cada corrida del
// cron lo canjea por un access_token nuevo (expira en 1h) sin volver a pedirle nada a Erick.

export async function obtenerAccessTokenGmail(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error("Credenciales de Gmail no configuradas en el servidor");
  }
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`No se pudo refrescar el access token de Gmail (HTTP ${resp.status}): ${await resp.text().catch(() => "")}`);
  const data = await resp.json();
  return data.access_token;
}

function base64urlDecode(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

// Extrae el cuerpo en texto plano de un mensaje de Gmail (payload puede ser simple o multipart;
// se busca recursivamente la primera parte text/plain, como hace cualquier cliente de correo).
export function extraerTextoPlano(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return base64urlDecode(payload.body.data);
  for (const part of payload.parts || []) {
    const texto = extraerTextoPlano(part);
    if (texto) return texto;
  }
  // Sin parte text/plain (algunos clientes solo mandan HTML) — mejor que nada: se guarda el HTML
  // crudo, visible aunque no tan limpio, en vez de perder el mensaje por completo.
  if (payload.mimeType === "text/html" && payload.body?.data) return base64urlDecode(payload.body.data);
  return "";
}

export function headerValor(headers, nombre) {
  const h = (headers || []).find(x => x.name?.toLowerCase() === nombre.toLowerCase());
  return h?.value || "";
}
