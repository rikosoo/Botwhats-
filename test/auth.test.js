'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');
const { validarSenha } = require('../src/core/auth');

/** Sobe o painel numa porta livre e devolve um cliente com cookie de sessão. */
async function subirPainel(overrides) {
  const app = makeApp(overrides);
  const { server } = createServer(app);
  const http = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${http.address().port}`;
  let cookie = null;

  const chamar = async (caminho, options = {}) => {
    const res = await fetch(base + caminho, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const enviado = res.headers.get('set-cookie');
    if (enviado) cookie = enviado.split(';')[0];
    const corpo = await res.json().catch(() => ({}));
    return { status: res.status, corpo };
  };

  return { app, chamar, fechar: () => new Promise((r) => http.close(r)), get cookie() { return cookie; } };
}

test('a API dos pacientes não responde sem login', async () => {
  const painel = await subirPainel();
  try {
    for (const rota of ['/api/state', '/api/metrics', '/api/clinic']) {
      const { status } = await painel.chamar(rota);
      assert.strictEqual(status, 401, `${rota} deveria exigir login`);
    }
    // Simular mensagem também é ação privilegiada.
    const envio = await painel.chamar('/api/simulate', {
      method: 'POST', body: { phone: '5511999999999', body: 'oi' },
    });
    assert.strictEqual(envio.status, 401);
  } finally {
    await painel.fechar();
  }
});

test('o ping de monitoramento não conta nada sobre pacientes', async () => {
  const painel = await subirPainel();
  try {
    const { status, corpo } = await painel.chamar('/api/ping');
    assert.strictEqual(status, 200);
    assert.strictEqual(corpo.ok, true);
    assert.ok(!('pacientes' in corpo));
  } finally {
    await painel.fechar();
  }
});

test('login com o usuário padrão abre a sessão', async () => {
  const painel = await subirPainel();
  try {
    const errado = await painel.chamar('/api/login', {
      method: 'POST', body: { username: 'Henrique', password: 'errada' },
    });
    assert.strictEqual(errado.status, 401);
    assert.match(errado.corpo.error, /Usuário ou senha incorretos/);

    const certo = await painel.chamar('/api/login', {
      method: 'POST', body: { username: 'Henrique', password: 'Henrique123' },
    });
    assert.strictEqual(certo.status, 200);
    assert.strictEqual(certo.corpo.user.username, 'Henrique');
    assert.strictEqual(certo.corpo.user.mustChangePassword, true, 'avisa que a senha é a padrão');

    const estado = await painel.chamar('/api/state');
    assert.strictEqual(estado.status, 200);
    assert.ok(Array.isArray(estado.corpo.contacts));
  } finally {
    await painel.fechar();
  }
});

test('sair encerra a sessão', async () => {
  const painel = await subirPainel();
  try {
    await painel.chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });
    await painel.chamar('/api/logout', { method: 'POST' });
    const { status } = await painel.chamar('/api/state');
    assert.strictEqual(status, 401);
  } finally {
    await painel.fechar();
  }
});

test('trocar a senha exige a atual e derruba as sessões abertas', async () => {
  const painel = await subirPainel();
  try {
    await painel.chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });

    const semAtual = await painel.chamar('/api/account/password', {
      method: 'POST', body: { currentPassword: 'chute', newPassword: 'novaSenha1' },
    });
    assert.strictEqual(semAtual.status, 400);
    assert.match(semAtual.corpo.error, /senha atual não confere/i);

    const fraca = await painel.chamar('/api/account/password', {
      method: 'POST', body: { currentPassword: 'Henrique123', newPassword: 'curta' },
    });
    assert.match(fraca.corpo.error, /8 caracteres/);

    const ok = await painel.chamar('/api/account/password', {
      method: 'POST', body: { currentPassword: 'Henrique123', newPassword: 'consultorio2026' },
    });
    assert.strictEqual(ok.status, 200);

    // A sessão anterior deixa de valer.
    const depois = await painel.chamar('/api/state');
    assert.strictEqual(depois.status, 401);

    const novoLogin = await painel.chamar('/api/login', {
      method: 'POST', body: { username: 'Henrique', password: 'consultorio2026' },
    });
    assert.strictEqual(novoLogin.status, 200);
    assert.strictEqual(novoLogin.corpo.user.mustChangePassword, false, 'o aviso de senha padrão some');
  } finally {
    await painel.fechar();
  }
});

test('a senha não fica guardada em texto puro', async () => {
  const painel = await subirPainel();
  try {
    const usuario = painel.app.store.state.users[0];
    assert.ok(usuario.hash && usuario.salt);
    assert.ok(!JSON.stringify(usuario).includes('Henrique123'));
  } finally {
    await painel.fechar();
  }
});

test('o token da sessão é guardado como hash, não em claro', async () => {
  const painel = await subirPainel();
  try {
    await painel.chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });
    const token = decodeURIComponent(painel.cookie.split('=')[1]);
    const sessao = painel.app.store.state.sessions[0];
    assert.ok(sessao.tokenHash);
    assert.notStrictEqual(sessao.tokenHash, token);
    assert.ok(!JSON.stringify(sessao).includes(token));
  } finally {
    await painel.fechar();
  }
});

test('tentativas repetidas travam o usuário por um tempo', async () => {
  const painel = await subirPainel({ maxLoginAttempts: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      await painel.chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'x' } });
    }
    const travado = await painel.chamar('/api/login', {
      method: 'POST', body: { username: 'Henrique', password: 'Henrique123' },
    });
    assert.strictEqual(travado.status, 401);
    assert.match(travado.corpo.error, /Muitas tentativas/);
  } finally {
    await painel.fechar();
  }
});

test('regras de senha', () => {
  assert.match(validarSenha('curta'), /8 caracteres/);
  assert.match(validarSenha('semnumeros'), /letras e números/);
  assert.strictEqual(validarSenha('consultorio2026'), null);
});
