import assert from "node:assert/strict";
import test from "node:test";
import { appendSourcesSection, configuredModelName, dateTimeInZone, extractArticleText, filterRecentArticles, formatArticleForSummary, formatPublishedAtOriginal, itemChunks, llmBaseUrlIsValid, llmSecretsConfigured, parseKoreaRelatedIds, readTextLimited, responseModelNames, validateExternalUrl } from "../src/digest.js";
import { emailFooterHtml, emailFooterText, markdownToEmailHtml, sendEmail } from "../src/mailer.js";

test("scheduled date and time use the configured timezone", () => {
  assert.deepEqual(dateTimeInZone(new Date("2026-11-10T06:00:00.000Z"), "UTC"), {
    date: "2026-11-10",
    time: "06:00",
  });
  assert.deepEqual(dateTimeInZone(new Date("2026-11-10T06:00:00.000Z"), "Europe/Brussels"), {
    date: "2026-11-10",
    time: "07:00",
  });
});

test("external feed URLs reject local hosts and embedded credentials", () => {
  assert.equal(validateExternalUrl("https://feeds.example.org/rss.xml").hostname, "feeds.example.org");
  assert.throws(() => validateExternalUrl("http://127.0.0.1/feed"), /invalid_url/);
  assert.throws(() => validateExternalUrl("https://user:pass@example.org/rss"), /invalid_url/);
});

test("LLM is configured only when all three Cloudflare secret bindings exist", () => {
  assert.equal(llmSecretsConfigured({ LLM_API_KEY: "key", LLM_BASE_URL: "https://llm.example/v1" }), false);
  assert.equal(llmSecretsConfigured({ LLM_API_KEY: "key", LLM_MODEL: "model" }), false);
  assert.equal(llmSecretsConfigured({ LLM_BASE_URL: "https://llm.example/v1", LLM_MODEL: "model" }), false);
  assert.equal(llmSecretsConfigured({ LLM_API_KEY: "key", LLM_BASE_URL: "https://llm.example/v1", LLM_MODEL: "model" }), true);
});

test("LLM Base URL secret validation accepts HTTPS public endpoints only", () => {
  assert.equal(llmBaseUrlIsValid("https://api.provider.example/v1"), true);
  assert.equal(llmBaseUrlIsValid("https://api.provider.example/v1/chat/completions"), true);
  assert.equal(llmBaseUrlIsValid("http://api.provider.example/v1"), false);
  assert.equal(llmBaseUrlIsValid("not a url"), false);
  assert.equal(llmBaseUrlIsValid("http://127.0.0.1:8000/v1"), false);
});

test("reported model metadata uses the configured secret value", () => {
  assert.equal(configuredModelName("new-model-alias"), "new-model-alias");
  assert.equal(configuredModelName("  new-model-alias  "), "new-model-alias");
  assert.equal(configuredModelName(""), "미설정");
});

test("provider response model metadata keeps distinct returned model names", () => {
  assert.equal(responseModelNames(["solar-pro4-260806", "solar-pro4-260806", "solar-pro4-260806"]), "solar-pro4-260806");
  assert.equal(responseModelNames(["classifier-model", "summary-model"]), "classifier-model, summary-model");
  assert.equal(responseModelNames([]), "응답값 미기록");
});

test("article publication labels preserve original timezone without conversion", () => {
  assert.equal(formatPublishedAtOriginal("2026-11-14T01:05:00+00:00"), "2026-11-14T01:05:00+00:00");
  assert.equal(formatPublishedAtOriginal("Sat, 14 Nov 2026 10:05:00 +0900"), "Sat, 14 Nov 2026 10:05:00 +0900");
  assert.equal(formatPublishedAtOriginal("2026-11-14T10:05:00Z"), "2026-11-14T10:05:00Z");
  assert.equal(formatPublishedAtOriginal("invalid"), "time unknown");
  assert.deepEqual(
    (({ title, publicationLabel }) => ({ title, publicationLabel }))(formatArticleForSummary({
      title: "Headline",
      publishedAt: "2026-11-14T01:05:00+00:00",
      sources: ["Source A"],
    })),
    { title: "{Source A} Headline", publicationLabel: "2026-11-14T01:05:00+00:00" },
  );
});

test("Korea-related classifier requires exact Korea evidence in the article title", () => {
  const articles = [
    { id: 1, title: "South Korea announces new policy", summary: "Details follow." },
    { id: 2, title: "Japan election outlook", summary: "Analysts compare effects on South Korea." },
    { id: 3, title: "Samsung expands chip plant", summary: "The company announced its plans." },
  ];
  const response = JSON.stringify({ koreaRelatedArticles: [
    { id: 1, evidence: "South Korea" },
    { id: 2, evidence: "South Korea" },
    { id: 3, evidence: "Samsung" },
    { id: 99, evidence: "Korea" },
  ] });

  assert.deepEqual(parseKoreaRelatedIds(response, articles), [1, 3]);
  assert.throws(() => parseKoreaRelatedIds("not json", articles));
});

test("article text extraction removes navigation and scripts", () => {
  const html = `<html><body><nav>Menu</nav><article><h1>Headline</h1><p>${"Article details ".repeat(20)}</p><script>secret()</script></article><footer>Footer</footer></body></html>`;
  const article = extractArticleText(html);

  assert.match(article, /Headline/);
  assert.match(article, /Article details/);
  assert.doesNotMatch(article, /Menu|Footer|secret/);
});

test("article HTML response reader enforces its byte limit", async () => {
  const response = new Response("<article>ok</article>");
  assert.equal(await readTextLimited(response, 100), "<article>ok</article>");
  await assert.rejects(readTextLimited(new Response("x".repeat(20)), 10), /article_too_large/);
});

test("recent article filter keeps only dated entries from the last 24 hours", () => {
  const now = new Date("2026-11-14T12:00:00.000Z");
  const items = [
    { title: "At cutoff", publishedAt: "2026-11-13T12:00:00.000Z" },
    { title: "Recent", publishedAt: "2026-11-14T11:59:59.000Z" },
    { title: "Old", publishedAt: "2026-11-13T11:59:59.000Z" },
    { title: "Future", publishedAt: "2026-11-14T12:00:01.000Z" },
    { title: "Missing date", publishedAt: "" },
  ];

  assert.deepEqual(filterRecentArticles(items, now).map((item) => item.title), ["At cutoff", "Recent"]);
});

test("large article inputs are chunked without dropping any item", () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    title: `Article ${index}`,
    summary: "x".repeat(500),
  }));
  const chunks = itemChunks(items, 5_000);

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((item) => item.title), items.map((item) => item.title));
  assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length <= 5_000));
});

test("source section is generated from exact collected article URLs and source names", () => {
  const markdown = appendSourcesSection("# 한국어 브리핑\n\n본문", [
    { title: "News [one]", url: "https://news.example/story?id=1", publishedAt: "2026-11-14T01:05:00+00:00", sources: ["Source A"] },
    { title: "Second story", url: "https://wire.example/item(2)", sources: ["Source B"] },
  ]);

  assert.match(markdown, /## 뉴스 출처/);
  assert.ok(markdown.includes("[{Source A} News \\[one\\]](https://news.example/story?id=1) [[published:2026-11-14T01:05:00+00:00]]"));
  assert.ok(markdown.includes("{Source A} News"));
  assert.ok(markdown.includes("https://wire.example/item%282%29"));
});

test("email Markdown renderer escapes untrusted HTML", () => {
  const html = markdownToEmailHtml("# Briefing\n\n## {BBC} Headline [[published:11.14 10:05 +0900]]\n\n<script>alert(1)</script>\n\n[Story](https://news.example/story)");

  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/news\.example\/story"/);
  assert.match(html, /<small style="font-size:12px;color:#65736b;font-weight:400">11\.14 10:05 \+0900<\/small>/);
});

test("email renders source badges and earliest publication in original local time", () => {
  const html = markdownToEmailHtml("## {Politico, FT, Euractiv, BBC} Headline [[published:2026-11-14T09:00:00+09:00; 2026-11-14T01:00:00+00:00]] [[published:Fri, 13 Nov 2026 23:30:00 GMT]] after\n\n- [{FT} Story](https://news.example/story) [[published:2026-11-14T10:05:00Z]]");
  assert.match(html, /background-color:#E60000;color:#ffffff">P<\/span>/);
  assert.match(html, /background-color:#FFF1E5;color:#202020">F<\/span>/);
  assert.match(html, /background-color:#005596;color:#ffffff">E<\/span>/);
  assert.match(html, /\{BBC\}/);
  assert.match(html, /26\/11\/13 23:30/);
  assert.match(html, /23:30<\/small>\s+after/);
  assert.doesNotMatch(html, /26\/11\/14 09:00|26\/11\/14 01:00/);
  assert.match(html, /href="https:\/\/news\.example\/story"><span title="Financial Times"/);
  assert.match(html, /26\/11\/14 10:05/);
});

test("legacy dates do not receive an invented year and source badges never alter links", () => {
  const html = markdownToEmailHtml("## {FT} Old [[published:11.14 10:05 +0900; 11.13 23:00 GMT]]\n\n[Story](https://news.example/[{FT}])");
  assert.match(html, /11\.14 10:05 \+0900/);
  assert.match(html, /11\.13 23:00 GMT/);
  assert.match(html, /href="https:\/\/news\.example\/\[\{FT\}\]"/);
});

test("configured Politico EU and Euractive source names use their badges", () => {
  const html = markdownToEmailHtml("## {Politico EU, Euractive} Headline");
  assert.match(html, /background-color:#E60000;color:#ffffff">P<\/span>/);
  assert.match(html, /background-color:#005596;color:#ffffff">E<\/span>/);
});

test("plain text email includes source initials and one earliest publication date", async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ id: "test" });
  };
  try {
    await sendEmail({ RESEND_API_KEY: "test", ASSETS: { fetch: async () => new Response("1.0.1") } }, {
      to: "reader@example.com",
      subject: "Test",
      markdown: "## {FT, Politico} Headline [[published:2026-11-14T01:00:00Z; 2026-11-14T09:00:00+09:00]]\n\n- [{Euractiv} Story](https://news.example/story)",
    });
    assert.match(sent.text, /## \[F\] \[P\] Headline 26\/11\/14 09:00/);
    assert.match(sent.text, /\[\[E\] Story\]\(https:\/\/news\.example\/story\)/);
    assert.doesNotMatch(sent.text, /\[\[published:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("email footer includes the centralized version and LLM model", () => {
  const footer = emailFooterText("2.4.1", "solar-pro4", "solar-pro4-260806");
  assert.match(footer, /NitM v2\.4\.1/);
  assert.match(footer, /요청 모델: solar-pro4/);
  assert.match(footer, /응답 모델: solar-pro4-260806/);
  assert.match(emailFooterHtml("2.4.1", "solar-pro4", "solar-pro4-260806"), /요청 모델: solar-pro4 · 응답 모델: solar-pro4-260806/);
  assert.doesNotMatch(emailFooterHtml("2.4.1", "solar-pro4", "<script>"), /<script>/);
  assert.match(markdownToEmailHtml("# Briefing"), /<h1>Briefing<\/h1>/);
});
test("LLM tuning falls back to defaults and validates admin input", async () => {
  const { llmTuning, llmTuningSettings, validateLlmTuningInput, reasoningPayload } = await import("../src/digest.js");
  const defaults = llmTuning({});
  assert.equal(defaults.maxTokens.summarize, 12_000);
  assert.equal(defaults.reasoningEffort, "low");
  assert.equal(defaults.timeoutMs, 240_000);
  const custom = llmTuning({ llm_max_tokens_summarize: "20000", llm_reasoning_effort: "disabled", llm_timeout_seconds: "abc" });
  assert.equal(custom.maxTokens.summarize, 20_000);
  assert.equal(custom.timeoutMs, 240_000);
  assert.deepEqual(reasoningPayload(custom.reasoningEffort), { enabled: false });
  assert.equal(reasoningPayload("omit"), undefined);
  assert.equal(llmTuningSettings({ llm_batch_chars: "999999999" }).llm_batch_chars, 14_000);
  assert.deepEqual(validateLlmTuningInput({ llm_max_tokens_final: "9000", timezone: "UTC" }), { llm_max_tokens_final: "9000" });
  assert.throws(() => validateLlmTuningInput({ llm_max_split_depth: "1.5" }), /invalid_llm_tuning/);
  assert.throws(() => validateLlmTuningInput({ llm_reasoning_effort: "extreme" }), /invalid_llm_tuning/);
});
