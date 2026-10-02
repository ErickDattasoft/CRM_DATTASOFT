// Cloudflare Pages Function: arma la URL de autorización de Google y redirige — paso 1 del
// setup de "respuestas de cliente por correo" (ver correo-entrante-ticket.js). Se visita UNA
// sola vez durante la configuración inicial, nunca en uso normal del CRM.
//
// access_type=offline + prompt=consent: sin esto Google a veces NO regresa refresh_token en el
// callback (solo lo manda la primera vez que el usuario consiente, o si se fuerza con
// prompt=consent) — como este flujo necesita el refresh_token sí o sí para funcionar sin
// intervención humana después, se fuerza siempre.

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!env.GMAIL_OAUTH_SETUP_SECRET || url.searchParams.get("key") !== env.GMAIL_OAUTH_SETUP_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response("Falta configurar GOOGLE_CLIENT_ID en Cloudflare", { status: 500 });
  }

  // El redirect_uri debe coincidir EXACTO (sin query params extra) con el registrado en Google
  // Cloud Console — por eso el secreto va en "state" (hecho justo para esto, no en la URL de
  // retorno), que Google regresa tal cual en el callback.
  const redirectUri = `${url.origin}/gmail-oauth-callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.modify",
    access_type: "offline",
    prompt: "consent",
    login_hint: "erick.casas@dattasoft.mx",
    state: env.GMAIL_OAUTH_SETUP_SECRET,
  });

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
};
