'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');
const { DAY_MS } = require('../src/core/reminders');

async function painel(overrides) {
  const app = makeApp(overrides);
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  let cookie = null;
  const chamar = async (caminho, options = {}) => {
    const res = await fetch(base + caminho, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const enviado = res.headers.get('set-cookie');
    if (enviado) cookie = enviado.split(';')[0];
    return { status: res.status, corpo: await res.json().catch(() => ({})) };
  };
  await chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });
  return { app, chamar, fechar: () => new Promise((r) => http.close(r)) };
}

function marcarConsulta(app, phone, nome, emDias) {
  const paciente = app.store.upsertContact(phone, nome);
  const startsAt = new Date(Date.now() + emDias * DAY_MS);
  const booking = app.store.addBooking({
    contactId: paciente.id,
    professionalId: 'dr-exemplo',
    professionalName: 'Dr. Exemplo Silva',
    serviceId: 'primeira-consulta',
    serviceName: 'Primeira consulta',
    date: startsAt.toISOString().slice(0, 10),
    start: '09:00',
    end: '09:40',
    startsAt: startsAt.toISOString(),
  });
  return { paciente, booking };
}

test('sem nada configurado, o paciente recebe todos os lembretes', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900660001', 'Marina');

  assert.strictEqual(app.reminders.permitido(paciente, 'followup', 7), true);
  assert.strictEqual(app.reminders.permitido(paciente, 'booking', 1), true);
  assert.strictEqual(app.reminders.permitido(paciente, 'retorno'), true);

  const criados = app.reminders.scheduleFollowUps(paciente);
  assert.deepStrictEqual(criados.map((r) => r.offsetDays), [1, 7, 15]);
});

test('desmarcar um prazo tira só ele, e só desse paciente', async () => {
  const { app, chamar, fechar } = await painel();
  const marina = app.store.upsertContact('5511900660002', 'Marina');
  const paulo = app.store.upsertContact('5511900660003', 'Paulo');

  const { corpo } = await chamar(`/api/contacts/${marina.id}/lembretes`, {
    method: 'PUT', body: { desligados: ['followup:7', 'booking:3'] },
  });
  assert.deepStrictEqual(corpo.desligados, ['followup:7', 'booking:3']);

  const dela = app.reminders.scheduleFollowUps(marina);
  assert.deepStrictEqual(dela.map((r) => r.offsetDays), [1, 15], 'o toque de 7 dias não é criado');

  const dele = app.reminders.scheduleFollowUps(paulo);
  assert.deepStrictEqual(dele.map((r) => r.offsetDays), [1, 7, 15], 'o outro paciente não muda');

  const consulta = marcarConsulta(app, '5511900660002', 'Marina', 20);
  const antes = app.reminders.scheduleBookingReminders(consulta.booking);
  assert.deepStrictEqual(antes.filter((r) => r.kind === 'booking').map((r) => r.offsetDays), [7, 1]);

  await fechar();
});

test('desmarcar cancela o que já estava na fila', async () => {
  const { app, chamar, fechar } = await painel();
  const { paciente, booking } = marcarConsulta(app, '5511900660004', 'Rita', 20);
  app.reminders.scheduleBookingReminders(booking);

  const pendentes = () => app.store.state.reminders
    .filter((r) => r.contactId === paciente.id && r.status === 'pending');
  assert.ok(pendentes().some((r) => r.kind === 'booking' && r.offsetDays === 7));

  const { corpo } = await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT', body: { desligados: ['booking:7'] },
  });
  assert.strictEqual(corpo.cancelados, 1);
  assert.ok(!pendentes().some((r) => r.kind === 'booking' && r.offsetDays === 7));
  assert.ok(pendentes().some((r) => r.kind === 'booking' && r.offsetDays === 3), 'os outros ficam');

  await fechar();
});

test('lembrete desligado não sai nem se já estivesse agendado', async () => {
  const app = makeApp();
  const { paciente, booking } = marcarConsulta(app, '5511900660005', 'Bia', 1.5);
  app.reminders.scheduleBookingReminders(booking);

  paciente.lembretesDesligados = ['booking:1'];
  const enviados = await app.reminders.tick(new Date(Date.now() + DAY_MS));

  assert.strictEqual(enviados, 0, 'a véspera não é enviada');
  assert.strictEqual(app.sent.length, 0);
});

test('marcar de novo volta a valer nos próximos', async () => {
  const { app, chamar, fechar } = await painel();
  const paciente = app.store.upsertContact('5511900660006', 'Nara');

  await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT', body: { desligados: ['followup:1', 'followup:7', 'followup:15'] },
  });
  assert.strictEqual(app.reminders.scheduleFollowUps(paciente).length, 0);

  const voltou = await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT', body: { desligados: [] },
  });
  assert.deepStrictEqual(voltou.corpo.desligados, []);
  assert.strictEqual(app.reminders.scheduleFollowUps(paciente).length, 3);

  await fechar();
});

test('retorno, falta, check-in e toque do meio também obedecem', async () => {
  const app = makeApp();
  const { paciente, booking } = marcarConsulta(app, '5511900660007', 'Otto', -1);
  paciente.lembretesDesligados = ['retorno', 'falta', 'pos_consulta', 'espera'];

  assert.strictEqual(app.reminders.scheduleReturnReminder(booking), null);
  assert.strictEqual(app.reminders.scheduleNoShowReminder(booking), null);

  const futura = marcarConsulta(app, '5511900660007', 'Otto', 30);
  assert.strictEqual(app.reminders.scheduleCheckIn(futura.booking), null);
  const criados = app.reminders.scheduleBookingReminders(futura.booking);
  assert.strictEqual(criados.filter((r) => r.kind === 'espera').length, 0);
});

test('a lista é validada e o disparo da recepção não é afetado', async () => {
  const { app, chamar, fechar } = await painel();
  const paciente = app.store.upsertContact('5511900660008', 'Ivo');

  const ruim = await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT', body: { desligados: 'followup' },
  });
  assert.strictEqual(ruim.status, 400);

  await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT',
    body: { desligados: ['followup:7', 'followup:7', '<script>', 'booking:99999999'] },
  });
  assert.deepStrictEqual(app.store.getContact(paciente.id).lembretesDesligados, ['followup:7'],
    'repetido, lixo e número absurdo ficam de fora');

  // Campanha é decisão do disparo, com opt-out próprio: não entra nesta conta.
  const campanha = app.store.addReminder({
    contactId: paciente.id, kind: 'campanha', dueAt: new Date(Date.now() - 1000).toISOString(),
    body: 'Aviso da recepção',
  });
  paciente.lembretesDesligados = ['campanha'];
  assert.strictEqual(app.reminders.aindaVale(campanha), true);

  await fechar();
});

test('a ficha do paciente no painel mostra o que está desligado', async () => {
  const { app, chamar, fechar } = await painel();
  const paciente = app.store.upsertContact('5511900660009', 'Lia');
  await chamar(`/api/contacts/${paciente.id}/lembretes`, {
    method: 'PUT', body: { desligados: ['booking:3'] },
  });

  const { corpo } = await chamar('/api/state');
  const naTela = corpo.contacts.find((c) => c.id === paciente.id);
  assert.deepStrictEqual(naTela.lembretesDesligados, ['booking:3']);
  assert.ok(app.store.state.events.some((e) => /1 lembrete\(s\) desligado/.test(e.text)));

  await fechar();
});
