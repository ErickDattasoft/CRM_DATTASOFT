exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "RESEND_API_KEY no configurada en Netlify" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const { to, subject, html, replyTo, cc } = payload;
  if (!to || !subject || !html) {
    return { statusCode: 400, body: JSON.stringify({ error: "Faltan campos: to, subject, html" }) };
  }

  const fromAddress = process.env.RESEND_FROM || "soporte@dattasoft.mx";

  const body = {
    from: fromAddress,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (replyTo) body.reply_to = replyTo;
  if (cc) body.cc = Array.isArray(cc) ? cc : String(cc).split(",").map(e => e.trim()).filter(Boolean);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("[send-email] Resend error", resp.status, JSON.stringify(data));
    return {
      statusCode: resp.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: data.message || data.name || JSON.stringify(data) }),
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
};
