const CONTACT_TO = "kontakt@expert-financial.pl";
const CONTACT_FROM = "formularz@expert-financial.pl";
const RESEND_API_URL = "https://api.resend.com/emails";

// Resend caps the whole message at 40MB after Base64 encoding of
// attachments. Stay well under that so encoding overhead is never a concern.
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5;

// Leftover URLs from the old WordPress site that Google still has crawled and
// is flagging as 404s in Search Console. Redirect them instead of 404ing so
// any inbound links/link equity land on the current homepage.
const LEGACY_REDIRECTS = new Set([
  "/o-nas",
  "/o-nas/",
  "/blog",
  "/blog/",
  "/category/dlugi",
  "/category/dlugi/",
  "/kredyt-gotowkowy-kiedy-warto-go-wziac",
  "/kredyt-gotowkowy-kiedy-warto-go-wziac/",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (LEGACY_REDIRECTS.has(url.pathname)) {
      return Response.redirect(`${url.origin}/`, 301);
    }

    if (request.method === "POST" && url.pathname === "/api/contact") {
      return handleContact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "invalid_form" }, 400);
  }

  // Honeypot: real visitors never fill this hidden field.
  if (str(form.get("website"))) {
    return json({ ok: true });
  }

  const firstName = str(form.get("first-name"));
  const lastName = str(form.get("last-name"));
  const email = str(form.get("email"));
  const phone = str(form.get("phone"));
  const topic = str(form.get("topic"));
  const message = str(form.get("message"));

  if (!firstName || !lastName || !email || !phone) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }

  const fileEntries = form
    .getAll("attachment")
    .filter((f) => f instanceof File && f.size > 0);

  if (fileEntries.length > MAX_FILES) {
    return json({ ok: false, error: "too_many_files" }, 400);
  }
  const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
    return json({ ok: false, error: "files_too_large" }, 400);
  }

  const attachments = [];
  for (const file of fileEntries) {
    attachments.push({
      content: arrayBufferToBase64(await file.arrayBuffer()),
      filename: file.name,
    });
  }

  const html = `
    <h2>Nowe zapytanie ze strony expert-financial.pl</h2>
    <p><b>Temat:</b> ${esc(topic)}</p>
    <p><b>Imię i nazwisko:</b> ${esc(firstName)} ${esc(lastName)}</p>
    <p><b>E-mail:</b> ${esc(email)}</p>
    <p><b>Telefon:</b> ${esc(phone)}</p>
    <p><b>Wiadomość:</b><br>${esc(message).replace(/\n/g, "<br>") || "(brak)"}</p>
  `;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Formularz Expert Financial <${CONTACT_FROM}>`,
        to: [CONTACT_TO],
        reply_to: email,
        subject: `Nowe zapytanie: ${topic || "Kontakt ze strony"} — ${firstName} ${lastName}`,
        html,
        attachments,
      }),
    });

    if (!res.ok) {
      console.error("Resend send failed", res.status, await res.text());
      return json({ ok: false, error: "send_failed" }, 502);
    }
  } catch (err) {
    console.error("Resend request threw", err);
    return json({ ok: false, error: "send_failed" }, 502);
  }

  return json({ ok: true });
}

function str(value) {
  return (value ?? "").toString().trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
