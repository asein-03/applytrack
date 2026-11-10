const ORIGINS = [
  'https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*',
  'https://boards.eu.greenhouse.io/*', 'https://jobs.lever.co/*',
  'https://jobs.eu.lever.co/*', 'https://jobs.ashbyhq.com/*',
];
const $ = selector => document.querySelector(selector);
let paired = false;
let active = false;
let busy = '';
let editingPairing = false;
const message = (text, error = false) => {
  $('#message').textContent = text;
  $('#message').classList.toggle('error', error);
  $('#message').setAttribute('role', error ? 'alert' : 'status');
};
function renderControls() {
  $('#start').hidden = active;
  $('#stop').hidden = !active;
  $('#start').disabled = !paired || !!busy;
  $('#stop').disabled = !!busy;
  $('#save').disabled = !paired || !!busy;
  $('#pair-submit').disabled = !!busy;
  $('#token').disabled = !!busy;
  $('#retry').disabled = !!busy;
  $('#change-pairing').disabled = !!busy;
  $('#pair-cancel').disabled = !!busy;
  $('#pair-form').hidden = paired && !editingPairing;
  $('#pair-cancel').hidden = !paired;
  $('#change-pairing').hidden = !paired || editingPairing;
  $('#start').textContent = busy === 'start' ? 'Starting…' : 'Start browser tracking';
  $('#stop').textContent = busy === 'stop' ? 'Stopping…' : 'Stop browser tracking';
  $('#save').textContent = busy === 'save' ? 'Saving…' : 'Save this job';
  $('#pair-submit').textContent = busy === 'pair' ? 'Connecting…' : 'Connect extension';
}
async function send(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (!result?.ok) throw new Error(result?.error || 'The extension could not complete this action.');
  return result;
}
async function refresh() {
  try {
    const result = await send({ type: 'state' });
    paired = !!result.paired;
    active = !!(result.session?.browserEnabled && !result.session.stoppedAt);
    $('#status').textContent = active ? 'Browser tracking is on' : paired ? 'Ready to track' : 'Connect to Apply';
    $('#indicator').classList.toggle('active', active);
    $('#indicator').classList.remove('error');
    $('#connection-label').textContent = paired ? 'Local app connected' : 'Pairing required';
    $('#retry').hidden = true;
    message(active ? 'Applications on supported sites are being tracked.' : paired ? 'Start a session before you begin applying.' : 'Pair this extension with the dashboard on your computer.');
  } catch (error) {
    paired = false;
    active = false;
    $('#status').textContent = 'Connection unavailable';
    $('#connection-label').textContent = 'Local app unavailable';
    $('#indicator').classList.remove('active');
    $('#indicator').classList.add('error');
    $('#retry').hidden = false;
    message(error.message, true);
  }
  renderControls();
}
$('#pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = 'pair'; renderControls();
  try {
    await send({ type: 'pair', token: $('#token').value });
    $('#token').value = ''; editingPairing = false;
    await refresh();
  } catch (error) { message(error.message, true); }
  finally { busy = ''; renderControls(); }
});
$('#start').addEventListener('click', async () => {
  if (busy) return;
  busy = 'start'; renderControls();
  try {
    // The permission request stays in the user's click handler.
    const granted = await chrome.permissions.request({ origins: ORIGINS });
    if (!granted) { message('Allow the supported job sites to start automatic tracking.'); return; }
    await send({ type: 'start' });
    await refresh();
  } catch (error) { message(error.message, true); }
  finally { busy = ''; renderControls(); }
});
$('#stop').addEventListener('click', async () => {
  if (busy) return;
  busy = 'stop'; renderControls();
  try { await send({ type: 'stop' }); await refresh(); }
  catch (error) { message(error.message, true); }
  finally { busy = ''; renderControls(); }
});
$('#save').addEventListener('click', async () => {
  if (busy) return;
  busy = 'save'; renderControls();
  try { await send({ type: 'save-current' }); message('Job saved to your dashboard.'); }
  catch (error) { message(error.message, true); }
  finally { busy = ''; renderControls(); }
});
$('#change-pairing').addEventListener('click', () => {
  editingPairing = true; renderControls(); $('#token').focus();
});
$('#pair-cancel').addEventListener('click', () => {
  editingPairing = false; $('#token').value = ''; renderControls();
});
$('#retry').addEventListener('click', async () => {
  if (busy) return;
  busy = 'refresh'; renderControls();
  try { await refresh(); } finally { busy = ''; renderControls(); }
});
$('#open').addEventListener('click', () => { chrome.tabs.create({ url: 'http://127.0.0.1:5173' }); });
void refresh();
