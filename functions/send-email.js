export const onRequestPost = async (context) => {
  const { request, env } = context;

  const apiKey = env.BREVO_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "BREVO_API_KEY no configurada en Cloudflare" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const { to, subject, html, replyTo, from } = payload;
  if (!to || !subject || !html) {
    return new Response(JSON.stringify({ error: "Faltan campos: to, subject, html" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const fromEmail = from || env.BREVO_FROM || "erick.casas@dattasoft.mx";
  const fromName = env.BREVO_FROM_NAME || "DATTASOFT Soporte";

  const toList = (Array.isArray(to) ? to : [to]).map(email => ({ email }));

  const body = {
    sender: { name: fromName, email: fromEmail },
    to: toList,
    subject,
    htmlContent: html,
  };
  if (replyTo) body.replyTo = { email: replyTo };

  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
};
