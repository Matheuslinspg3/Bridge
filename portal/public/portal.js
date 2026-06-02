// Portal frontend helpers
function getToken() {
  return localStorage.getItem('portal_token') || '';
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// Logout
document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      localStorage.removeItem('portal_token');
      await fetch('/portal/logout', { method: 'POST' });
      window.location.href = '/portal/login.html';
    });
  }
});
