// Cloudflare Pages Function: paso 2 del setup de "respuestas de cliente por correo" — Google
// redirige aquí después de que Erick autoriza, con un "code" de un solo uso. Esta Function lo
// canjea por el refresh_token de larga duración y lo MUESTRA en pantalla (nunca lo guarda en
// ningún lado) para que Erick lo copie directo al secret de Cloudflare GMAIL_REFRESH_TOKEN — así
// ese token nunca pasa por el chat, por git, ni por ningún otro lugar.

function paginaHtml(titulo, cuerpoHtml) {
  return new Response(
    `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:sans-serif;max-width:640px;margin:60px auto;padding:0 20px;background:#111827;color:#e5e7eb;}
    code{background:#1f2937;padding:3px 8px;border-radius:4px;word-break:break-all;display:inline-block;margin-top:8px;}
    h1{font-size:1.3rem;}</style></head><body>${cuerpoHtml}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  // El secreto viaja en "state" (ver gmail-oauth-iniciar.js) — Google lo regresa tal cual, sin
  // que el redirect_uri registrado en Google Cloud Console necesite llevar query params.
  if (!env.GMAIL_OAUTH_SETUP_SECRET || url.searchParams.get("state") !== env.GMAIL_OAUTH_SETUP_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const code = url.searchParams.get("code");
  const errorGoogle = url.searchParams.get("error");
  if (errorGoogle) return paginaHtml("Error", `<h1>❌ Google reportó un error</h1><p>${errorGoogle}</p>`);
  if (!code) return paginaHtml("Error", "<h1>❌ Falta el código de Google</h1><p>Vuelve a intentar desde el paso 1.</p>");

  const redirectUri = `${url.origin}/gmail-oauth-callback`;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  const data = await tokenResp.json();
  if (!tokenResp.ok || !data.refresh_token) {
    return paginaHtml("Error", `<h1>❌ No se pudo obtener el refresh token</h1>
      <p>${data.error_description || data.error || "Google no regresó un refresh_token."}</p>
      <p>Si ya habías autorizado esta app antes, puede que Google no reenvíe el refresh_token la segunda vez — entra primero a
      <a href="https://myaccount.google.com/permissions" style="color:#818cf8;">myaccount.google.com/permissions</a>,
      quita el acceso de esta app, y vuelve a intentar desde el paso 1.</p>`);
  }

  return paginaHtml("Listo", `
    <h1>✅ Autorizado correctamente</h1>
    <p>Copia este valor y guárdalo como el secret de Cloudflare Pages <strong>GMAIL_REFRESH_TOKEN</strong>
    (Configuración → Variables y secretos del proyecto crm-dattasoft, tipo "Secret"):</p>
    <code>${data.refresh_token}</code>
    <p style="margin-top:24px; color:#9ca3af; font-size:0.85rem;">No cierres ni recargues esta página antes de copiarlo — Google no lo vuelve a mostrar.
    En cuanto lo guardes como secret, puedes cerrar esta pestaña.</p>
  `);
};
