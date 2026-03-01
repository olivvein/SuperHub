const tokenInput = document.getElementById("token");
const saveTokenButton = document.getElementById("save-token");
const healthGrid = document.getElementById("health-grid");
const metricsOutput = document.getElementById("metrics");
const servicesBody = document.getElementById("services-body");
const clientsBody = document.getElementById("clients-body");
const inspectorLog = document.getElementById("inspector-log");
const inspectorFilter = document.getElementById("inspector-filter");
const statePrefixInput = document.getElementById("state-prefix");
const reloadStateButton = document.getElementById("reload-state");
const stateOutput = document.getElementById("state-output");
const configOutput = document.getElementById("config-output");

const tabs = Array.from(document.querySelectorAll(".tabs button[data-tab]"));
const panels = Array.from(document.querySelectorAll(".panel"));

let inspectorMessages = [];

const savedToken = localStorage.getItem("superhub.token") || "";
tokenInput.value = savedToken;

saveTokenButton.addEventListener("click", () => {
  localStorage.setItem("superhub.token", tokenInput.value.trim());
  void refreshAll();
});

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const id = tab.dataset.tab;
    if (!id) return;

    for (const node of tabs) {
      node.classList.toggle("active", node === tab);
    }

    for (const panel of panels) {
      panel.classList.toggle("active", panel.id === id);
    }
  });
}

reloadStateButton.addEventListener("click", () => {
  void refreshState();
});

inspectorFilter.addEventListener("input", () => {
  renderInspector();
});

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = tokenInput.value.trim();
  if (token) {
    headers.set("X-Hub-Token", token);
  }

  const response = await fetch(path, {
    ...init,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

function renderHealth(data, metrics) {
  const items = [
    ["Status", data.ok ? "ok" : "ko"],
    ["Sessions", String(data.sessions)],
    ["Services", String(data.services)],
    ["Uptime (sec)", String(data.uptimeSec)],
    ["Dropped", String(metrics.droppedMessages ?? 0)],
    ["RPC p95 ms", String(metrics.rpcLatencyP95Ms ?? 0)]
  ];

  healthGrid.innerHTML = items
    .map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`)
    .join("");
}

function renderServices(data) {
  servicesBody.innerHTML = "";
  for (const service of data.services || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(service.serviceName)}</td>
      <td>${escapeHtml(service.clientId)}</td>
      <td>${escapeHtml(service.instanceId)}</td>
      <td>${escapeHtml(service.health)}</td>
      <td>${escapeHtml((service.provides || []).join(", "))}</td>
      <td>${new Date(service.lastSeenTs).toLocaleString()}</td>
    `;
    servicesBody.appendChild(tr);
  }
}

function renderClients(data) {
  clientsBody.innerHTML = "";
  for (const client of data.clients || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(client.clientId)}</td>
      <td>${escapeHtml(client.sessionId)}</td>
      <td>${escapeHtml(client.serviceName || "")}</td>
      <td>${escapeHtml(client.ip || "")}</td>
      <td>${new Date(client.connectedAt).toLocaleString()}</td>
    `;
    clientsBody.appendChild(tr);
  }
}

function renderInspector() {
  const query = inspectorFilter.value.trim().toLowerCase();

  const filtered = !query
    ? inspectorMessages
    : inspectorMessages.filter((entry) => {
        const asText = JSON.stringify(entry).toLowerCase();
        return asText.includes(query);
      });

  inspectorLog.textContent = filtered
    .slice(-250)
    .map((entry) => JSON.stringify(entry, null, 2))
    .join("\n\n");
}

async function refreshState() {
  const prefix = statePrefixInput.value.trim();
  const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";

  try {
    const state = await api(`/api/state${query}`);
    stateOutput.textContent = JSON.stringify(state, null, 2);
  } catch (error) {
    stateOutput.textContent = String(error);
  }
}

async function refreshAll() {
  try {
    const [health, services, clients, messages, metrics, config] = await Promise.all([
      api("/api/health"),
      api("/api/services"),
      api("/api/clients"),
      api("/api/messages"),
      api("/api/metrics"),
      api("/api/config")
    ]);

    renderHealth(health, metrics);
    renderServices(services);
    renderClients(clients);

    inspectorMessages = messages.messages || [];
    renderInspector();

    metricsOutput.textContent = JSON.stringify(metrics, null, 2);
    configOutput.textContent = JSON.stringify(config, null, 2);

    await refreshState();
  } catch (error) {
    inspectorLog.textContent = String(error);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void refreshAll();
setInterval(() => {
  void refreshAll();
}, 3000);
