// Helpers compartidos por las Functions que necesitan leer/escribir Firestore desde el servidor
// (registrar-evento.js, brevo-webhook.js). No hay SDK de firebase-admin disponible en el runtime
// de Cloudflare Workers/Pages (depende de Node puro) — se habla con la API REST de Firestore,
// autenticando con un JWT firmado con la cuenta de servicio (Web Crypto API, no Node crypto) y
// canjeándolo por un access token de Google.

export function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

export function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[k] = toFirestoreValue(val);
  }
  return fields;
}

export function fromFirestoreValue(v) {
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

export function fromFirestoreFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

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

export async function obtenerAccessTokenGoogle(clientEmail, privateKeyPem) {
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

// Punto de entrada único para cualquier Function que necesite hablar con Firestore: valida que
// las 3 credenciales estén configuradas, canjea el access token, y regresa listo para usar
// { base, headers } — base es la URL de la colección raíz de documentos, headers ya trae el
// Bearer token y Content-Type.
export async function firestoreAdminAuth(env) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error("Credenciales de Firebase no configuradas en el servidor");
  }
  const accessToken = await obtenerAccessTokenGoogle(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  return { base, headers };
}
