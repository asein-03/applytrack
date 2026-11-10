const ORIGINS = [
  'https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*',
  'https://boards.eu.greenhouse.io/*', 'https://jobs.lever.co/*',
  'https://jobs.eu.lever.co/*', 'https://jobs.ashbyhq.com/*',
];
const $ = selector => document.querySelector(selector);
const message = (text, error = false) => {
  $('#message').textContent = text;
  $('#message').classList.toggle('error', error);
};
async function send(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (!result?.ok) throw new Error(result?.error || 'The extension could not complete this action.');
  return result;
}
async function refresh() {
  try {
    const result = await send({ type: 'state' });
    const active = result.session?.browserEnabled && !result.session.stoppedAt;
    $('#status').textContent = active ? 'Browser tracking is on' : result.paired ? 'Connected to Apply' : 'Not connected';
    $('#indicator').classList.toggle('active', Boolean(active));
    $('#start').hidden = Boolean(active);
    $('#stop').hidden = !active;
    $('#pair-form').hidden = Boolean(result.paired);
    $('#save').disabled = !result.paired;
    $('#start').disabled = !result.paired;
    message(active ? 'Applications on supported sites will be tracked.' : 'Start tracking before you begin applying.');
  } catch (error) {
    $('#status').textContent = 'Connection unavailable';
    $('#indicator').classList.remove('active');
    $('#pair-form').hidden = false;
    message(error.message, true);
  }
}
$('#pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await send({ type: 'pair', token: $('#token').value });
    $('#token').value = '';
    await refresh();
  } catch (error) { message(error.message, true); }
});
$('#start').addEventListener('click', async () => {
  try {
    // Permission request stays directly within the user's click.
    const granted = await chrome.permissions.request({ origins: ORIGINS });
    if (!granted) { message('Allow supported recruitment sites to start automatic tracking.'); return; }
    await send({ type: 'start' });
    await refresh();
  } catch (error) { message(error.message, true); }
});
$('#stop').addEventListener('click', async () => {
  try { await send({ type: 'stop' }); await refresh(); }
  catch (error) { message(error.message, true); }
});
$('#save').addEventListener('click', async () => {
  $('#save').disabled = true;
  try { await send({ type: 'save-current' }); message('Job saved to your dashboard.'); }
  catch (error) { message(error.message, true); }
  finally { $('#save').disabled = false; }
});
$('#open').addEventListener('click', () => { chrome.tabs.create({ url: 'http://127.0.0.1:5173' }); });
void refresh();
