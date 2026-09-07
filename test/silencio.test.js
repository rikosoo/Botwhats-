'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');
const { WhatsAppWebChannel } = require('../src/channels/whatsappWeb');

const MIN = 60000;

/** Canal com a conexão já feita no instante informado, sem subir o Chrome. */
function canalConectado(config = {}, conectadoEm = Date.now()) {
  const canal = new WhatsAppWebChannel({ connectQuietSeconds: 300, ignoreOlderThanMinutes: 10, ...config });
  canal.pronto = true;
  canal.conectadoEm = conectadoEm;
  canal.silencioAte = conectadoEm + canal.janelaDeSilencioMs();
  return canal;
}

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

// ---------- silêncio depois de conectar ----------

test('nos cinco minutos seguintes à conexão nada é respondido', () => {
  const conexao = Date.now();
  const canal = canalConectado({}, conexao);

  // A fila não chega de uma vez: estas chegam em levas, minutos depois.
  for (const minuto of [0, 1, 2.5, 4.9]) {
    const quando = conexao + minuto * MIN;
    const { antiga, motivo } = canal.classificar(quando, quando);
    assert.strictEqual(antiga, true, `mensagem de ${minuto} min ainda cai no silêncio`);
    assert.strictEqual(motivo, 'silencio pos-conexao');
  }

  // Passados os cinco minutos, o atendimento volta ao normal sozinho.
  const depois = conexao + 5.1 * MIN;
  assert.deepStrictEqual(canal.classificar(depois, depois), { antiga: false, motivo: null });
});

test('mensagem escrita antes da conexão nunca recebe resposta automática', () => {
  const conexao = Date.now();
  const canal = canalConectado({}, conexao);
  const depoisDoSilencio = conexao + 6 * MIN;

  // Esta é a que escapava: recente o bastante para o filtro de 10 minutos,
  // entregue depois da janela de silêncio — mas escrita antes de conectar.
  const antesDeConectar = canal.classificar(conexao - 3 * MIN, depoisDoSilencio);
  assert.strictEqual(antesDeConectar.antiga, true);
  assert.strictEqual(antesDeConectar.motivo, 'anterior a conexao');

  // E a de semanas atrás segue barrada pela idade.
  const velha = canal.classificar(conexao - 20 * 24 * 60 * MIN, depoisDoSilencio);
  assert.strictEqual(velha.antiga, true);
});

test('relógio atrasado do aparelho não silencia paciente de verdade', () => {
  const conexao = Date.now();
  const canal = canalConectado({}, conexao);
  const agora = conexao + 6 * MIN;

  // Celular um minuto atrasado: a mensagem é nova, só parece antiga.
  const nova = canal.classificar(agora - MIN, agora);
  assert.deepStrictEqual(nova, { antiga: false, motivo: null });
});

test('a recepção pode encerrar o silêncio antes da hora', () => {
  const conexao = Date.now();
  const canal = canalConectado({}, conexao);
  assert.ok(canal.silencioRestante(conexao) > 290, 'começa com quase cinco minutos');

  canal.encerrarSilencio();
  assert.strictEqual(canal.emSilencio(conexao), false);
  assert.strictEqual(canal.silencioRestante(conexao), 0);
  assert.deepStrictEqual(canal.classificar(conexao, conexao), { antiga: false, motivo: null });
});

test('a janela vem do painel, não só do .env', () => {
  const canal = new WhatsAppWebChannel({ connectQuietSeconds: 300 });
  assert.strictEqual(canal.janelaDeSilencioMs(), 5 * MIN);

  let minutos = 12;
  canal.definirJanelaDeSilencio(() => minutos * MIN);
  assert.strictEqual(canal.janelaDeSilencioMs(), 12 * MIN);

  minutos = 0;                       // desligado é uma escolha válida
  assert.strictEqual(canal.janelaDeSilencioMs(), 0);
  const canalSemSilencio = canalConectado({ connectQuietSeconds: 0 });
  assert.strictEqual(canalSemSilencio.emSilencio(), false);
});

test('desconectar zera a janela, e conectar de novo abre outra', () => {
  const canal = canalConectado();
  canal.silencioAte = null;                 // o que o evento "disconnected" faz
  assert.strictEqual(canal.emSilencio(), false);

  const novaConexao = Date.now() + 60 * MIN;
  canal.conectadoEm = novaConexao;
  canal.silencioAte = novaConexao + canal.janelaDeSilencioMs();
  assert.strictEqual(canal.emSilencio(novaConexao), true, 'cada conexão tem seu silêncio');
});

test('o painel mostra quanto falta e sabe encerrar', async () => {
  const { app, chamar, fechar } = await painel();
  const conexao = Date.now();
  Object.assign(app.channel, {
    silencioRestante: () => Math.max(0, Math.ceil((conexao + 5 * MIN - Date.now()) / 1000)),
    encerrarSilencio() { this.silencioRestante = () => 0; },
  });

  const antes = await chamar('/api/whatsapp');
  assert.ok(antes.corpo.silencioRestante > 280, 'a recepção vê o tempo que falta');

  const encerrado = await chamar('/api/whatsapp/silencio', { method: 'POST' });
  assert.strictEqual(encerrado.status, 200);

  const depois = await chamar('/api/whatsapp');
  assert.strictEqual(depois.corpo.silencioRestante, 0);
  assert.ok(app.store.state.events.some((e) => /Silêncio pós-conexão encerrado/.test(e.text)));

  await fechar();
});

// ---------- a recepção assume a conversa ----------

test('depois que a recepção responde, o bot cala nessa conversa', async () => {
  const { app, chamar, fechar } = await painel();
  const phone = '5511900550001';
  await app.conversa(phone, ['oi']);
  const paciente = app.store.findContactByPhone(phone);
  assert.ok(app.sent.length > 0, 'antes disso o bot atende normalmente');

  await chamar('/api/messages', {
    method: 'POST', body: { contactId: paciente.id, body: 'Oi Marina, aqui é a Ana da recepção.' },
  });
  assert.ok(app.store.getContact(paciente.id).recepcaoAssumiu, 'a conversa passa a ser da pessoa');

  app.sent.length = 0;
  await app.conversa(phone, ['quanto custa a consulta?']);
  assert.strictEqual(app.sent.length, 0, 'o robô não responde por cima da secretária');
  assert.strictEqual(app.store.messagesOf(paciente.id).filter((m) => m.direction === 'in').length, 2,
    'mas a mensagem do paciente continua registrada');

  // "Devolver ao bot" desfaz — o atendimento automático volta na hora.
  await chamar(`/api/contacts/${paciente.id}/release`, { method: 'POST' });
  await app.conversa(phone, ['quanto custa a consulta?']);
  assert.ok(app.sent.length > 0, 'devolvido ao bot, ele volta a responder');

  await fechar();
});

test('quem pediu atendente ainda volta sozinho pelo "menu"', async () => {
  const app = makeApp();
  const phone = '5511900550002';
  await app.conversa(phone, ['quero falar com a secretária']);
  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.stage, 'atendimento humano');
  assert.ok(!paciente.recepcaoAssumiu, 'ninguém da recepção respondeu ainda');

  app.sent.length = 0;
  await app.conversa(phone, ['menu']);
  assert.ok(app.sent.length > 0, 'a porta de volta ao bot continua aberta para o paciente');
});

test('a pausa pode ser desligada por quem prefere o bot sempre respondendo', async () => {
  const { app, chamar, fechar } = await painel();
  app.store.clinic.pausarQuandoRecepcaoResponde = false;

  const phone = '5511900550003';
  await app.conversa(phone, ['oi']);
  const paciente = app.store.findContactByPhone(phone);
  await chamar('/api/messages', { method: 'POST', body: { contactId: paciente.id, body: 'oi, é a Ana' } });

  app.sent.length = 0;
  await app.conversa(phone, ['quanto custa a consulta?']);
  assert.ok(app.sent.length > 0);

  await fechar();
});
