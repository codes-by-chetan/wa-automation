// State Management
const state = {
  settings: {},
  status: {},
  whitelist: [],
  blacklist: [],
  activeChatJid: null,
};

// UI Initialization
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSettingsListeners();
  initScheduler();
  initChats();
  initLogs();
  initQuickSend();

  // Initial Data Fetch
  fetchStatus();
  fetchSettings();
  fetchSchedules();

  // Status poller (every 3 seconds)
  setInterval(fetchStatus, 3000);
});

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Tabs
function initTabs() {
  const tabs = document.querySelectorAll('.nav-item');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      contents.forEach((c) => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      if (targetId === 'tab-scheduler') fetchSchedules();
      if (targetId === 'tab-chats') fetchChats();
      if (targetId === 'tab-logs') fetchLogs();
    });
  });
}

// ----------------- WhatsApp Status & Pairing -----------------
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.status = data;

    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const detail = document.getElementById('status-detail');
    const qrContainer = document.getElementById('qr-container');
    const connectedContainer = document.getElementById('connected-container');
    const qrImage = document.getElementById('qr-image');
    const qrSpinner = document.getElementById('qr-spinner');

    if (data.isConnected) {
      dot.className = 'status-indicator connected';
      label.textContent = 'Connected';
      detail.textContent = data.user?.phone ? `+${data.user.phone}` : 'Active session';

      qrContainer.style.display = 'none';
      connectedContainer.style.display = 'flex';

      document.getElementById('connected-phone').textContent = data.user?.phone ? `+${data.user.phone}` : 'Active';
      document.getElementById('connected-name').textContent = data.user?.name || 'WhatsApp Account';
    } else if (data.status === 'connecting') {
      dot.className = 'status-indicator connecting';
      label.textContent = 'Connecting...';
      detail.textContent = 'Scan QR code';

      connectedContainer.style.display = 'none';
      qrContainer.style.display = 'flex';

      if (data.qrCode) {
        qrImage.src = data.qrCode;
        qrImage.style.display = 'block';
        qrSpinner.style.display = 'none';
      } else {
        qrImage.style.display = 'none';
        qrSpinner.style.display = 'flex';
      }
    } else {
      dot.className = 'status-indicator';
      label.textContent = 'Disconnected';
      detail.textContent = 'Click to reconnect';

      connectedContainer.style.display = 'none';
      qrContainer.style.display = 'flex';
      qrImage.style.display = 'none';
      qrSpinner.style.display = 'flex';
    }
  } catch (err) {
    console.error('Status fetch error:', err);
  }
}

// Reconnect & Logout
document.getElementById('btn-reconnect').addEventListener('click', async () => {
  showToast('Requesting connection restart...', 'info');
  await fetch('/api/reconnect', { method: 'POST' });
  fetchStatus();
});

document.getElementById('btn-refresh-qr').addEventListener('click', async () => {
  showToast('Generating fresh QR code...', 'info');
  await fetch('/api/reconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceNew: true })
  });
  fetchStatus();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (confirm('Are you sure you want to disconnect and clear your WhatsApp session?')) {
    await fetch('/api/logout', { method: 'POST' });
    showToast('WhatsApp session disconnected', 'info');
    fetchStatus();
  }
});

// ----------------- Settings & AI Persona -----------------
async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    state.settings = data;
    state.whitelist = data.whitelist || [];
    state.blacklist = data.blacklist || [];

    // Metrics
    document.getElementById('stat-target-mode').textContent = formatModeName(data.target_mode);
    document.getElementById('stat-llm-model').textContent = data.llm_model || 'gpt-4o-mini';

    // AI Form fields
    document.getElementById('input-base-url').value = data.llm_base_url || '';
    document.getElementById('input-api-key').value = data.llm_api_key || '';
    document.getElementById('input-model').value = data.llm_model || '';
    document.getElementById('input-system-prompt').value = data.system_prompt || '';
    document.getElementById('input-history-limit').value = data.history_limit || 10;

    // Rules
    const modeRadios = document.querySelectorAll('input[name="target_mode"]');
    modeRadios.forEach((r) => {
      r.checked = r.value === data.target_mode;
      updateModeCardHighlight();
    });

    renderTags('whitelist-tags', state.whitelist, (item) => {
      state.whitelist = state.whitelist.filter((w) => w !== item);
      renderTags('whitelist-tags', state.whitelist, arguments.callee);
    });

    renderTags('blacklist-tags', state.blacklist, (item) => {
      state.blacklist = state.blacklist.filter((b) => b !== item);
      renderTags('blacklist-tags', state.blacklist, arguments.callee);
    });

    document.getElementById('input-cooldown').value = data.cooldown_seconds || 5;
    document.getElementById('toggle-typing').checked = data.typing_simulation !== false;
    document.getElementById('toggle-scheduled-context').checked = data.scheduled_reply_mode === 'reply_with_context';

    const emergencyNumInput = document.getElementById('input-emergency-number');
    if (emergencyNumInput) emergencyNumInput.value = data.emergency_number || '';
    const emergencyKeyInput = document.getElementById('input-callmebot-key');
    if (emergencyKeyInput) emergencyKeyInput.value = data.callmebot_api_key || '';
    const emergencyWebhookInput = document.getElementById('input-emergency-webhook');
    if (emergencyWebhookInput) emergencyWebhookInput.value = data.emergency_call_webhook || '';
  } catch (err) {
    console.error('Settings load error:', err);
  }
}

function formatModeName(mode) {
  switch (mode) {
    case 'contacts_only': return 'Contacts';
    case 'groups_only': return 'Groups';
    case 'whitelist_only': return 'Whitelist';
    case 'all': return 'All';
    case 'disabled': return 'Disabled';
    default: return mode;
  }
}

function initSettingsListeners() {
  // Password Visibility Toggle
  const toggleKey = document.getElementById('toggle-key-visibility');
  const inputKey = document.getElementById('input-api-key');
  toggleKey.addEventListener('click', () => {
    if (inputKey.type === 'password') {
      inputKey.type = 'text';
      toggleKey.textContent = '🔒';
    } else {
      inputKey.type = 'password';
      toggleKey.textContent = '👁️';
    }
  });

  // Presets
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('input-base-url').value = btn.dataset.url;
      document.getElementById('input-model').value = btn.dataset.model;
      showToast(`Selected preset: ${btn.textContent}`, 'info');
    });
  });

  // Template Tags Insert
  document.querySelectorAll('.tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('input-system-prompt');
      const insertText = btn.dataset.insert;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + insertText + textarea.value.substring(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + insertText.length;
    });
  });

  // Save AI Settings
  document.getElementById('btn-save-ai-settings').addEventListener('click', async () => {
    const payload = {
      llm_base_url: document.getElementById('input-base-url').value.trim(),
      llm_api_key: document.getElementById('input-api-key').value.trim(),
      llm_model: document.getElementById('input-model').value.trim(),
      system_prompt: document.getElementById('input-system-prompt').value.trim(),
      history_limit: parseInt(document.getElementById('input-history-limit').value, 10) || 10,
    };

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      showToast('AI Settings saved successfully', 'success');
      fetchSettings();
    } else {
      showToast('Failed to save settings', 'error');
    }
  });

  // Test LLM Playground
  document.getElementById('btn-test-llm').addEventListener('click', async () => {
    const spinner = document.getElementById('test-llm-spinner');
    const btnText = document.getElementById('test-llm-btn-text');
    const resultBox = document.getElementById('test-result-content');

    spinner.style.display = 'inline-block';
    btnText.textContent = 'Generating...';
    resultBox.textContent = 'Calling model completion endpoint...';

    try {
      const res = await fetch('/api/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: document.getElementById('input-base-url').value.trim(),
          apiKey: document.getElementById('input-api-key').value.trim(),
          model: document.getElementById('input-model').value.trim(),
          systemPrompt: document.getElementById('input-system-prompt').value.trim(),
          sampleMessage: document.getElementById('test-user-message').value.trim(),
        }),
      });

      const data = await res.json();
      if (data.success) {
        resultBox.textContent = data.reply;
        showToast('Model completion succeeded!', 'success');
      } else {
        resultBox.textContent = `Error: ${data.error}`;
        showToast('Model test failed', 'error');
      }
    } catch (e) {
      resultBox.textContent = `Network Error: ${e.message}`;
    } finally {
      spinner.style.display = 'none';
      btnText.textContent = 'Test Model Completion';
    }
  });

  // Mode radio cards styling
  document.querySelectorAll('input[name="target_mode"]').forEach((radio) => {
    radio.addEventListener('change', updateModeCardHighlight);
  });

  // Tag inputs (Whitelist)
  document.getElementById('btn-add-whitelist').addEventListener('click', addWhitelistTag);
  document.getElementById('input-add-whitelist').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWhitelistTag();
  });

  // Tag inputs (Blacklist)
  document.getElementById('btn-add-blacklist').addEventListener('click', addBlacklistTag);
  document.getElementById('input-add-blacklist').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBlacklistTag();
  });

  // Save Rules
  document.getElementById('btn-save-rules').addEventListener('click', async () => {
    const selectedMode = document.querySelector('input[name="target_mode"]:checked')?.value || 'contacts_only';
    const cooldown = parseInt(document.getElementById('input-cooldown').value, 10) || 5;
    const typing = document.getElementById('toggle-typing').checked;
    const scheduledContext = document.getElementById('toggle-scheduled-context').checked;

    const emergencyNum = document.getElementById('input-emergency-number')?.value.trim() || '';
    const emergencyKey = document.getElementById('input-callmebot-key')?.value.trim() || '';
    const emergencyWebhook = document.getElementById('input-emergency-webhook')?.value.trim() || '';

    const payload = {
      target_mode: selectedMode,
      whitelist: state.whitelist,
      blacklist: state.blacklist,
      cooldown_seconds: cooldown,
      typing_simulation: typing,
      scheduled_reply_mode: scheduledContext ? 'reply_with_context' : 'default',
      emergency_number: emergencyNum,
      emergency_call_webhook: emergencyWebhook,
      callmebot_api_key: emergencyKey,
    };

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      showToast('Targeting, filter rules & emergency settings saved', 'success');
      fetchSettings();
    } else {
      showToast('Failed to save rules', 'error');
    }
  });

  // Test Emergency Alarm & SOS
  const btnTestEmergency = document.getElementById('btn-test-emergency');
  if (btnTestEmergency) {
    btnTestEmergency.addEventListener('click', async () => {
      const emergencyNumber = document.getElementById('input-emergency-number')?.value.trim() || '';
      const emergencyKey = document.getElementById('input-callmebot-key')?.value.trim() || '';
      showToast('Triggering emergency ringtone, call & SOS test...', 'warning');

      try {
        const res = await fetch('/api/test-emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emergencyNumber, callmebotApiKey: emergencyKey }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || 'Emergency alarm played & WhatsApp alert triggered!', 'success');
        } else {
          showToast(`Emergency test error: ${data.error}`, 'error');
        }
      } catch (err) {
        showToast(`Failed to trigger test: ${err.message}`, 'error');
      }
    });
  }
}

function updateModeCardHighlight() {
  document.querySelectorAll('.mode-card').forEach((card) => {
    const radio = card.querySelector('input[type="radio"]');
    if (radio && radio.checked) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}

function renderTags(containerId, list, removeCallback) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = '<span class="text-muted text-xs">No entries specified</span>';
    return;
  }

  list.forEach((item) => {
    const tag = document.createElement('span');
    tag.className = 'tag-item font-mono';
    tag.innerHTML = `<span>${item}</span><span class="tag-remove">&times;</span>`;
    tag.querySelector('.tag-remove').addEventListener('click', () => {
      const idx = list.indexOf(item);
      if (idx > -1) {
        list.splice(idx, 1);
        renderTags(containerId, list, removeCallback);
      }
    });
    container.appendChild(tag);
  });
}

function addWhitelistTag() {
  const input = document.getElementById('input-add-whitelist');
  const val = input.value.trim();
  if (val && !state.whitelist.includes(val)) {
    state.whitelist.push(val);
    renderTags('whitelist-tags', state.whitelist);
    input.value = '';
  }
}

function addBlacklistTag() {
  const input = document.getElementById('input-add-blacklist');
  const val = input.value.trim();
  if (val && !state.blacklist.includes(val)) {
    state.blacklist.push(val);
    renderTags('blacklist-tags', state.blacklist);
    input.value = '';
  }
}

// ----------------- Scheduler & Campaigns -----------------
async function fetchSchedules() {
  try {
    const filter = document.getElementById('schedule-status-filter').value;
    const url = filter ? `/api/schedules?status=${filter}` : '/api/schedules';
    const res = await fetch(url);
    const schedules = await res.json();

    const tbody = document.getElementById('schedules-tbody');
    tbody.innerHTML = '';

    // Count pending/active
    const pendingCount = schedules.filter((s) => s.status === 'pending' || s.status === 'active_cron').length;
    document.getElementById('stat-schedules-count').textContent = pendingCount;

    if (schedules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">No scheduled messages found. Click "Schedule New Message" to create one.</td></tr>';
      return;
    }

    schedules.forEach((item) => {
      const tr = document.createElement('tr');
      const timeDisplay = item.cron_expression 
        ? `<span class="badge badge-warning font-mono">Cron: ${item.cron_expression}</span>` 
        : (item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : 'Immediate');

      const contextBadge = item.context_note 
        ? `<span class="badge badge-warning" title="${item.context_note}">Follow-up Active</span>` 
        : '<span class="text-muted text-xs">None</span>';

      const statusBadge = item.status === 'completed' 
        ? '<span class="badge badge-success">Completed</span>'
        : (item.status === 'pending' 
          ? '<span class="badge badge-warning">Pending</span>'
          : `<span class="badge badge-warning">${item.status}</span>`);

      tr.innerHTML = `
        <td class="font-mono font-semibold">${item.recipient}</td>
        <td><div style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.message}</div></td>
        <td>${timeDisplay}</td>
        <td>${contextBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-secondary btn-sm" onclick="runScheduleNow('${item.id}')" title="Run immediately">Run</button>
            <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${item.id}')" title="Delete">&times;</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Schedules fetch error:', err);
  }
}

window.runScheduleNow = async function (id) {
  showToast('Executing scheduled message...', 'info');
  const res = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    showToast('Message dispatched!', 'success');
  } else {
    showToast(`Error: ${data.message || 'Dispatch failed'}`, 'error');
  }
  fetchSchedules();
};

window.deleteSchedule = async function (id) {
  if (confirm('Delete this scheduled message?')) {
    await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    showToast('Schedule removed', 'info');
    fetchSchedules();
  }
};

function initScheduler() {
  const modal = document.getElementById('schedule-modal');
  document.getElementById('btn-open-schedule-modal').addEventListener('click', () => {
    // Set default datetime to 10 minutes in future
    const d = new Date(Date.now() + 10 * 60 * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    document.getElementById('sched-datetime').value = d.toISOString().slice(0, 16);
    modal.style.display = 'flex';
  });

  document.getElementById('btn-close-schedule-modal').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  document.getElementById('btn-cancel-schedule').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Switch once vs cron
  const radioOnce = document.getElementById('sched-type-once');
  const radioCron = document.getElementById('sched-type-cron');
  const groupDatetime = document.getElementById('group-sched-datetime');
  const groupCron = document.getElementById('group-sched-cron');

  radioOnce.addEventListener('change', () => {
    groupDatetime.style.display = 'block';
    groupCron.style.display = 'none';
  });

  radioCron.addEventListener('change', () => {
    groupDatetime.style.display = 'none';
    groupCron.style.display = 'block';
  });

  // Cron Presets
  document.querySelectorAll('.preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.getElementById('sched-cron').value = pill.dataset.cron;
    });
  });

  // Submit Schedule
  document.getElementById('btn-submit-schedule').addEventListener('click', async () => {
    const recipient = document.getElementById('sched-recipient').value.trim();
    const message = document.getElementById('sched-message').value.trim();
    const isCron = radioCron.checked;
    const scheduledAt = !isCron ? new Date(document.getElementById('sched-datetime').value).toISOString() : null;
    const cronExpression = isCron ? document.getElementById('sched-cron').value.trim() : null;
    const contextNote = document.getElementById('sched-context-note').value.trim();

    if (!recipient || !message) {
      showToast('Recipient and message are required', 'error');
      return;
    }

    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, message, scheduledAt, cronExpression, contextNote }),
    });

    if (res.ok) {
      showToast('Schedule created successfully', 'success');
      modal.style.display = 'none';
      // Reset form
      document.getElementById('sched-recipient').value = '';
      document.getElementById('sched-message').value = '';
      document.getElementById('sched-context-note').value = '';
      fetchSchedules();
    } else {
      showToast('Failed to create schedule', 'error');
    }
  });

  document.getElementById('schedule-status-filter').addEventListener('change', fetchSchedules);
}

// ----------------- Quick Send -----------------
function initQuickSend() {
  const modal = document.getElementById('quick-send-modal');
  document.getElementById('btn-quick-send-modal').addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  document.getElementById('btn-close-quick-send').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  document.getElementById('btn-cancel-quick-send').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  document.getElementById('btn-submit-quick-send').addEventListener('click', async () => {
    const recipient = document.getElementById('quick-recipient').value.trim();
    const message = document.getElementById('quick-message').value.trim();
    const contextNote = document.getElementById('quick-context-note').value.trim();

    if (!recipient || !message) {
      showToast('Recipient and message are required', 'error');
      return;
    }

    showToast('Sending message...', 'info');
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, message, contextNote }),
    });

    const data = await res.json();
    if (data.success) {
      showToast('Message sent!', 'success');
      modal.style.display = 'none';
      document.getElementById('quick-recipient').value = '';
      document.getElementById('quick-message').value = '';
      document.getElementById('quick-context-note').value = '';
    } else {
      showToast(`Send failed: ${data.error}`, 'error');
    }
  });
}

// ----------------- Chats & Conversation Viewer -----------------
async function fetchChats() {
  try {
    const res = await fetch('/api/chats');
    const chats = await res.json();
    const container = document.getElementById('chat-list-container');
    container.innerHTML = '';

    if (chats.length === 0) {
      container.innerHTML = '<div class="text-center text-muted py-4">No recent messages recorded yet.</div>';
      return;
    }

    chats.forEach((chat) => {
      const item = document.createElement('div');
      item.className = `chat-list-item ${state.activeChatJid === chat.jid ? 'active' : ''}`;
      const name = chat.sender_name || chat.jid.split('@')[0];
      const time = new Date(chat.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      item.innerHTML = `
        <div class="chat-item-header">
          <span class="chat-item-name">${name}</span>
          <span class="chat-item-time">${time}</span>
        </div>
        <div class="chat-item-snippet">${chat.last_content}</div>
      `;

      item.addEventListener('click', () => {
        state.activeChatJid = chat.jid;
        document.querySelectorAll('.chat-list-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        loadChatDetail(chat.jid, name);
      });

      container.appendChild(item);
    });
  } catch (err) {
    console.error('Fetch chats error:', err);
  }
}

async function loadChatDetail(jid, name) {
  try {
    document.getElementById('chat-detail-header').querySelector('.chat-detail-title').textContent = `${name} (${jid})`;
    document.getElementById('chat-reply-bar').style.display = 'flex';

    const res = await fetch(`/api/chats/${encodeURIComponent(jid)}/messages`);
    const { messages, campaignContext } = await res.json();

    const campaignBadge = document.getElementById('chat-campaign-badge');
    if (campaignContext) {
      campaignBadge.style.display = 'inline-block';
      campaignBadge.title = `Active follow-up context: ${campaignContext.context_note}`;
    } else {
      campaignBadge.style.display = 'none';
    }

    const scrollBox = document.getElementById('chat-messages-container');
    scrollBox.innerHTML = '';

    messages.forEach((msg) => {
      const div = document.createElement('div');
      div.className = `chat-msg ${msg.from_me ? 'outgoing' : 'incoming'}`;
      const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      div.innerHTML = `
        <div>${msg.content}</div>
        <div class="chat-msg-time">${msg.from_me ? (msg.is_bot_reply ? '🤖 AI Bot • ' : 'You • ') : ''}${time}</div>
      `;
      scrollBox.appendChild(div);
    });

    scrollBox.scrollTop = scrollBox.scrollHeight;
  } catch (err) {
    console.error('Load chat messages error:', err);
  }
}

function initChats() {
  document.getElementById('btn-refresh-chats').addEventListener('click', fetchChats);

  document.getElementById('btn-send-manual-chat').addEventListener('click', async () => {
    const input = document.getElementById('chat-manual-input');
    const text = input.value.trim();
    if (!text || !state.activeChatJid) return;

    showToast('Sending message...', 'info');
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: state.activeChatJid, message: text }),
    });

    if (res.ok) {
      input.value = '';
      showToast('Sent', 'success');
      loadChatDetail(state.activeChatJid, state.activeChatJid);
    } else {
      showToast('Send failed', 'error');
    }
  });
}

// ----------------- Activity Logs -----------------
async function fetchLogs() {
  try {
    const res = await fetch('/api/logs');
    const logs = await res.json();
    const stream = document.getElementById('log-stream');
    stream.innerHTML = '';

    // Count reply logs for stats
    const replyCount = logs.filter((l) => l.level === 'REPLY').length;
    document.getElementById('stat-replies-count').textContent = replyCount;

    if (logs.length === 0) {
      stream.innerHTML = '<div class="text-muted text-center py-4">No activity logs yet.</div>';
      return;
    }

    logs.forEach((log) => {
      const row = document.createElement('div');
      row.className = 'log-entry';
      const time = new Date(log.timestamp).toLocaleTimeString();
      let detailsText = '';
      if (log.details) {
        try {
          detailsText = ` | ${log.details}`;
        } catch {}
      }

      row.innerHTML = `
        <span class="log-time">[${time}]</span>
        <span class="log-badge ${log.level}">${log.level}</span>
        <span class="log-msg">${log.message}${detailsText}</span>
      `;
      stream.appendChild(row);
    });
  } catch (err) {
    console.error('Fetch logs error:', err);
  }
}

function initLogs() {
  document.getElementById('btn-refresh-logs').addEventListener('click', () => {
    fetchLogs();
    showToast('Logs refreshed', 'info');
  });

  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    if (confirm('Clear all activity logs?')) {
      await fetch('/api/logs/clear', { method: 'POST' });
      fetchLogs();
      showToast('Logs cleared', 'info');
    }
  });
}
