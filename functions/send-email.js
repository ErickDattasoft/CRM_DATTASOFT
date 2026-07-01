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

  const { to, subject, html, replyTo, from, cc } = payload;
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
  // Brevo solo acepta UN correo en replyTo — si llega una lista (separada por coma), usar solo el primero.
  const replyToEmail = Array.isArray(replyTo) ? replyTo[0] : String(replyTo || "").split(",")[0].trim();
  if (replyToEmail) body.replyTo = { email: replyToEmail };
  if (cc) {
    // No excluir fromEmail: el remitente NO recibe copia automática solo por ser el "From".
    const ccList = (Array.isArray(cc) ? cc : String(cc).split(","))
      .map(e => String(e).trim())
      .filter(Boolean)
      .filter(e => !toList.some(t => t.email === e));
    if (ccList.length) body.cc = ccList.map(email => ({ email }));
  }

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
