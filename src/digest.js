import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { sendEmail } from "./mailer.js";

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  processEntities: true,
});
const MAX_ARTICLE_BODY_CHARS = 6_000;
const MAX_ARTICLE_HTML_BYTES = 2_000_000;

// 관리자 화면에서 배포 없이 바꿀 수 있는 LLM 튜닝 값. D1 settings 테이블에 저장되며,
// 값이 없거나 범위를 벗어나면 default를 사용한다.
// - max_tokens는 추론 토큰을 포함한다. 미지정 시 제공자 최대치까지 생성되어 반복/추론 폭주가 생길 수 있다.
// - reasoning_effort: omit(필드 미전송) | disabled(추론 끄기) | minimal | low | medium | high (OpenRouter `reasoning` 파라미터)
// - timeout은 Cron 실행 벽시계 한도(15분)를 넘지 않도록 제한한다.
export const LLM_TUNING_FIELDS = {
  llm_temperature: { type: "number", min: 0, max: 2, default: 0.2 },
  llm_reasoning_effort: { type: "enum", values: ["omit", "disabled", "minimal", "low", "medium", "high"], default: "low" },
  llm_timeout_seconds: { type: "integer", min: 10, max: 840, default: 240 },
  llm_max_tokens_classify: { type: "integer", min: 256, max: 131_072, default: 4_000 },
  llm_max_tokens_summarize: { type: "integer", min: 256, max: 131_072, default: 12_000 },
  llm_max_tokens_compress: { type: "integer", min: 256, max: 131_072, default: 12_000 },
  llm_max_tokens_final: { type: "integer", min: 256, max: 131_072, default: 16_000 },
  llm_batch_chars: { type: "integer", min: 2_000, max: 200_000, default: 14_000 },
  llm_max_split_depth: { type: "integer", min: 0, max: 5, default: 3 },
};

function parseTuningValue(spec, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  if (spec.type === "enum") {
    const value = String(raw).trim();
    return spec.values.includes(value) ? value : undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return undefined;
  if (spec.type === "integer" && !Number.isInteger(value)) return undefined;
  return value;
}

// 저장된 settings에서 유효한 튜닝 값을 읽는다(관리자 화면 표시용, settings 키 그대로).
export function llmTuningSettings(settings = {}) {
  return Object.fromEntries(Object.entries(LLM_TUNING_FIELDS).map(([key, spec]) =>
    [key, parseTuningValue(spec, settings[key]) ?? spec.default]));
}

// 관리자 입력 검증. 전달된 키만 검사하며 하나라도 잘못되면 invalid_llm_tuning.
export function validateLlmTuningInput(body = {}) {
  const values = {};
  for (const [key, spec] of Object.entries(LLM_TUNING_FIELDS)) {
    if (body[key] === undefined) continue;
    const parsed = parseTuningValue(spec, body[key]);
    if (parsed === undefined) throw new Error("invalid_llm_tuning");
    values[key] = String(parsed);
  }
  return values;
}

export function llmTuning(settings = {}) {
  const values = llmTuningSettings(settings);
  return {
    temperature: values.llm_temperature,
    reasoningEffort: values.llm_reasoning_effort,
    timeoutMs: values.llm_timeout_seconds * 1000,
    maxTokens: {
      classify: values.llm_max_tokens_classify,
      summarize: values.llm_max_tokens_summarize,
      compress: values.llm_max_tokens_compress,
      final: values.llm_max_tokens_final,
    },
    batchChars: values.llm_batch_chars,
    maxSplitDepth: values.llm_max_split_depth,
  };
}

export function reasoningPayload(effort) {
  if (effort === "omit") return undefined;
  if (effort === "disabled") return { enabled: false };
  return { effort };
}

function isoNow() {
  return new Date().toISOString();
}

export function dateTimeInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in value) return text(value["#text"]);
  return "";
}

function plain(value, limit = 1200) {
  const raw = text(value).replace(/<!\[CDATA\[|\]\]>/g, "");
  if (!raw) return "";
  // cheerio로 파싱 후 .text()를 호출하면 태그 제거와 &#8216;, &amp; 등의 디코딩이 한 번에 처리됩니다.
  const decoded = load(`<div>${raw}</div>`)("div").text();
  return decoded.replace(/\s+/g, " ").trim().slice(0, limit);
}

function entriesOf(feed) {
  const root = feed.rss?.channel ?? feed.feed ?? feed.RDF ?? feed.rdf;
  const entries = root?.item ?? root?.entry ?? feed.RDF?.item ?? feed.rdf?.item ?? [];
  return Array.isArray(entries) ? entries : [entries];
}

export function filterRecentArticles(items, now = new Date()) {
  const end = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const start = end - 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const published = Date.parse(item.publishedAt || "");
    return Number.isFinite(published) && published >= start && published <= end;
  });
}

export function formatPublishedAtOriginal(value) {
  const raw = String(value || "").trim();
  return Number.isFinite(Date.parse(raw)) ? raw : "time unknown";
}

export function formatArticleForSummary(item) {
  return {
    ...item,
    title: `{${(item.sources || []).join(", ") || "출처 미상"}} ${item.title}`,
    publicationLabel: formatPublishedAtOriginal(item.publishedAt),
  };
}

export function extractArticleText(html, maxChars = MAX_ARTICLE_BODY_CHARS) {
  const $ = load(html);
  $("script, style, noscript, svg, nav, footer, header, aside, form, button, iframe, [aria-hidden='true']").remove();
  const articleText = $("article").text().trim();
  const mainText = $("main, [role='main']").first().text().trim();
  const bodyText = $("body").text().trim();
  const content = [articleText, mainText, bodyText].sort((a, b) => b.length - a.length)[0] || "";
  return content.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export async function readTextLimited(response, maxBytes = MAX_ARTICLE_HTML_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("article_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("article_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function entryLink(entry, baseUrl) {
  const candidate = entry.link;
  let link = typeof candidate === "string" ? candidate : "";
  if (Array.isArray(candidate)) {
    const alternate = candidate.find((item) => item?.["@_rel"] === "alternate") ?? candidate[0];
    link = alternate?.["@_href"] ?? text(alternate);
  } else if (candidate && typeof candidate === "object") {
    link = candidate["@_href"] ?? text(candidate);
  }
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return "";
  }
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

export function validateExternalUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error("invalid_url");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || isPrivateHost(url.hostname)) {
    throw new Error("invalid_url");
  }
  return url;
}

async function fetchFeed(url) {
  let target = validateExternalUrl(url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(target, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1", "User-Agent": "NitM-NewsDigest/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("feed_redirect_error");
      target = validateExternalUrl(new URL(location, target).toString());
      continue;
    }
    if (!response.ok) throw new Error("feed_http_error");
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error("feed_too_large");
    return body;
  }
  throw new Error("feed_redirect_error");
}

async function fetchArticle(url) {
  let target = validateExternalUrl(url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(target, {
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9", "User-Agent": "NitM-NewsDigest/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("article_redirect_error");
      target = validateExternalUrl(new URL(location, target).toString());
      continue;
    }
    if (!response.ok) throw new Error("article_http_error");
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("article_not_html");
    }
    const html = await readTextLimited(response);
    const content = extractArticleText(html);
    if (content.length < 200) throw new Error("article_content_unavailable");
    return content;
  }
  throw new Error("article_redirect_error");
}

async function collect(sources, now = new Date()) {
  const results = await Promise.all(sources.map(async (source) => {
    try {
      const xml = await fetchFeed(source.url);
      const feed = XML.parse(xml);
      const items = entriesOf(feed).map((entry) => {
        const title = plain(entry.title, 300);
        const url = entryLink(entry, source.url);
        if (!title || !/^https?:/.test(url)) return null;

        // [추가] Partner Content / Sponsored 기사 필터링
        if (/\[?\s*(?:partner content|sponsored)\s*\]?/i.test(title)) return null;

        const publishedText = plain(entry.pubDate ?? entry.published ?? entry.updated ?? entry["dc:date"] ?? entry.date ?? "", 100);
        const publishedTime = Date.parse(publishedText);
        if (!Number.isFinite(publishedTime)) return null;
        return {
          title,
          url,
          publishedAt: publishedText.trim(),
          summary: plain(entry.description ?? entry.summary ?? entry.content ?? entry["content:encoded"] ?? ""),
          sources: [source.name],
        };
      }).filter(Boolean);
      return { items, failed: false };
    } catch (error) {
      console.warn("News source collection failed", source.id, error instanceof Error ? error.message : "unknown");
      return { items: [], failed: true };
    }
  }));
  const items = [];
  const byUrl = new Map();
  for (const { items: sourceItems } of results) {
    for (const item of filterRecentArticles(sourceItems, now)) {
      const key = item.url.split("?")[0].replace(/\/$/, "").toLowerCase();
      const existing = byUrl.get(key);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, ...item.sources])];
        continue;
      }
      const unique = { ...item, sources: [...item.sources] };
      byUrl.set(key, unique);
      items.push(unique);
    }
  }
  return { items, failedSources: results.filter((result) => result.failed).length };
}

export function llmSecretsConfigured(env) {
  return [env.LLM_API_KEY, env.LLM_BASE_URL, env.LLM_MODEL]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}

export function configuredModelName(value) {
  return String(value || "미설정").trim().slice(0, 120);
}

export function responseModelNames(models) {
  const names = [...new Set(models.map((model) => String(model || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim()).filter(Boolean))];
  return names.length ? names.join(", ").slice(0, 240) : "응답값 미기록";
}

function redactForLog(value, secrets = [], limit = 300) {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key|pk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function llmEndpoint(raw) {
  const url = validateExternalUrl(raw);
  if (url.protocol !== "https:") throw new Error("invalid_llm_url");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/chat/completions")) {
    if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
    url.pathname += "/chat/completions";
  }
  return url.toString();
}

export function llmBaseUrlIsValid(raw) {
  try {
    llmEndpoint(raw);
    return true;
  } catch {
    return false;
  }
}

export function itemChunks(items, maxChars = LLM_TUNING_FIELDS.llm_batch_chars.default) {
  const chunks = [];
  let chunk = [];
  let chunkChars = 2;
  for (const item of items) {
    const itemChars = JSON.stringify(item).length + 1;
    if (chunk.length && chunkChars + itemChars > maxChars) {
      chunks.push(chunk);
      chunk = [];
      chunkChars = 2;
    }
    chunk.push(item);
    chunkChars += itemChars;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function buildSourceStatsLine(items) {
  const counts = new Map();
  for (const item of items) {
    for (const source of item.sources || ["출처 미상"]) {
      const name = String(source).trim() || "출처 미상";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  if (!counts.size) return "";
  const stats = [...counts.entries()]
    .map(([name, count]) => `{${name}} ${count}건`)
    .join(" · ");
  return `최근 24시간 수집 기사 (총 ${items.length}건): ${stats}`;
}

function insertHeaderStats(markdown, items) {
  const statsLine = buildSourceStatsLine(items);
  if (!statsLine) return markdown;
  const trimmed = markdown.trimStart();
  if (/^#\s+.+/m.test(trimmed)) {
    return trimmed.replace(/^(#\s+.+)$/m, `$1\n\n${statsLine}`);
  }
  return `${statsLine}\n\n${trimmed}`;
}

export function appendSourcesSection(markdown, items) {
  const unique = new Map();
  for (const item of items) {
    const url = String(item.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.split("?")[0].replace(/\/$/, "").toLowerCase();
    const existing = unique.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, ...(item.sources || [])])];
    } else {
      unique.set(key, {
        title: String(item.title || "기사").replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1"),
        publicationLabel: formatPublishedAtOriginal(item.publishedAt),
        url: url.replace(/[()\s]/g, (character) => ({ "(": "%28", ")": "%29", " ": "%20" })[character]),
        sources: [...new Set((item.sources || []).map((source) => String(source).replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1")))],
      });
    }
  }
  const sourceLines = [...unique.values()].map(({ title, publicationLabel, url, sources }) =>
    `- [{${sources.join(", ") || "출처 미상"}} ${title}](${url}) [[published:${publicationLabel}]]`,
  );
  const body = markdown.replace(/^##\s+(?:Sources|출처)\s*$[\s\S]*$/im, "").trimEnd();
  return `${body}\n\n## 뉴스 출처\n\n${sourceLines.join("\n")}\n`;
}

const KOREA_REFERENCE = /(?:대한민국|한국인|한국계|한국|북한|서울|부산|인천|제주|평양|south korea|north korea|korean peninsula|korean|korea|seoul|busan|incheon|jeju|pyongyang|k-pop|samsung|hyundai|kia|lg electronics|sk hynix|naver|kakao|posco|korean air)/i;

export function parseKoreaRelatedIds(content, articles) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("lesson_generation_error");
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("lesson_generation_error");
  }
  if (!Array.isArray(parsed.koreaRelatedArticles)) throw new Error("lesson_generation_error");
  const articleById = new Map(articles.map((article) => [article.id, article]));
  const accepted = [];
  for (const candidate of parsed.koreaRelatedArticles) {
    if (!Number.isInteger(candidate?.id) || typeof candidate.evidence !== "string") continue;
    const article = articleById.get(candidate.id);
    const evidence = candidate.evidence.trim();
    if (!article || evidence.length < 3 || !KOREA_REFERENCE.test(evidence)) continue;
    if (!article.title.toLocaleLowerCase().includes(evidence.toLocaleLowerCase())) continue;
    accepted.push(candidate.id);
  }
  return [...new Set(accepted)];
}

async function generateSummary(env, date, items, tuning = llmTuning()) {
  if (!llmSecretsConfigured(env)) throw new Error("llm_not_configured");
  const promptResponse = await env.ASSETS.fetch(new Request("https://nitm-assets/prompts/news_summary.md"));
  if (!promptResponse.ok) throw new Error("prompt_not_found");
  const promptTemplate = await promptResponse.text();
  const endpoint = llmEndpoint(env.LLM_BASE_URL);
  const responseModels = new Set();
  const requestModel = async (task, batch, { minLength = 20, maxTokens = tuning.maxTokens.summarize, stage = "unknown" } = {}) => {
    const prompt = promptTemplate
      .replace("{{date}}", date)
      .replace("{{task}}", task)
      .replace("{{items}}", JSON.stringify(batch, null, 2));
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: tuning.temperature,
          max_tokens: maxTokens,
          reasoning: reasoningPayload(tuning.reasoningEffort),
        }),
        signal: AbortSignal.timeout(tuning.timeoutMs),
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "unknown";
      console.error("LLM transport failed", errorName);
      throw new Error(errorName === "TimeoutError" ? "llm_timeout" : "llm_connection_error");
    }
    if (!response.ok) {
      console.error("LLM request failed", response.status);
      const errorCode = response.status === 401 || response.status === 403
        ? "llm_auth_error"
        : response.status === 404
          ? "llm_endpoint_not_found"
          : response.status === 429
            ? "llm_rate_limited"
            : response.status >= 500
              ? "llm_provider_error"
              : "lesson_generation_error";
      throw new Error(errorCode);
    }
    let payload;
    let rawBody = "";
    try {
      rawBody = await response.text();
      payload = JSON.parse(rawBody);
    } catch (error) {
      const finalUrl = new URL(response.url || endpoint);
      console.error("LLM invalid JSON response", JSON.stringify({
        status: response.status,
        contentType: response.headers.get("content-type") || "missing",
        endpoint: `${finalUrl.origin}${finalUrl.pathname}`,
        errorName: error instanceof Error ? error.name : "unknown",
        bodyLength: rawBody.length,
        bodyPreview: redactForLog(rawBody, [env.LLM_API_KEY]),
      }));
      throw new Error("llm_invalid_response");
    }
    if (typeof payload.model === "string" && payload.model.trim()) responseModels.add(payload.model.trim().slice(0, 120));
    const choice = payload.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    const content = choice?.message?.content;
    if (finishReason === "length") {
      console.error("LLM output truncated", JSON.stringify({
        stage,
        requestedModel: env.LLM_MODEL,
        responseModel: payload.model ?? null,
        provider: payload.provider ?? null,
        maxTokens,
        finishReason,
        nativeFinishReason: choice?.native_finish_reason ?? null,
        usage: payload.usage ?? null,
        contentLength: typeof content === "string" ? content.length : 0,
      }));
      throw new Error("llm_output_truncated");
    }
    if (typeof content !== "string" || content.trim().length < minLength) {
      console.error("LLM empty or short content", JSON.stringify({
        stage,
        requestedModel: env.LLM_MODEL,
        responseModel: payload.model ?? null,
        provider: payload.provider ?? null,
        finishReason,
        usage: payload.usage ?? null,
        contentLength: typeof content === "string" ? content.length : 0,
      }));
      throw new Error("lesson_generation_error");
    }
    return { content: content.trim() };
  };

  // 출력이 max_tokens에서 잘리면 배치를 반으로 나눠 재시도한다. 결과 노트는 입력 순서대로 이어 붙인다.
  const requestWithSplit = async (buildTask, batch, options, depth = 0) => {
    try {
      return (await requestModel(buildTask(), batch, options)).content;
    } catch (error) {
      const truncated = error instanceof Error && error.message === "llm_output_truncated";
      if (!truncated || batch.length < 2 || depth >= tuning.maxSplitDepth) throw error;
      console.warn("LLM output truncated; splitting batch", JSON.stringify({ stage: options.stage, size: batch.length, depth }));
      const middle = Math.ceil(batch.length / 2);
      const first = await requestWithSplit(buildTask, batch.slice(0, middle), options, depth + 1);
      const second = await requestWithSplit(buildTask, batch.slice(middle), options, depth + 1);
      return `${first}\n\n${second}`;
    }
  };

  const classifierInputs = items.map((item, index) => ({
    id: index + 1,
    title: item.title,
    publishedAt: item.publishedAt,
    summary: item.summary,
  }));
  const koreaRelatedIds = new Set();
  for (const batch of itemChunks(classifierInputs, tuning.batchChars)) {
    const result = await requestModel(
      "Classify conservatively. Mark a story as Korea-related only when its main event or subject is South Korea, North Korea, a Korean person, or a Korean government, company, institution, culture, or society. Exclude passing background mentions, comparisons, one-sentence references, and speculative market effects. For every selected story, provide a short exact evidence quote copied from its title; the quote itself must contain a clear Korea identifier such as Korea/Korean/Seoul/Samsung. Exclude a story if Korea is mentioned only in its summary and not in its title. Return only one JSON object with this schema: {\"koreaRelatedArticles\":[{\"id\":1,\"evidence\":\"South Korea\"}]}. Return an empty array when none qualify. Do not add any explanation outside the JSON.",
      batch,
      { minLength: 2, maxTokens: tuning.maxTokens.classify, stage: "classify" },
    );
    for (const id of parseKoreaRelatedIds(result.content, batch)) koreaRelatedIds.add(id);
  }

  const koreaItems = items.filter((_item, index) => koreaRelatedIds.has(index + 1));
  for (let offset = 0; offset < koreaItems.length; offset += 4) {
    const batch = koreaItems.slice(offset, offset + 4);
    const contents = await Promise.all(batch.map(async (item) => {
      try {
        return await fetchArticle(item.url);
      } catch (error) {
        console.warn("Korea-related article body unavailable", error instanceof Error ? error.message : "unknown");
        return "";
      }
    }));
    for (let index = 0; index < batch.length; index += 1) {
      if (contents[index]) batch[index].articleContent = contents[index];
    }
  }

  const chunks = itemChunks(items.map((item) => {
    const formatted = formatArticleForSummary(item);
    return { ...formatted, title: `${formatted.title} [[published:${formatted.publicationLabel}]]` };
  }), tuning.batchChars);
  const partials = [];
  for (const [index, chunk] of chunks.entries()) {
    const notes = await requestWithSplit(
      () => `Summarize every story in this batch in Korean in one or two sentences each. Each input title begins with its source in braces and ends with an exact [[published:...]] timestamp marker. Keep both exactly and use the full title line as the heading. Do not convert timezones. Do not combine or omit stories in this stage. Preserve the timestamp and confirmed key facts. Do not write an introduction or source list. Batch ${index + 1} of ${chunks.length}.`,
      chunk,
      { maxTokens: tuning.maxTokens.summarize, stage: "summarize" },
    );
    partials.push({ batch: index + 1, notes });
  }

  let synthesisInputs = partials;
  while (JSON.stringify(synthesisInputs).length > tuning.batchChars) {
    const reduced = [];
    for (const [index, chunk] of itemChunks(synthesisInputs, tuning.batchChars).entries()) {
      const notes = await requestWithSplit(
        () => "Compress the supplied Korean story notes while preserving every story, its exact {source} title prefix, and every [[published:...]] timestamp marker unchanged. Do not convert timezones or add new facts. Do not write a source list.",
        chunk,
        { maxTokens: tuning.maxTokens.compress, stage: "compress" },
      );
      reduced.push({ batch: index + 1, notes });
    }
    synthesisInputs = reduced;
  }

  const final = await requestModel(
    "Write a complete Korean-language news briefing that covers every supplied story note. Merge stories covering the same topic/event into one concise summary. For each topic group, format its heading strictly as `{source names} Korean topic headline [[published:timestamp]]` with nothing before `{` (e.g., `### {FT} 엔비디아 사태 후폭풍 [[published:...]]`). Combine source names in braces separated by commas. When merging multiple stories, keep ONLY the single earliest (oldest) `[[published:...]]` timestamp marker and discard the rest. Do not convert timestamps to another timezone. If any stories are directly related to Korea, put them in the first section immediately after the main title, then organize other international news by topic. Do not create a Korea section if none qualify. Preserve each story's distinct confirmed facts. Use one concise H1 title and clear section headings. Do not create a sources section; the system will append the verified source links.",
    synthesisInputs,
    { maxTokens: tuning.maxTokens.final, stage: "final" },
  );
  const withStats = insertHeaderStats(final.content, items);
  const markdown = appendSourcesSection(withStats, items);
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim().slice(0, 180) || `뉴스 브리핑 · ${date}`;
  return {
    title,
    markdown,
    model: configuredModelName(env.LLM_MODEL),
    requestedModel: configuredModelName(env.LLM_MODEL),
    responseModel: responseModelNames([...responseModels]),
  };
}

export async function sendTestDigest(env, recipient) {
  const values = await env.DB.prepare("SELECT key, value FROM settings").all();
  const config = Object.fromEntries(values.results.map(({ key, value }) => [key, value]));
  const sources = await env.DB.prepare("SELECT id, name, url FROM sources WHERE enabled=1 ORDER BY sort_order, name").all();
  const { items } = await collect(sources.results);
  if (!items.length) throw new Error("no_news");
  const { date } = dateTimeInZone(new Date(), config.timezone || "UTC");
  const lesson = await generateSummary(env, date, items, llmTuning(config));
  await sendEmail(env, {
    to: recipient,
    subject: `[테스트] NitM | ${lesson.title}`,
    markdown: lesson.markdown,
    requestedModel: lesson.requestedModel,
    responseModel: lesson.responseModel,
  });
}

async function recordRun(env, date, status, counts, errorCode, startedAt) {
  await env.DB.prepare(
    "INSERT INTO runs (date, status, counts_json, error_code, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(date, status, JSON.stringify(counts), errorCode, startedAt, isoNow()).run();
}

export async function runDigest(env, { manual = false, now = new Date() } = {}) {
  const settingsRows = await env.DB.prepare("SELECT key, value FROM settings").all();
  const settings = Object.fromEntries(settingsRows.results.map(({ key, value }) => [key, value]));
  const { date } = dateTimeInZone(now, settings.timezone || "UTC");
  const startedAt = isoNow();
  const lock = manual
    ? await env.DB.prepare("INSERT INTO digest_locks (date, status, started_at) VALUES (?, 'processing', ?) ON CONFLICT(date) DO UPDATE SET status='processing', started_at=excluded.started_at, finished_at=NULL WHERE digest_locks.status='failed'").bind(date, startedAt).run()
    : await env.DB.prepare("INSERT INTO digest_locks (date, status, started_at) VALUES (?, 'processing', ?) ON CONFLICT(date) DO UPDATE SET status='processing', started_at=excluded.started_at, finished_at=NULL WHERE digest_locks.status='failed'").bind(date, startedAt).run();
  if (!lock.meta.changes) return { date, status: "already_processed" };

  const counts = { eligible: 0, collected: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    const users = await env.DB.prepare("SELECT id, email FROM users WHERE subscribed=1 ORDER BY email").all();
    counts.eligible = users.results.length;
    if (users.results.length === 0) {
      counts.skipped = 1;
      await recordRun(env, date, "skipped", counts, "no_subscribers", startedAt);
      await env.DB.prepare("UPDATE digest_locks SET status='failed', finished_at=? WHERE date=?").bind(isoNow(), date).run();
      return { date, status: "skipped", counts };
    }

    let lesson = await env.DB.prepare("SELECT title, markdown, sources_json, model, requested_model, response_model FROM lessons WHERE date=?").bind(date).first();
    if (!lesson) {
      const sourceResult = await env.DB.prepare("SELECT id, name, url FROM sources WHERE enabled=1 ORDER BY sort_order, name").all();
      const { items, failedSources } = await collect(sourceResult.results);
      counts.collected = items.length;
      if (!items.length) throw new Error("no_news");
      const generated = await generateSummary(env, date, items, llmTuning(settings));
      lesson = { ...generated, sources_json: JSON.stringify({ items, failedSources }) };
      await env.DB.prepare(`INSERT INTO lessons (date, title, markdown, sources_json, model, requested_model, response_model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(date, lesson.title, lesson.markdown, lesson.sources_json, lesson.model, lesson.requestedModel, lesson.responseModel, isoNow()).run();
    }

    const subject = `NitM | ${lesson.title}`.slice(0, 250);
    const requestedModel = lesson.requested_model || lesson.model || configuredModelName(env.LLM_MODEL);
    const responseModel = lesson.response_model || "기존 lesson: 응답 모델 기록 없음";
    for (const user of users.results) {
      const existing = await env.DB.prepare("SELECT status FROM deliveries WHERE date=? AND user_id=?").bind(date, user.id).first();
      if (existing?.status === "sent") {
        counts.skipped += 1;
        continue;
      }
      try {
        await sendEmail(env, { to: user.email, subject, markdown: lesson.markdown, requestedModel, responseModel });
        await env.DB.prepare(`INSERT INTO deliveries (date, user_id, recipient_email, status, error_code, subject, body, attempted_at, sent_at)
          VALUES (?, ?, ?, 'sent', NULL, ?, ?, ?, ?)
          ON CONFLICT(date, user_id) DO UPDATE SET status='sent', error_code=NULL, subject=excluded.subject, body=excluded.body, attempted_at=excluded.attempted_at, sent_at=excluded.sent_at`)
          .bind(date, user.id, user.email, subject, lesson.markdown, isoNow(), isoNow()).run();
        counts.sent += 1;
      } catch {
        await env.DB.prepare(`INSERT INTO deliveries (date, user_id, recipient_email, status, error_code, subject, body, attempted_at, sent_at)
          VALUES (?, ?, ?, 'failed', 'email_error', ?, ?, ?, NULL)
          ON CONFLICT(date, user_id) DO UPDATE SET status='failed', error_code='email_error', subject=excluded.subject, body=excluded.body, attempted_at=excluded.attempted_at`)
          .bind(date, user.id, user.email, subject, lesson.markdown, isoNow()).run();
        counts.failed += 1;
      }
    }
    const status = counts.failed ? "partial" : "sent";
    await recordRun(env, date, status, counts, counts.failed ? "email_error" : null, startedAt);
    await env.DB.prepare("UPDATE digest_locks SET status=?, finished_at=? WHERE date=?").bind(counts.failed ? "failed" : "sent", isoNow(), date).run();
    return { date, status, counts };
  } catch (error) {
    const code = error instanceof Error && ["no_news", "llm_not_configured", "lesson_generation_error", "llm_output_truncated"].includes(error.message)
      ? error.message
      : "digest_error";
    console.error("Digest run failed", code);
    await recordRun(env, date, "failed", counts, code, startedAt);
    await env.DB.prepare("UPDATE digest_locks SET status='failed', finished_at=? WHERE date=?").bind(isoNow(), date).run();
    return { date, status: "failed", errorCode: code, counts };
  }
}

export async function scheduledDigest(env, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  const today = now.toISOString().slice(0, 10);
  const cleanup = await env.DB.prepare("UPDATE settings SET value=?, updated_at=? WHERE key='last_cleanup_date' AND value<>?")
    .bind(today, isoNow(), today).run();
  if (cleanup.meta.changes) {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM lessons WHERE date < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM deliveries WHERE date < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM runs WHERE date < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM digest_locks WHERE date < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()),
      env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now.toISOString()),
    ]);
  }

  const config = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('timezone', 'send_time')").all();
  const values = Object.fromEntries(config.results.map(({ key, value }) => [key, value]));
  const local = dateTimeInZone(now, values.timezone || "UTC");
  if (local.time !== (values.send_time || "06:00")) return { status: "not_scheduled" };
  return runDigest(env, { now });
}