function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

export function renderLoginPage({
  client_id, client_name, redirect_uri,
  code_challenge, code_challenge_method,
  scope, state, resource, error
}) {
  const errorHtml = error ? `<p class="err">${esc(error)}</p>` : '';
  const label = client_name
    ? esc(client_name)
    : `client ${esc(String(client_id || '').slice(0, 8))}\u2026`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize · socialisn-studio</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .sub { color: #666; margin: 0 0 24px; font-size: 13px; }
  form { display: grid; gap: 12px; }
  label { display: grid; gap: 4px; font-size: 13px; color: #444; }
  input[type=password] { padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font: inherit; }
  button { padding: 10px 16px; background: #1a1a1a; color: white; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
  button:hover { background: #333; }
  .err { color: #c62828; margin: 0 0 16px; font-size: 14px; }
  .meta { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #888; line-height: 1.7; }
  .meta code { background: #f5f5f5; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
</style>
</head>
<body>
  <h1>Authorize ${label}</h1>
  <p class="sub">${label} wants to access <strong>socialisn-studio</strong>. Enter the admin password to grant access.</p>
  ${errorHtml}
  <form method="post" action="/authorize">
    <input type="hidden" name="client_id" value="${esc(client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}">
    <input type="hidden" name="scope" value="${esc(scope)}">
    <input type="hidden" name="state" value="${esc(state)}">
    <input type="hidden" name="resource" value="${esc(resource)}">
    <label>Password
      <input type="password" name="password" autocomplete="current-password" autofocus required>
    </label>
    <button type="submit">Authorize</button>
  </form>
  <div class="meta">
    Redirect after approval: <code>${esc(redirect_uri)}</code>
    ${scope ? `<br>Scope: <code>${esc(scope)}</code>` : ''}
    ${resource ? `<br>Resource: <code>${esc(resource)}</code>` : ''}
  </div>
</body>
</html>`;
}
