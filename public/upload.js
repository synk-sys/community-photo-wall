const form = document.querySelector('#upload-form');
const status = document.querySelector('#upload-status');
const button = form.querySelector('button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.className = 'status';
  status.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/photos', { method: 'POST', body: new FormData(form) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    status.className = 'status success';
    status.textContent = body.message;
    form.reset();
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'Upload failed. Please try again.';
  } finally {
    button.disabled = false;
  }
});
