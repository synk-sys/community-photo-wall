const PAGE_SIZE = 60;
const $ = (selector) => document.querySelector(selector);

const state = { status: 'pending', limit: PAGE_SIZE, selected: new Set(), shownIds: [] };
const cards = new Map(); // Keyed by id and status, so a live refresh doesn't reload visible images.
let stream;
let rejectTarget = null;

class SignedOut extends Error {}

async function api(path, options = {}) {
  const response = await fetch(`/api/organizer${path}`, {
    method: options.body ? 'POST' : options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && path !== '/login') {
    showLogin();
    throw new SignedOut();
  }
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(body.error ?? 'Something went wrong.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function notify(message, kind = '') {
  const notice = $('#notice');
  notice.className = `status ${kind}`;
  notice.textContent = message;
}

function showLogin() {
  stream?.close();
  stream = null;
  $('#dashboard').hidden = true;
  $('#login').hidden = false;
}

function showDashboard(email) {
  $('#login').hidden = true;
  $('#dashboard').hidden = false;
  $('#who').textContent = email;
  connectStream();
  refresh();
}

function connectStream() {
  const live = $('#live');
  stream = new EventSource('/api/organizer/events');
  stream.onopen = () => { live.textContent = 'Live'; live.classList.add('on'); };
  stream.onerror = () => {
    live.textContent = 'Reconnecting…';
    live.classList.remove('on');
    // An authorization failure closes the stream for good, and this surfaces the sign-in screen.
    if (stream.readyState === EventSource.CLOSED) api('/me').catch(() => {});
  };
  stream.addEventListener('change', refresh);
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `button ${className}`;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function buildCard(photo) {
  const card = document.createElement('article');
  card.className = 'photo-card';

  const link = document.createElement('a');
  link.href = photo.imageUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  const image = new Image();
  image.loading = 'lazy';
  image.alt = 'Uploaded photo awaiting moderation';
  image.src = photo.imageUrl;
  link.append(image);
  card.append(link);

  const meta = document.createElement('div');
  meta.className = 'photo-meta';
  const line = (text, className = 'muted') => {
    const element = document.createElement('p');
    element.className = className;
    element.textContent = text; // Always textContent: these values must never be parsed as HTML.
    meta.append(element);
  };
  line(`Uploaded ${formatTime(photo.uploadedAt)}`);
  if (photo.moderatedBy) line(`${photo.revokedAt ? 'Revoked' : photo.moderationStatus === 'approved' ? 'Approved' : 'Rejected'} by ${photo.moderatedBy} at ${formatTime(photo.moderatedAt)}`);
  if (photo.rejectionReason) line(`Reason: ${photo.rejectionReason}`, 'reason');
  if (!photo.consentToDisplay) line('No display consent: this photo will never appear publicly.', 'warning');
  card.append(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (photo.moderationStatus === 'pending') {
    const label = document.createElement('label');
    label.className = 'check select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = photo.id;
    checkbox.checked = state.selected.has(photo.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(photo.id);
      else state.selected.delete(photo.id);
      updateBulkBar();
    });
    const text = document.createElement('span');
    text.textContent = 'Select';
    label.append(checkbox, text);
    actions.append(
      label,
      button('Approve', 'primary', () => moderate(photo.id, 'approve', { expectedStatus: 'pending' })),
      button('Reject', 'danger', () => openReject(photo.id)),
    );
  } else if (photo.moderationStatus === 'approved') {
    actions.append(button('Revoke approval', 'danger', () => moderate(photo.id, 'revoke')));
  } else {
    actions.append(button('Approve instead', 'primary', () => moderate(photo.id, 'approve', { expectedStatus: 'rejected' })));
  }
  card.append(actions);
  return card;
}

function render(photos, counts) {
  for (const status of Object.keys(counts)) $(`#count-${status}`).textContent = counts[status];

  const grid = $('#photos');
  const wanted = new Set(photos.map((photo) => `${photo.id}|${photo.moderatedAt}`));
  for (const [key, card] of cards) {
    if (!wanted.has(key)) {
      card.remove();
      cards.delete(key);
    }
  }
  for (const photo of photos) {
    const key = `${photo.id}|${photo.moderatedAt}`;
    if (!cards.has(key)) cards.set(key, buildCard(photo));
    grid.append(cards.get(key));
  }

  state.shownIds = photos.map((photo) => photo.id);
  const shown = new Set(state.shownIds);
  for (const id of state.selected) if (!shown.has(id)) state.selected.delete(id);

  const empty = $('#empty');
  empty.hidden = photos.length > 0;
  empty.textContent = { pending: 'Nothing waiting for review.', approved: 'No approved photos yet.', rejected: 'No rejected photos.' }[state.status];
  $('#load-more').hidden = photos.length >= counts[state.status];
  $('#bulk').hidden = state.status !== 'pending' || photos.length === 0;
  updateBulkBar();
}

function updateBulkBar() {
  const count = state.selected.size;
  const bulk = $('#bulk-approve');
  bulk.textContent = `Approve selected (${count})`;
  bulk.disabled = count === 0;
  const all = $('#select-all');
  all.checked = count > 0 && count === state.shownIds.length;
}

let refreshing = false;
let refreshAgain = false;

/** Serialized so an out-of-date response can never overwrite a newer one. */
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const status = state.status;
    const { photos, counts } = await api(`/photos?status=${status}&limit=${state.limit}`);
    if (status === state.status) render(photos, counts);
  } catch (error) {
    if (!(error instanceof SignedOut)) notify(error.message, 'error');
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

async function moderate(id, action, body = {}) {
  notify('');
  try {
    await api(`/photos/${id}/${action}`, { body });
  } catch (error) {
    if (error instanceof SignedOut) return;
    notify(error.message, 'error');
  }
  refresh();
}

function openReject(id) {
  rejectTarget = id;
  $('#reject-form').reset();
  $('#reject-dialog').showModal();
}

$('#reject-dialog').addEventListener('close', () => {
  const dialog = $('#reject-dialog');
  if (dialog.returnValue === 'confirm' && rejectTarget) {
    moderate(rejectTarget, 'reject', { reason: new FormData($('#reject-form')).get('reason') });
  }
  rejectTarget = null;
  dialog.returnValue = '';
});

$('#select-all').addEventListener('change', (event) => {
  state.selected = new Set(event.target.checked ? state.shownIds : []);
  for (const checkbox of document.querySelectorAll('#photos input[type=checkbox]')) {
    checkbox.checked = event.target.checked;
  }
  updateBulkBar();
});

$('#bulk-approve').addEventListener('click', async () => {
  notify('');
  try {
    const { approved, skipped } = await api('/photos/bulk-approve', { body: { ids: [...state.selected] } });
    state.selected.clear();
    notify(`Approved ${approved.length} photo${approved.length === 1 ? '' : 's'}${skipped.length ? `; ${skipped.length} had already been moderated` : ''}.`, 'success');
  } catch (error) {
    if (!(error instanceof SignedOut)) notify(error.message, 'error');
  }
  refresh();
});

function selectTab(status) {
  state.status = status;
  state.limit = PAGE_SIZE;
  state.selected.clear();
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.status === status));
  }
  notify('');
  refresh();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.status));
}

$('#load-more').addEventListener('click', () => {
  state.limit += PAGE_SIZE;
  refresh();
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $('#login-error').textContent = '';
  try {
    const { email } = await api('/login', { body: { email: form.get('email'), password: form.get('password') } });
    event.target.reset();
    showDashboard(email);
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

selectTab('pending');
api('/me').then(({ email }) => showDashboard(email)).catch(() => {});
