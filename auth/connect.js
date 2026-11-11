const params = new URLSearchParams(window.location.search);
const state = params.get('state');
const form = document.querySelector('form');
const error = document.querySelector('#error');
const valid = window.top === window.self && params.getAll('state').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state || '') && !window.location.hash;
const showError = message => { error.textContent = message; error.hidden = false; };

window.history.replaceState({}, '', window.location.pathname);
if (!valid) {
  showError('Open ApplyTrack and choose Connect Gmail to start a new connection.');
} else {
  document.querySelector('#state').value = state;
  form.hidden = false;
  if (params.has('error')) showError('Sign-in could not be confirmed. Use the same ApplyTrack account as the app, or start a new connection.');
  form.addEventListener('submit', () => {
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Connecting…';
  });
}
