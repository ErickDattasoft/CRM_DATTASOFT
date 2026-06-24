export const onRequestPost = async (context) => {
  const { request, env } = context;

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY no configurada en Cloudflare" }), {
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

  const fromAddress = from || env.RESEND_FROM || "soporte@dattasoft.mx";

  const body = {
    from: fromAddress,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (replyTo) body.reply_to = replyTo;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
