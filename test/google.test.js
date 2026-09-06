'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp, testConfig } = require('./helpers');
const { GoogleCalendar } = require('../src/integrations/google');

/**
 * Google de mentira: guarda o que foi pedido e responde o que o de verdade
 * responderia. Nenhum teste toca a rede.
 */
function googleFalso({ eventos = new Map(), falhas = {} } = {}) {
  const chamadas = [];
  let proximoId = 1;
  const resposta = (corpo, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(corpo),
  });

  const fetchFalso = async (url, options = {}) => {
    const metodo = options.method || 'GET';
    chamadas.push({ url, metodo, corpo: options.body ? tentarJson(options.body) : null });

    if (url.includes('oauth2.googleapis.com/token')) {
      const campos = new URLSearchParams(options.body);
      if (campos.get('grant_type') === 'authorization_code') {
        if (falhas.token) return resposta({ error: 'invalid_grant' }, 400);
        return resposta({
          access_token: 'tok-1', expires_in: 3600, refresh_token: falhas.semRefresh ? undefined : 'ref-1',
        });
      }
      return resposta({ access_token: 'tok-renovado', expires_in: 3600 });
    }
    if (url.includes('oauth2.googleapis.com/revoke')) return resposta({});
    if (url.includes('/users/me/calendarList/primary')) {
      return resposta({ id: 'consultorio@gmail.com', summary: 'Agenda do Dr. Exemplo' });
    }
    if (url.includes('/users/me/calendarList')) {
      return resposta({
        items: [
          { id: 'consultorio@gmail.com', summary: 'Principal', primary: true, accessRole: 'owner' },
          { id: 'feriados', summary: 'Feriados', accessRole: 'reader' },
        ],
      });
    }

    const eventoUrl = url.match(/\/calendars\/([^/]+)\/events(?:\/([^?]+))?/);
    if (eventoUrl) {
      const id = eventoUrl[2];
      if (metodo === 'POST') {
        const novo = { id: `ev-${proximoId += 1}`, ...tentarJson(options.body) };
        eventos.set(novo.id, novo);
        return resposta(novo);
      }
      if (metodo === 'PUT') {
        if (!eventos.has(id)) return resposta({ error: { message: 'Not Found' } }, 404);
        eventos.set(id, { id, ...tentarJson(options.body) });
        return resposta(eventos.get(id));
      }
      if (metodo === 'DELETE') {
        eventos.delete(id);
        return { ok: true, status: 204, text: async () => '' };
      }
      return resposta({ items: [...eventos.values()] });
    }
    return resposta({ error: { message: `sem rota falsa para ${url}` } }, 404);
  };

  return { fetchFalso, chamadas, eventos };
}

function tentarJson(texto) {
  try { return JSON.parse(texto); } catch { return String(texto); }
}

function montar(overrides) {
  const app = makeApp(overrides);
  const falso = googleFalso();
  app.google = new GoogleCalendar(app.store, testConfig(overrides), { fetchImpl: falso.fetchFalso });
  app.google.guardarCredenciais({ clientId: 'id-123', clientSecret: 'segredo' });
  return { app, falso };
}

async function conectar(app) {
  return app.google.conectar('http://localhost:3000/api/google/callback?code=abc123&scope=calendar');
}

// ---------- conexão ----------

test('o código é lido tanto da URL colada quanto puro', () => {
  const daUrl = GoogleCalendar.extrairCodigo(
    'http://localhost:3000/api/google/callback?code=4%2F0Ab_teste&scope=https://www.googleapis.com/auth/calendar',
  );
  assert.strictEqual(daUrl, '4/0Ab_teste');
  assert.strictEqual(GoogleCalendar.extrairCodigo('  4/0Ab_teste  '), '4/0Ab_teste');
  assert.strictEqual(GoogleCalendar.extrairCodigo(''), '');
});

test('sem credenciais não há para onde mandar o médico', () => {
  const app = makeApp();
  const google = new GoogleCalendar(app.store, testConfig());
  assert.throws(() => google.urlDeAutorizacao(), /ID e a chave/);
});

test('a URL de consentimento pede acesso de longo prazo', () => {
  const { app } = montar();
  const url = new URL(app.google.urlDeAutorizacao());
  assert.strictEqual(url.searchParams.get('access_type'), 'offline');
  assert.strictEqual(url.searchParams.get('prompt'), 'consent');
  assert.strictEqual(url.searchParams.get('client_id'), 'id-123');
  assert.match(url.searchParams.get('scope'), /auth\/calendar$/);
});

test('conectar guarda a conta e nunca devolve o segredo', async () => {
  const { app } = montar();
  const estado = await conectar(app);

  assert.strictEqual(estado.conectado, true);
  assert.strictEqual(estado.enabled, true);
  assert.strictEqual(estado.conta, 'consultorio@gmail.com');
  assert.strictEqual(estado.calendarId, 'consultorio@gmail.com');
  assert.ok(!('clientSecret' in estado), 'o segredo não pode sair para o painel');
  assert.ok(!('refreshToken' in estado));
});

test('autorização sem refresh token é recusada com instrução', async () => {
  const app = makeApp();
  const falso = googleFalso({ falhas: { semRefresh: true } });
  const google = new GoogleCalendar(app.store, testConfig(), { fetchImpl: falso.fetchFalso });
  google.guardarCredenciais({ clientId: 'id', clientSecret: 's' });
  await assert.rejects(() => google.conectar('code=x'), /longo prazo/);
  assert.strictEqual(google.estado().conectado, false);
});

test('desconectar revoga o acesso, não só apaga daqui', async () => {
  const { app, falso } = montar();
  await conectar(app);
  await app.google.desconectar();

  assert.ok(falso.chamadas.some((c) => c.url.includes('/revoke')), 'precisa chamar o revoke do Google');
  const estado = app.google.estado();
  assert.strictEqual(estado.conectado, false);
  assert.strictEqual(estado.enabled, false);
});

// ---------- consulta vira evento ----------

test('consulta marcada vira evento, remarcada atualiza e cancelada some', async () => {
  const { app, falso } = montar();
  await conectar(app);

  const paciente = app.store.upsertContact('5511900330001', 'Marina');
  const prof = app.store.clinic.professionals[0];
  const servico = app.store.clinic.services[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id, serviceId: servico.id })[0];
  const booking = app.agenda.book(paciente.id, {
    professionalId: prof.id, serviceId: servico.id, date: dia.date, start: dia.slots[0].start,
  });

  await app.google.sincronizar(booking);
  assert.ok(booking.googleEventId, 'a consulta precisa guardar o id do evento');
  const evento = falso.eventos.get(booking.googleEventId);
  assert.match(evento.summary, /Marina/);
  assert.match(evento.description, /5511900330001/);
  assert.strictEqual(evento.extendedProperties.private.consultaId, booking.id);

  booking.confirmation = 'confirmado';
  await app.google.sincronizar(booking);
  assert.strictEqual(falso.eventos.size, 1, 'atualizar não pode criar um segundo evento');
  assert.match(falso.eventos.get(booking.googleEventId).description, /confirmada/);

  app.agenda.cancel(booking.id, 'teste');
  await app.google.sincronizar(booking);
  assert.strictEqual(falso.eventos.size, 0, 'consulta cancelada sai do calendário');
});

test('evento apagado à mão no Google é recriado, sem derrubar nada', async () => {
  const { app, falso } = montar();
  await conectar(app);
  const paciente = app.store.upsertContact('5511900330002', 'Paulo');
  const prof = app.store.clinic.professionals[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id })[0];
  const booking = app.agenda.book(paciente.id, {
    professionalId: prof.id, serviceId: app.store.clinic.services[0].id,
    date: dia.date, start: dia.slots[0].start,
  });

  await app.google.sincronizar(booking);
  falso.eventos.clear();                       // alguém apagou pelo celular

  await app.google.sincronizar(booking);       // 404 no PUT
  assert.strictEqual(booking.googleEventId, undefined);
  await app.google.sincronizar(booking);       // recria
  assert.strictEqual(falso.eventos.size, 1);
});

test('desligado, o Google não recebe nada', async () => {
  const { app, falso } = montar();
  await conectar(app);
  app.google.ligar(false);

  const paciente = app.store.upsertContact('5511900330003', 'Rita');
  const prof = app.store.clinic.professionals[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id })[0];
  const booking = app.agenda.book(paciente.id, {
    professionalId: prof.id, serviceId: app.store.clinic.services[0].id,
    date: dia.date, start: dia.slots[0].start,
  });
  await app.google.sincronizar(booking);

  assert.strictEqual(falso.eventos.size, 0);
  assert.strictEqual(booking.googleEventId, undefined);
});

test('erro do Google não derruba a consulta, vira aviso no painel', async () => {
  const app = makeApp();
  const google = new GoogleCalendar(app.store, testConfig(), {
    fetchImpl: async (url, options) => {
      if (url.includes('/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 3600, refresh_token: 'r' }) };
      }
      if (url.includes('calendarList')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'a@b.com' }) };
      }
      if ((options.method || 'GET') === 'POST') {
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'Backend error' } }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  google.guardarCredenciais({ clientId: 'id', clientSecret: 's' });
  await google.conectar('code=x');

  const paciente = app.store.upsertContact('5511900330004', 'Ana');
  const prof = app.store.clinic.professionals[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id })[0];
  const booking = app.agenda.book(paciente.id, {
    professionalId: prof.id, serviceId: app.store.clinic.services[0].id,
    date: dia.date, start: dia.slots[0].start,
  });

  await google.sincronizar(booking);           // não lança
  assert.match(google.estado().lastError, /Backend error/);
  assert.strictEqual(app.store.getBooking(booking.id).status, 'confirmado');
});

// ---------- o caminho de volta ----------

test('compromisso do médico no Google deixa de ser oferecido ao paciente', async () => {
  const { app } = montar();
  await conectar(app);
  const prof = app.store.clinic.professionals[0];
  const servico = app.store.clinic.services[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id, serviceId: servico.id })[0];

  app.agenda.ocupadosExternos = (data, profId) => app.google.ocupadosEm(data, profId);
  const antes = app.agenda.slotsFor(dia.date, { professionalId: prof.id, serviceId: servico.id }).length;

  app.google.bloquearOcupados(true);
  app.google.ocupados.set(dia.date, [{ start: '00:00', end: '23:59' }]);
  const depois = app.agenda.slotsFor(dia.date, { professionalId: prof.id, serviceId: servico.id }).length;

  assert.ok(antes > 0);
  assert.strictEqual(depois, 0, 'dia inteiro ocupado no Google não tem horário livre');

  // Com a conexão amarrada a outro médico, a agenda deste continua livre.
  app.google.escolherProfissional('outro-medico');
  const deOutro = app.agenda.slotsFor(dia.date, { professionalId: prof.id, serviceId: servico.id }).length;
  assert.strictEqual(deOutro, antes);
});

test('eventos criados pelo próprio painel não viram bloqueio duplicado', async () => {
  const { app } = montar();
  await conectar(app);
  app.google.bloquearOcupados(true);

  const inicio = new Date(Date.now() + 3600000).toISOString();
  const fim = new Date(Date.now() + 7200000).toISOString();
  app.google.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      items: [
        {
          id: 'ev-do-painel', start: { dateTime: inicio }, end: { dateTime: fim },
          extendedProperties: { private: { consultaId: 'abc' } },
        },
        { id: 'livre', start: { dateTime: inicio }, end: { dateTime: fim }, transparency: 'transparent' },
        { id: 'reuniao', start: { dateTime: inicio }, end: { dateTime: fim } },
      ],
    }),
  });
  app.google.tokenCache = { token: 't', expiraEm: Date.now() + 600000 };

  const mapa = await app.google.atualizarOcupados();
  const total = [...mapa.values()].reduce((t, faixas) => t + faixas.length, 0);
  assert.strictEqual(total, 1, 'só a reunião de verdade vira bloqueio');
});

// ---------- painel ----------

async function painelComGoogle() {
  const app = makeApp();
  const falso = googleFalso();
  app.google = new GoogleCalendar(app.store, testConfig(), { fetchImpl: falso.fetchFalso });
  const { createServer } = require('../src/server');
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  let cookie = null;
  const chamar = async (caminho, options = {}) => {
    const res = await fetch(base + caminho, {
      ...options,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const enviado = res.headers.get('set-cookie');
    if (enviado) cookie = enviado.split(';')[0];
    const texto = await res.text();
    let corpo = {};
    try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { html: texto }; }
    return { status: res.status, corpo };
  };
  await chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });
  return { app, falso, chamar, fechar: () => new Promise((r) => http.close(r)) };
}

test('o painel guarda as credenciais e devolve a URL do Google', async () => {
  const { chamar, fechar } = await painelComGoogle();

  const semNada = await chamar('/api/google/autorizar');
  assert.strictEqual(semNada.status, 400, 'sem credenciais não dá para autorizar');

  const salvo = await chamar('/api/google', {
    method: 'PUT',
    body: { clientId: 'id-do-consultorio', clientSecret: 'segredo-do-consultorio' },
  });
  assert.strictEqual(salvo.corpo.configurado, true);
  assert.ok(!JSON.stringify(salvo.corpo).includes('segredo-do-consultorio'));

  const autorizar = await chamar('/api/google/autorizar');
  assert.match(autorizar.corpo.url, /accounts\.google\.com/);
  assert.match(autorizar.corpo.url, /id-do-consultorio/);

  await fechar();
});

test('conectar pelo painel manda as consultas futuras que já existiam', async () => {
  const { app, falso, chamar, fechar } = await painelComGoogle();
  await chamar('/api/google', { method: 'PUT', body: { clientId: 'id', clientSecret: 's' } });

  const paciente = app.store.upsertContact('5511900330005', 'Bia');
  const prof = app.store.clinic.professionals[0];
  const dia = app.agenda.nextAvailableDays(1, { professionalId: prof.id })[0];
  app.agenda.book(paciente.id, {
    professionalId: prof.id, serviceId: app.store.clinic.services[0].id,
    date: dia.date, start: dia.slots[0].start,
  });

  const conectado = await chamar('/api/google/conectar', { method: 'POST', body: { codigo: 'code=xyz' } });
  assert.strictEqual(conectado.status, 200);
  assert.strictEqual(conectado.corpo.conectado, true);
  assert.strictEqual(conectado.corpo.enviadas, 1, 'a consulta que já existia sobe na conexão');
  assert.strictEqual(falso.eventos.size, 1);

  await fechar();
});

test('o estado do painel mostra o Google sem vazar segredo nenhum', async () => {
  const { chamar, fechar } = await painelComGoogle();
  await chamar('/api/google', { method: 'PUT', body: { clientId: 'id', clientSecret: 'nao-pode-vazar' } });
  await chamar('/api/google/conectar', { method: 'POST', body: { codigo: 'code=xyz' } });

  const estado = await chamar('/api/state');
  assert.strictEqual(estado.corpo.google.conectado, true);
  assert.strictEqual(estado.corpo.google.conta, 'consultorio@gmail.com');
  assert.ok(!JSON.stringify(estado.corpo).includes('nao-pode-vazar'));
  assert.ok(!JSON.stringify(estado.corpo).includes('ref-1'), 'o refresh token não sai daqui');

  await fechar();
});

test('sem sessão ninguém mexe na integração', async () => {
  const app = makeApp();
  const falso = googleFalso();
  app.google = new GoogleCalendar(app.store, testConfig(), { fetchImpl: falso.fetchFalso });
  const { createServer } = require('../src/server');
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  for (const caminho of ['/api/google', '/api/google/autorizar', '/api/google/callback?code=x']) {
    const res = await fetch(base + caminho, { redirect: 'manual' });
    assert.strictEqual(res.status, 401, `${caminho} precisa de sessão`);
  }
  await new Promise((r) => http.close(r));
});
