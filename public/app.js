const app = document.querySelector("#app");
const state = { user: null, view: "settings", notice: "", authError: "" };
const API_ERRORS = {
  no_news: "활성 뉴스 미디어에서 기사를 수집하지 못했습니다. RSS 주소와 소스 상태를 확인해 주세요.",
  llm_not_configured: "관리자 설정에서 OpenAI 호환 API Base URL과 모델을 저장하고, LLM_API_KEY secret을 등록해 주세요.",
  invalid_llm_url: "LLM_BASE_URL secret 형식이 올바르지 않습니다. https://로 시작하는 OpenAI 호환 Base URL을 설정해 주세요.",
  llm_connection_error: "LLM endpoint에 연결하지 못했습니다. LLM_BASE_URL secret의 주소와 provider 상태를 확인해 주세요.",
  llm_timeout: "LLM 요청 시간이 초과됐습니다. 잠시 후 다시 시도하거나 뉴스 입력량을 확인해 주세요.",
  llm_invalid_response: "LLM 응답이 JSON 형식이 아닙니다. Base URL과 provider 호환성을 확인해 주세요.",
  llm_auth_error: "LLM provider가 인증을 거부했습니다. LLM_API_KEY secret이 올바른지 확인해 주세요.",
  llm_endpoint_not_found: "LLM endpoint를 찾을 수 없습니다. LLM_BASE_URL secret의 API 경로를 확인해 주세요.",
  llm_rate_limited: "LLM provider 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
  llm_provider_error: "LLM provider에서 오류를 반환했습니다. 잠시 후 다시 시도해 주세요.",
  lesson_generation_error: "LLM 요약 생성에 실패했습니다. API URL, 모델, API key와 제공자 사용량을 확인해 주세요.",
  mail_not_configured: "RESEND_API_KEY secret이 설정되지 않았습니다.",
  email_error: "Resend 메일 전송에 실패했습니다. API key와 발신 주소 설정을 확인해 주세요.",
  test_email_failed: "테스트 메일 처리 중 오류가 발생했습니다. Worker 로그를 확인해 주세요.",
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(API_ERRORS[data.error] || data.error || `request_failed_${response.status}`);
  return data;
}

function setNotice(text, error = false) {
  state.notice = text;
  const notice = document.querySelector("#notice");
  if (notice) {
    notice.textContent = text;
    notice.className = `notice${error ? " error" : ""}`;
    notice.hidden = !text;
  }
}

function topbar() {
  const actions = state.user ? `<div class="top-actions"><span class="identity">${escapeHtml(state.user.name || state.user.email)}<br>${escapeHtml(state.user.email)}</span><button class="button small" data-action="logout">로그아웃</button></div>` : "";
  return `<header class="topbar"><a class="brand" href="/" aria-label="NitM 홈"><span class="brand-mark">N</span><span>NitM<small>News in the Morning</small></span></a>${actions}</header>`;
}

function loginView() {
  const params = new URLSearchParams(location.search);
  const message = params.get("auth") === "not-invited"
    ? "이 Google 계정은 아직 초대되지 않았습니다. 관리자에게 초대를 요청해 주세요."
    : params.get("auth") === "failed" ? "Google 로그인에 실패했습니다. 다시 시도해 주세요." : "초대된 Google 계정으로 로그인할 수 있습니다.";
  app.innerHTML = `${topbar()}<main class="login-wrap"><section class="login-copy"><span class="eyebrow">A clearer start to the day</span><h1>오늘 아침의 뉴스,<br>한 통으로.</h1><p>등록된 미디어의 주요 소식을 모아 매일 아침 이메일로 전합니다. 내 수신 설정과 지난 브리핑을 한곳에서 관리하세요.</p><div class="panel" style="max-width:440px"><p id="login-message" class="muted">${escapeHtml(message)}</p><a class="button primary" href="/auth/google">Google로 로그인</a></div><p class="footer-note">초대받은 Google 계정만 이용할 수 있습니다.</p></section><aside class="login-art" aria-label="아침 뉴스 브리핑 표지 그래픽"><div class="paper-stack"><div class="paper-lines"><i></i><i></i><i></i><i></i><i></i><i></i></div></div><p>세계의 흐름을<br>차분하게 읽는 아침.</p></aside></main>`;
}

function shell(content) {
  const tabs = [["settings", "수신 설정"], ["history", "메일 내역"]];
  if (state.user.isAdmin) tabs.push(["admin", "관리자"]);
  app.innerHTML = `${topbar()}<main class="shell"><nav class="nav">${tabs.map(([key, label]) => `<button data-view="${key}" class="${state.view === key ? "active" : ""}">${label}</button>`).join("")}</nav><div id="notice" class="notice" role="status" hidden></div><div id="view">${content}</div></main>`;
  if (state.notice) setNotice(state.notice);
}

async function renderSettings() {
  const [settings, history] = await Promise.all([request("/api/settings"), request("/api/history")]);
  const recent = history.deliveries.slice(0, 5);
  shell(`<div class="page-head"><div><span class="eyebrow">Your inbox</span><h1>수신 설정</h1><p>뉴스 브리핑 수신 여부를 관리하고 최근 발송을 확인합니다.</p></div></div><section class="split"><div class="panel"><div class="section-heading"><h2>메일 구독</h2><span class="status ${settings.subscribed ? "" : "off"}">${settings.subscribed ? "수신 중" : "중지됨"}</span></div><label class="switch-line"><span><strong>매일 브리핑 받기</strong><span>수신을 끄면 다음 발송부터 메일이 오지 않습니다.</span></span><input id="subscription-toggle" class="switch" type="checkbox" ${settings.subscribed ? "checked" : ""} aria-label="매일 브리핑 받기"></label><p class="muted" style="margin:14px 0 0">수신 주소: <strong>${escapeHtml(state.user.email)}</strong></p></div><div class="panel"><span class="eyebrow">Account</span><h2 style="margin:8px 0">${escapeHtml(state.user.name || "NitM 사용자")}</h2><p class="muted">Google 계정으로 로그인되어 있습니다.</p><button class="button" data-action="logout">로그아웃</button></div></section><section class="section"><div class="section-heading"><h2>최근 메일</h2><button class="button small" data-view="history">전체 내역</button></div>${deliveryTable(recent, false)}</section>`);
  document.querySelector("#subscription-toggle")?.addEventListener("change", async (event) => {
    try {
      await request("/api/settings", { method: "PUT", body: JSON.stringify({ subscribed: event.target.checked }) });
      setNotice(event.target.checked ? "메일 수신을 시작했습니다." : "메일 수신을 중지했습니다.");
    } catch (error) {
      event.target.checked = !event.target.checked;
      setNotice(error.message, true);
    }
  });
}

function deliveryTable(rows, showRecipient) {
  if (!rows.length) return `<div class="panel empty">아직 메일 발송 내역이 없습니다.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>날짜</th>${showRecipient ? "<th>수신자</th>" : ""}<th>제목</th><th>상태</th><th>발송 시각</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.date)}</td>${showRecipient ? `<td>${escapeHtml(row.recipient_email)}</td>` : ""}<td>${escapeHtml(row.subject)}</td><td><span class="status ${row.status === "failed" ? "failed" : row.status === "skipped" ? "pending" : ""}">${row.status === "sent" ? "전송 완료" : row.status === "failed" ? "실패" : "건너뜀"}</span></td><td>${escapeHtml(row.sent_at || row.attempted_at || "-")}</td><td><button class="button small" ${showRecipient ? `data-delivery="${Number(row.id)}"` : `data-history="${escapeHtml(row.date)}"`}>내용</button></td></tr>`).join("")}</tbody></table></div>`;
}

async function showMessage(date, admin = false) {
  try {
    const data = admin ? await request(`/api/admin/lessons/${encodeURIComponent(date)}`) : await request(`/api/history/${encodeURIComponent(date)}`);
    const body = admin ? data.lesson.markdown : data.delivery.body;
    const title = admin ? data.lesson.title : data.delivery.subject;
    const dialog = document.createElement("dialog");
    dialog.className = "message-dialog";
    dialog.innerHTML = `<form method="dialog" class="panel"><div class="section-heading"><div><span class="eyebrow">${escapeHtml(date)}</span><h2>${escapeHtml(title)}</h2></div><button class="button small" aria-label="닫기">닫기</button></div><pre class="digest-body"></pre></form>`;
    dialog.querySelector("pre").textContent = body;
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function showDelivery(id) {
  try {
    const { delivery } = await request(`/api/admin/deliveries/${encodeURIComponent(id)}`);
    const dialog = document.createElement("dialog");
    dialog.className = "message-dialog";
    dialog.innerHTML = `<form method="dialog" class="panel"><div class="section-heading"><div><span class="eyebrow">${escapeHtml(delivery.date)} · ${escapeHtml(delivery.recipient_email)}</span><h2>${escapeHtml(delivery.subject)}</h2></div><button class="button small" aria-label="닫기">닫기</button></div><pre class="digest-body"></pre></form>`;
    dialog.querySelector("pre").textContent = delivery.body;
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  } catch (error) { setNotice(error.message, true); }
}

async function renderHistory() {
  const { deliveries } = await request("/api/history");
  shell(`<div class="page-head"><div><span class="eyebrow">Archive</span><h1>메일 내역</h1><p>최근 100건의 발송 결과와 메일 본문입니다.</p></div></div>${deliveryTable(deliveries, false)}`);
}

async function renderAdmin() {
  const [overview, settings, sources] = await Promise.all([
    request("/api/admin/overview"), request("/api/admin/settings"), request("/api/admin/sources"),
  ]);
  const users = overview.users.map((user) => `<tr><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.name || "-")}</td><td><span class="status ${user.subscribed ? "" : "off"}">${user.subscribed ? "수신 중" : "중지"}</span></td><td><button class="button small" data-user="${escapeHtml(user.id)}" data-subscribed="${!user.subscribed}">${user.subscribed ? "수신 중지" : "수신 재개"}</button></td></tr>`).join("");
  const invites = overview.invites.map((invite) => `<tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.note)}</td><td>${invite.email_sent_at ? "초대 메일 발송" : "메일 미발송"}</td><td>${escapeHtml(invite.created_at)}</td><td><button class="button small danger" data-remove-invite="${escapeHtml(invite.email)}">삭제</button></td></tr>`).join("");
  const sourceRows = sources.sources.map((source) => `<tr data-source-row="${escapeHtml(source.id)}"><td>${escapeHtml(source.id)}</td><td><input data-field="name" type="text" value="${escapeHtml(source.name)}" aria-label="미디어 이름"></td><td><input data-field="url" type="url" value="${escapeHtml(source.url)}" aria-label="RSS URL"></td><td><input data-field="order" type="number" min="0" value="${Number(source.order)}" aria-label="정렬 순서" style="width:75px"></td><td><input data-field="enabled" type="checkbox" ${source.enabled ? "checked" : ""} aria-label="활성"></td><td><button class="button small" data-save-source="${escapeHtml(source.id)}">저장</button> <button class="button small danger" data-delete-source="${escapeHtml(source.id)}">삭제</button></td></tr>`).join("");
  const deliveryRows = overview.deliveries;
  const runRows = overview.runs.map((run) => {
    let counts = {};
    try { counts = JSON.parse(run.counts_json || "{}"); } catch { counts = {}; }
    return `<tr><td>${escapeHtml(run.date)}</td><td>${escapeHtml(run.status)}</td><td>${Object.entries(counts).map(([key, value]) => `${escapeHtml(key)} ${Number(value)}`).join(" · ") || "-"}</td><td>${escapeHtml(run.error_code || "-")}</td><td>${escapeHtml(run.finished_at || run.started_at)}</td></tr>`;
  }).join("");
  const lessonRows = overview.lessons.map((lesson) => `<tr><td>${escapeHtml(lesson.date)}</td><td>${escapeHtml(lesson.title)}</td><td>${escapeHtml(lesson.created_at)}</td><td><button class="button small" data-lesson="${escapeHtml(lesson.date)}">원문</button></td></tr>`).join("");

  shell(`<div class="page-head"><div><span class="eyebrow">Operations</span><h1>관리자</h1><p>초대, 뉴스 소스, 발송 일정과 결과를 관리합니다.</p></div><div class="actions" style="margin:0"><button class="button" data-action="test-email">테스트 메일</button><button class="button primary" data-action="run">지금 발송</button></div></div><div class="metric-row"><div class="metric"><span>등록 사용자</span><strong>${overview.users.length}</strong></div><div class="metric"><span>대기 초대</span><strong>${overview.invites.filter((invite) => !overview.users.some((user) => user.email.toLowerCase() === invite.email.toLowerCase())).length}</strong></div><div class="metric"><span>저장된 브리핑</span><strong>${overview.lessons.length}</strong></div></div><section class="section split"><div class="panel"><div class="section-heading"><h2>사용자 초대</h2></div><form id="invite-form" class="form-grid"><label class="field">Google 이메일<input name="email" type="email" required maxlength="254" placeholder="name@example.com"></label><label class="field">메모<input name="note" maxlength="200" placeholder="선택 사항"></label><div class="wide"><button class="button primary" type="submit">초대 추가</button></div></form></div><div class="panel"><span class="eyebrow">Schedule</span><h2 style="margin:8px 0">${escapeHtml(settings.send_time)} ${escapeHtml(settings.timezone)}</h2><p class="muted">요약 언어: ${escapeHtml(settings.summary_language)} · LLM ${settings.llmConfigured ? "설정 완료" : "설정 필요"}</p><p class="muted">Cron은 매분 실행되어 설정된 현지 시각에서만 발송을 시작합니다.</p></div></section><section class="section"><div class="section-heading"><h2>사용자</h2></div><div class="table-wrap"><table><thead><tr><th>이메일</th><th>이름</th><th>상태</th><th></th></tr></thead><tbody>${users || `<tr><td colspan="4" class="empty">등록된 사용자가 없습니다.</td></tr>`}</tbody></table></div></section><section class="section"><div class="section-heading"><h2>초대 목록</h2></div><div class="table-wrap"><table><thead><tr><th>이메일</th><th>메모</th><th>메일 상태</th><th>초대 시각</th><th></th></tr></thead><tbody>${invites || `<tr><td colspan="5" class="empty">초대가 없습니다.</td></tr>`}</tbody></table></div></section><section class="section"><div class="section-heading"><h2>뉴스 미디어</h2></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>이름</th><th>RSS/Atom URL</th><th>순서</th><th>활성</th><th></th></tr></thead><tbody>${sourceRows}</tbody></table></div><form id="source-form" class="panel form-grid" style="margin-top:12px"><label class="field">ID<input name="id" required pattern="(?:[A-Za-z0-9_]|-){1,40}" placeholder="source-id"></label><label class="field">이름<input name="name" required maxlength="80"></label><label class="field wide">RSS/Atom URL<input name="url" type="url" required></label><label class="field">정렬 순서<input name="order" type="number" min="0" value="${sources.sources.length}"></label><label class="check-row"><input name="enabled" type="checkbox" checked> 활성 소스로 사용</label><div class="wide"><button class="button primary" type="submit">미디어 추가</button></div></form></section><section class="section"><div class="section-heading"><h2>발송 일정과 LLM</h2></div><form id="settings-form" class="panel form-grid"><label class="field">시간대 (IANA)<input name="timezone" required value="${escapeHtml(settings.timezone)}" placeholder="UTC"></label><label class="field">발송 시각<input name="send_time" type="time" required value="${escapeHtml(settings.send_time)}"></label><label class="field">요약 언어<input name="summary_language" required maxlength="40" value="${escapeHtml(settings.summary_language)}"></label><label class="field">LLM 모델<input name="llm_model" maxlength="120" value="${escapeHtml(settings.llm_model)}" placeholder="모델 식별자"></label><label class="field wide">OpenAI 호환 API Base URL<input name="llm_base_url" type="url" value="${escapeHtml(settings.llm_base_url)}" placeholder="https://provider.example/v1"></label><div class="wide actions"><button class="button primary" type="submit">설정 저장</button><span class="muted">LLM_API_KEY는 Cloudflare Worker secret으로 별도 등록합니다.</span></div></form></section><section class="section"><div class="section-heading"><h2>일일 브리핑</h2></div><div class="table-wrap"><table><thead><tr><th>날짜</th><th>제목</th><th>생성 시각</th><th></th></tr></thead><tbody>${lessonRows || `<tr><td colspan="4" class="empty">아직 생성된 브리핑이 없습니다.</td></tr>`}</tbody></table></div></section><section class="section"><div class="section-heading"><h2>최근 메일 전송</h2></div>${deliveryTable(deliveryRows, true)}</section><section class="section"><div class="section-heading"><h2>실행 현황</h2></div><div class="table-wrap"><table><thead><tr><th>날짜</th><th>결과</th><th>집계</th><th>오류</th><th>시각</th></tr></thead><tbody>${runRows || `<tr><td colspan="5" class="empty">실행 기록이 없습니다.</td></tr>`}</tbody></table></div></section>`);

  const settingsForm = document.querySelector("#settings-form");
  for (const name of ["summary_language", "llm_model", "llm_base_url"]) {
    settingsForm.querySelector(`[name="${name}"]`)?.closest("label")?.remove();
  }
  const llmSecretStatus = document.createElement("p");
  llmSecretStatus.className = "wide muted";
  const secretStatus = settings.llmSecrets;
  llmSecretStatus.textContent = `LLM Cloudflare secrets · API key: ${secretStatus.apiKey ? "등록됨" : "미등록"} · Base URL: ${secretStatus.baseUrl ? (secretStatus.baseUrlValid ? "등록·형식 정상" : "등록·형식 오류") : "미등록"} · Model: ${secretStatus.model ? "등록됨" : "미등록"} · 출력 언어: 한국어`;
  settingsForm.querySelector(".actions")?.parentElement?.before(llmSecretStatus);

  document.querySelector("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await perform(async () => { const result = await request("/api/admin/invites", { method: "POST", body: JSON.stringify(values) }); await renderAdmin(); setNotice(result.emailSent ? "초대 이메일을 전송했습니다." : "초대는 등록했지만 이메일 전송에 실패했습니다. Resend 설정을 확인하세요.", !result.emailSent); }, "");
  });
  document.querySelector("#source-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    values.enabled = event.currentTarget.elements.enabled.checked;
    values.order = Number(values.order);
    await perform(async () => { await request("/api/admin/sources", { method: "POST", body: JSON.stringify(values) }); await renderAdmin(); }, "미디어를 추가했습니다.");
  });
  document.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await perform(async () => { await request("/api/admin/settings", { method: "PUT", body: JSON.stringify(values) }); await renderAdmin(); }, "설정을 저장했습니다.");
  });
}

async function perform(work, success) {
  try { await work(); if (success) setNotice(success); }
  catch (error) { setNotice(error.message, true); }
}

async function render() {
  try {
    const { user } = await request("/api/me");
    if (!user) {
      state.user = null;
      loginView();
      return;
    }
    state.user = user;
    if (state.view === "admin" && !user.isAdmin) state.view = "settings";
    if (state.view === "history") await renderHistory();
    else if (state.view === "admin") await renderAdmin();
    else await renderSettings();
  } catch (error) {
    if (error.message.startsWith("not_invited")) {
      state.authError = "not_invited";
      loginView();
    } else {
      app.innerHTML = `<main class="shell"><div class="notice error">서비스에 연결할 수 없습니다. 잠시 후 새로고침해 주세요.</div></main>`;
    }
  }
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { state.view = viewButton.dataset.view; state.notice = ""; await render(); return; }
  const actionButton = event.target.closest("[data-action]");
  const action = actionButton?.dataset.action;
  if (action === "logout") {
    await request("/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.assign("/");
    return;
  }
  if (action === "test-email") {
    actionButton.disabled = true;
    actionButton.textContent = "요약 생성 중...";
    setNotice("활성 뉴스 수집과 LLM 요약을 진행 중입니다. 완료될 때까지 잠시 기다려 주세요.");
    try {
      await request("/api/admin/test-email", { method: "POST", body: "{}" });
      setNotice("테스트 메일을 전송했습니다.");
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      actionButton.disabled = false;
      actionButton.textContent = "테스트 메일";
    }
    return;
  }
  if (action === "run") {
    if (!confirm("현재 구독 중인 사용자에게 오늘 브리핑을 발송할까요? 이미 전송된 메일은 중복 발송하지 않습니다.")) return;
    await perform(async () => { const result = await request("/api/admin/run", { method: "POST", body: "{}" }); await renderAdmin(); setNotice(`실행 결과: ${result.status}`); }, "");
  }
  const historyButton = event.target.closest("[data-history]");
  if (historyButton) await showMessage(historyButton.dataset.history);
  const deliveryButton = event.target.closest("[data-delivery]");
  if (deliveryButton) await showDelivery(deliveryButton.dataset.delivery);
  const lessonButton = event.target.closest("[data-lesson]");
  if (lessonButton) await showMessage(lessonButton.dataset.lesson, true);
  const removeInvite = event.target.closest("[data-remove-invite]");
  if (removeInvite && confirm(`${removeInvite.dataset.removeInvite} 초대를 삭제할까요?`)) {
    await perform(async () => { await request(`/api/admin/invites/${encodeURIComponent(removeInvite.dataset.removeInvite)}`, { method: "DELETE" }); await renderAdmin(); }, "초대를 삭제했습니다.");
  }
  const userButton = event.target.closest("[data-user]");
  if (userButton) {
    const subscribed = userButton.dataset.subscribed === "true";
    await perform(async () => { await request(`/api/admin/users/${encodeURIComponent(userButton.dataset.user)}`, { method: "PATCH", body: JSON.stringify({ subscribed }) }); await renderAdmin(); }, "사용자 상태를 변경했습니다.");
  }
  const saveSource = event.target.closest("[data-save-source]");
  if (saveSource) {
    const row = saveSource.closest("tr");
    const value = (name) => row.querySelector(`[data-field="${name}"]`);
    const source = { name: value("name").value, url: value("url").value, order: Number(value("order").value), enabled: value("enabled").checked };
    await perform(async () => { await request(`/api/admin/sources/${encodeURIComponent(saveSource.dataset.saveSource)}`, { method: "PUT", body: JSON.stringify(source) }); await renderAdmin(); }, "미디어를 저장했습니다.");
  }
  const deleteSource = event.target.closest("[data-delete-source]");
  if (deleteSource && confirm("이 미디어를 삭제할까요?")) {
    await perform(async () => { await request(`/api/admin/sources/${encodeURIComponent(deleteSource.dataset.deleteSource)}`, { method: "DELETE" }); await renderAdmin(); }, "미디어를 삭제했습니다.");
  }
});

render();