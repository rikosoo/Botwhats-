'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');

const AGENDAR = ['oi', 'quero marcar', 'primeira consulta', 'unimed', '1', '1', '1', 'Maria Souza', '12/05/1980', 'sim'];

test('segmenta quem já entrou em contato, com e sem consulta', async () => {
  const app = makeApp();
  await app.conversa('5511900000001', AGENDAR);                 // agendou
  await app.conversa('5511900000002', ['oi', 'quanto custa?']); // só perguntou
  app.store.upsertContact('5511900000003', 'Cadastro manual');  // nunca escreveu

  const contatos = app.broadcast.segmentar('contatos').map((c) => c.phone);
  assert.deepStrictEqual(contatos.sort(), ['5511900000001', '5511900000002']);

  const semConsulta = app.broadcast.segmentar('sem_consulta').map((c) => c.phone);
  assert.deepStrictEqual(semConsulta, ['5511900000002']);

  const agendados = app.broadcast.segmentar('agendados').map((c) => c.phone);
  assert.deepStrictEqual(agendados, ['5511900000001']);

  assert.strictEqual(app.broadcast.segmentar('todos').length, 3);
});

test('segmenta faltas e pacientes já atendidos', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900000010', 'Rita Alves');
  const consulta = app.store.addBooking({
    contactId: paciente.id, professionalId: 'dr-exemplo', serviceId: 'retorno',
    date: '2026-09-01', start: '09:00', end: '09:20', startsAt: '2026-09-01T12:00:00.000Z',
  });

  consulta.attendance = 'faltou';
  assert.deepStrictEqual(app.broadcast.segmentar('faltaram').map((c) => c.id), [paciente.id]);
  assert.strictEqual(app.broadcast.segmentar('atendidos').length, 0);

  consulta.attendance = 'compareceu';
  assert.deepStrictEqual(app.broadcast.segmentar('atendidos').map((c) => c.id), [paciente.id]);
});

test('preencher variáveis com os dados do paciente', async () => {
  const app = makeApp();
  await app.conversa('5511900000004', AGENDAR);
  const paciente = app.store.findContactByPhone('5511900000004');

  const texto = app.broadcast.personalizar(
    'Oi {primeiro_nome}, sua consulta é {data_consulta} às {hora_consulta} com {medico}. — {consultorio}',
    paciente,
  );
  assert.match(texto, /^Oi Maria,/);
  assert.match(texto, /às \d{2}:\d{2} com Dr\. Exemplo Silva/);
  assert.match(texto, /Consultorio Dr\. Exemplo$/);
});

test('opt-out e número repetido ficam de fora do disparo', async () => {
  const app = makeApp();
  await app.conversa('5511900000005', ['oi']);
  await app.conversa('5511900000006', ['oi', 'não quero mais receber mensagens']);
  const a = app.store.findContactByPhone('5511900000005');
  const b = app.store.findContactByPhone('5511900000006');

  const previa = app.broadcast.previa([a.id, a.id, b.id, 'inexistente'], 'Olá!');
  assert.strictEqual(previa.total, 1);
  assert.deepStrictEqual(
    previa.ignorados.map((i) => i.motivo).sort(),
    ['não encontrado', 'número repetido', 'pediu para não receber'],
  );
});

test('disparo imediato envia para todo mundo do segmento', async () => {
  const app = makeApp({ broadcastDelayMs: 0 });
  await app.conversa('5511900000007', ['oi']);
  await app.conversa('5511900000008', ['oi']);
  app.sent.length = 0;

  const ids = app.broadcast.segmentar('contatos').map((c) => c.id);
  const campanha = app.broadcast.criar({ contactIds: ids, texto: 'Oi {primeiro_nome}! Estamos com agenda aberta.' });
  await app.emAndamentoDoDisparo();

  assert.strictEqual(campanha.status, 'concluído');
  assert.strictEqual(campanha.sent, 2);
  assert.strictEqual(app.sent.length, 2);
  assert.match(app.sent[0].text, /agenda aberta/);
  // A mensagem enviada fica no histórico da conversa.
  assert.ok(app.store.state.messages.some((m) => m.direction === 'out' && /agenda aberta/.test(m.body)));
});

test('disparo recusa texto vazio, lista vazia e estouro do limite', async () => {
  const app = makeApp({ broadcastMaxRecipients: 1 });
  await app.conversa('5511900000011', ['oi']);
  await app.conversa('5511900000012', ['oi']);
  const ids = app.broadcast.segmentar('contatos').map((c) => c.id);

  assert.throws(() => app.broadcast.criar({ contactIds: ids, texto: '  ' }), /Escreva a mensagem/);
  assert.throws(() => app.broadcast.criar({ contactIds: [], texto: 'Oi' }), /Nenhum destinatário/);
  assert.throws(() => app.broadcast.criar({ contactIds: ids, texto: 'Oi' }), /limite de 1 destinatários/);
});

test('disparo agendado só sai na hora marcada', async () => {
  const app = makeApp({ broadcastDelayMs: 0 });
  await app.conversa('5511900000009', ['oi']);
  app.sent.length = 0;

  const ids = app.broadcast.segmentar('contatos').map((c) => c.id);
  const quando = new Date(Date.now() + 3600000);
  app.broadcast.criar({ contactIds: ids, texto: 'Feriado: não abriremos amanhã.', scheduledAt: quando.toISOString() });

  assert.strictEqual(app.sent.length, 0, 'nada sai antes da hora');
  assert.strictEqual(await app.reminders.tick(), 0);

  await app.reminders.tick(new Date(Date.now() + 3700000));
  assert.strictEqual(app.sent.length, 1);
  assert.match(app.sent[0].text, /Feriado/);
});
