const base = `http://localhost:${process.env.PORT || 8081}`;
try {
  const status = await fetch(base + '/api/status').then(r => r.json());
  console.log(JSON.stringify({ serviceAccountFound: status.serviceAccountFound, oauthFound: status.oauthFound,
    oauthKind: status.oauthKind, redirectConfigured: status.redirectConfigured, redirectUri: status.redirectUri, model: status.model, backend: status.backend }, null, 2));
  const response = await fetch(base + '/api/diagnose', { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf,
  }, body: '{}' });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || !result.gemini?.ok || !result.gmail?.ok || !result.threads?.ok) process.exitCode = 1;
} catch { console.error('Start the app with npm start before running diagnostics.'); process.exitCode = 1; }
