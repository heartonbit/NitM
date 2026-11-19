function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SOURCE_LABELS = {
  politico: "🏛️ Politico",
  "politico eu": "🏛️ Politico",
  "politico europe": "🏛️ Politico",
  ft: "📈 FT",
  "financial times": "📈 FT",
  euractiv: "🇪🇺 Euractiv",
  euractive: "🇪🇺 Euractiv",
};

function formatSourceLabel(name) {
  const trimmed = name.trim();
  return SOURCE_LABELS[trimmed.toLowerCase()] || `📰 ${trimmed}`;
}

function displayTimestamp(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})/.exec(value);
  if (iso) return `${iso[1].slice(2)}/${iso[2]}/${iso[3]} ${iso[4]}:${iso[5]}`;
  const rfc = /^(?:[A-Za-z]+,\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})/i.exec(value);
  if (rfc) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(rfc[2].toLowerCase()) + 1;
    if (month) return `${rfc[3].slice(2)}/${String(month).padStart(2, "0")}/${rfc[1].padStart(2, "0")} ${rfc[4]}:${rfc[5]}`;
  }
  return value;
}

function normalizePublished(value) {
  const timestamps = [];
  let token = "NITM_PUBLISHED_TOKEN";
  while (value.includes(token)) token += "_";
  const normalized = value.replace(/\[\[published:([^\]]+)\]\]/g, (_match, contents) => {
    timestamps.push(...contents.split(";").map((entry) => entry.trim()).filter(Boolean));
    return token;
  });
  if (!timestamps.length) return normalized;
  const dated = timestamps.filter((entry) => /^(?:\d{4}-\d{2}-\d{2}[Tt ]|(?:[A-Za-z]+,\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s)/.test(entry))
    .map((entry) => ({ entry, time: Date.parse(entry) })).filter(({ time }) => Number.isFinite(time));
  if (dated.length !== timestamps.length) return value;
  const earliest = dated.length ? dated.reduce((first, current) => current.time < first.time ? current : first).entry : timestamps[0];
  let inserted = false;
  return normalized.split(token).map((part, index) => {
    if (!index) return part;
    if (inserted) return part;
    inserted = true;
    return `[[published:${displayTimestamp(earliest)}]]${part}`;
  }).join("");
}

function sourceLabels(value) {
  return value.replace(/\{([^{}]+)\}/g, (_original, names) =>
    names
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map(formatSourceLabel)
      .join(" "),
  );
}

function reorderTitleSource(value) {
  const publishedMatch = /\[\[published:[^\]]+\]\]/.exec(value);
  if (!publishedMatch) return value;
  let source = null;
  let body;
  // Source inside a leading link label: [{source} title](url)
  const linkLead = /^(\s*)\[\s*\{([^{}\[\]]+)\}([^\]]*)\]/.exec(value);
  if (linkLead) {
    source = `{${linkLead[2]}}`;
    body = `${linkLead[1]}[${linkLead[3].trim()}]${value.slice(linkLead[0].length)}`;
  } else {
    // Plain leading source block: {source} title (optional heading/bullet marker)
    const sourceLead = /^(\s*(?:#{1,3}\s+|[-*+]\s+)?)\{([^{}\[\]]+)\}\s*/.exec(value);
    if (!sourceLead) return value;
    source = `{${sourceLead[2]}}`;
    body = `${sourceLead[1]}${value.slice(sourceLead[0].length)}`;
  }
  const marker = /\[\[published:[^\]]+\]\]/.exec(body)[0];
  return body.replace(marker, `${source} ${marker}`);
}

function safeInline(value) {
  const published = [];
  let prefix = "NITM_EMAIL_TOKEN_";
  while (value.includes(prefix)) prefix += "_";
  const withBadges = sourceLabels(normalizePublished(reorderTitleSource(value)));
  const withTokens = withBadges.replace(/\[\[published:([^\]]+)\]\]/g, (_match, timestamp) => {
    const token = `${prefix}PUBLISHED_${published.length}_`;
    published.push(timestamp);
    return token;
  });
  let html = escapeHtml(withTokens);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) =>
    `<a href="${escapeHtml(href)}">${label}</a>`,
  );
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  for (const [index, timestamp] of published.entries()) {
    html = html.replace(`${prefix}PUBLISHED_${index}_`, `<small style="font-size:12px;color:#65736b;font-weight:400">${escapeHtml(timestamp)}</small>`);
  }
  return html;
}

export function markdownToEmailHtml(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(safeInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((line) => `<li>${safeInline(line)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 3);
      blocks.push(`<h${level}>${safeInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return `<!doctype html><html><body style="font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;color:#202522;margin:0;padding:24px"><main style="max-width:680px;margin:auto">${blocks.join("\n")}</main></body></html>`;
}

function safeMetadata(value, fallback) {
  return String(value || fallback).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 240) || fallback;
}

export function emailFooterText(version, requestedModel, responseModel) {
  return `\n\n---\nNitM v${version} · LLM 요청 모델: ${safeMetadata(requestedModel, "미설정")} · 응답 모델: ${safeMetadata(responseModel, "응답값 미기록")}\n`;
}

export function emailFooterHtml(version, requestedModel, responseModel) {
  return `<hr style="border:0;border-top:1px solid #d9dfda;margin:32px 0 16px"><p style="color:#68736b;font-size:12px">NitM 뉴스 브리핑 · 수신 설정은 로그인 후 변경할 수 있습니다.</p><p style="color:#68736b;font-size:12px">NitM v${escapeHtml(version)} · LLM 요청 모델: ${escapeHtml(safeMetadata(requestedModel, "미설정"))} · 응답 모델: ${escapeHtml(safeMetadata(responseModel, "응답값 미기록"))}</p>`;
}

let versionPromise;
async function projectVersion(env) {
  versionPromise ??= (async () => {
    if (!env.ASSETS) return "unknown";
    const response = await env.ASSETS.fetch(new Request("https://nitm-assets/version.txt"));
    if (!response.ok) return "unknown";
    const value = (await response.text()).trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : "unknown";
  })();
  return versionPromise;
}

export async function sendEmail(env, { to, subject, markdown, requestedModel, responseModel }) {
  if (!env.RESEND_API_KEY) throw new Error("mail_not_configured");
  const version = await projectVersion(env);
  const configuredModel = requestedModel || env.LLM_MODEL || "미사용";
  const footerHtml = emailFooterHtml(version, requestedModel || configuredModel, responseModel);
  const textBody = markdown
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => sourceLabels(normalizePublished(reorderTitleSource(line))).replace(/\[\[published:([^\]]+)\]\]/g, "$1"))
    .join("\n");
  const text = `${textBody}${emailFooterText(version, requestedModel || configuredModel, responseModel)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "NitM-NewsDigest",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || "NitM <onboarding@resend.dev>",
      to: [to],
      subject,
      html: markdownToEmailHtml(markdown).replace("</main>", `${footerHtml}</main>`),
      text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error("Resend request failed", response.status);
    throw new Error("email_error");
  }
  return response.json();
}