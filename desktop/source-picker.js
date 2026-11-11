const list = document.querySelector('#sources');
const status = document.querySelector('#status');
document.querySelector('#cancel').addEventListener('click', () => window.capturePicker.choose(null));
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.capturePicker.choose(null); });
window.capturePicker.sources().then(sources => {
  if (!sources.length) { status.textContent = 'No screens are available. Check screen recording permission in system settings.'; return; }
  for (const source of sources) {
    const button = document.createElement('button'); button.className = 'source'; button.type = 'button';
    const image = document.createElement('img'); image.src = source.thumbnail; image.alt = '';
    const name = document.createElement('span'); name.textContent = source.name;
    button.append(image, name); button.addEventListener('click', () => window.capturePicker.choose(source.id)); list.append(button);
  }
  list.querySelector('button')?.focus();
}).catch(() => { status.textContent = 'Screens could not be loaded. Close this window and try again.'; });
