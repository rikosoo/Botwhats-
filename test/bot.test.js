'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');

/** Caminho feliz do agendamento, escrito como um paciente escreveria. */
const AGENDAR = ['oi', 'quero marcar uma consulta', 'primeira consulta', 'unimed', '1', '1', '1', 'Maria Souza', '12/05/1980', 'sim'];

test('primeira mensagem: saudação humanizada, sem menu numérico obrigatório', async () => {
  const app = makeApp();
  await app.handleIncoming({ phone: '5511900001111', name: 'Ana', body: 'oi' });
  const texto = app.textoEnviado();

  assert.match(texto, /(Bom dia|Boa tarde|Boa noite), Ana!/);
  assert.match(texto, /assistente do Consultorio Dr. Exemplo/);
  assert.doesNotMatch(texto, /Digite o n[uú]mero/i);
  assert.match(texto, /🔒/, 'envia o aviso de privacidade uma vez');
});

test('o aviso de privacidade não se repete', async () => {
  const app = makeApp();
  const phone = '5511900001112';
  await app.conversa(phone, ['oi', 'oi de novo']);
  const avisos = app.sent.filter((s) => s.text.includes('🔒')).length;
  assert.strictEqual(avisos, 1);
});

test('sinal de alarme interrompe tudo e orienta atendimento imediato', async () => {
  const app = makeApp();
  const phone = '5511900002222';
  await app.conversa(phone, ['oi', 'quero marcar', 'estou com dor no peito e falta de ar']);

  const ultima = app.ultima();
  assert.match(ultima, /192/);
  assert.match(ultima, /pronto-socorro/i);
  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.priority, 'urgente');
  assert.strictEqual(paciente.stage, 'atendimento humano');
  assert.ok(app.store.state.events.some((e) => e.type === 'urgencia'));
});

test('o bot não dá orientação clínica', async () => {
  const app = makeApp();
  const phone = '5511900002223';
  await app.conversa(phone, ['oi', 'posso tomar dipirona antes da consulta?']);
  assert.match(app.ultima(), /pergunta para o médico avaliar/i);
});

test('fluxo completo de agendamento em linguagem natural', async () => {
  const app = makeApp();
  const phone = '5511900003333';
  await app.conversa(phone, AGENDAR);

  const consulta = app.store.state.bookings[0];
  assert.ok(consulta, 'consulta criada');
  assert.strictEqual(consulta.serviceId, 'primeira-consulta');
  assert.strictEqual(consulta.insurance, 'Unimed');
  assert.strictEqual(consulta.confirmation, 'aguardando');

  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.name, 'Maria Souza');
  assert.strictEqual(paciente.birthDate, '12/05/1980');
  assert.strictEqual(paciente.stage, 'agendado');

  const texto = app.textoEnviado();
  assert.match(texto, /reservada/i);
  assert.match(texto, /Rua das Flores/, 'manda o endereço na confirmação');
  assert.match(texto, /15 minutos de antecedência/);
  assert.match(texto, /exames anteriores/, 'manda o preparo do tipo de atendimento');

  // Follow-up sai de cena e entram os lembretes da consulta.
  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  assert.ok(pendentes.length > 0);
  assert.ok(pendentes.every((r) => r.kind === 'booking'));
});

test('entende escolhas escritas: "tanto faz", nome do médico e "10h"', async () => {
  const app = makeApp();
  const phone = '5511900003334';
  await app.conversa(phone, ['bom dia', 'preciso de um retorno', 'particular', 'tanto faz']);
  assert.match(app.ultima(), /Estes são os primeiros dias/);

  await app.handleIncoming({ phone, body: 'pode ser o primeiro dia' });
  const opcoes = app.store.findContactByPhone(phone).state.data.opcoesHorarios;
  assert.ok(opcoes.length > 0);

  // "08h" é ambíguo quando existem 08:00 e 08:20: o bot pergunta em vez de chutar.
  await app.handleIncoming({ phone, body: `${opcoes[1].slice(0, 2)}h` });
  assert.match(app.ultima(), /Qual delas/);
  assert.strictEqual(app.store.findContactByPhone(phone).state.data.start, undefined);

  await app.handleIncoming({ phone, body: `às ${opcoes[1]}` });
  assert.strictEqual(app.store.findContactByPhone(phone).state.data.start, opcoes[1]);
});

test('convênio não atendido vira oferta de particular, sem travar', async () => {
  const app = makeApp();
  const phone = '5511900004444';
  await app.conversa(phone, ['oi', 'quero marcar', 'retorno', 'Golden Cross']);
  assert.match(app.ultima(), /ainda não atendemos/i);

  await app.handleIncoming({ phone, body: 'pode ser particular então' });
  assert.match(app.ultima(), /(dias|profissional|prefere)/i);
  assert.strictEqual(app.store.findContactByPhone(phone).state.data.insurance, 'Particular');
});

test('dúvidas de convênio, endereço e valores não perdem o agendamento em curso', async () => {
  const app = makeApp();
  const phone = '5511900005555';
  await app.conversa(phone, ['oi', 'quero marcar', 'primeira consulta', 'onde fica o consultório?']);

  assert.match(app.ultima(), /Voltando ao agendamento/);
  assert.strictEqual(app.store.findContactByPhone(phone).state.step, 'agendar_convenio');
});

test('confirmação de presença registra na consulta', async () => {
  const app = makeApp();
  const phone = '5511900006666';
  await app.conversa(phone, AGENDAR);
  await app.handleIncoming({ phone, body: 'confirmo minha presença' });

  assert.strictEqual(app.store.state.bookings[0].confirmation, 'confirmado');
  assert.match(app.ultima(), /Presença confirmada/);
});

test('remarcar libera o horário antigo e recomeça a escolha', async () => {
  const app = makeApp();
  const phone = '5511900007777';
  await app.conversa(phone, AGENDAR);
  const antiga = app.store.state.bookings[0];

  await app.handleIncoming({ phone, body: 'preciso remarcar' });
  assert.strictEqual(app.store.getBooking(antiga.id).status, 'cancelado');
  assert.match(app.ultima(), /(dias|horário)/i);

  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.state.data.serviceId, 'primeira-consulta');
  assert.strictEqual(paciente.state.data.insurance, 'Unimed');
});

test('cancelar devolve o paciente ao ciclo de follow-up 1/7/15', async () => {
  const app = makeApp();
  const phone = '5511900008888';
  await app.conversa(phone, AGENDAR);
  await app.handleIncoming({ phone, body: 'não vou poder ir, quero cancelar' });

  assert.strictEqual(app.store.state.bookings[0].status, 'cancelado');
  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  assert.deepStrictEqual(pendentes.map((r) => r.offsetDays), [1, 7, 15]);
});

test('pede atendente e o bot silencia até chamarem "menu"', async () => {
  const app = makeApp();
  const phone = '5511900009999';
  await app.conversa(phone, ['oi', 'quero falar com a secretária']);
  const antes = app.sent.length;

  await app.handleIncoming({ phone, body: 'obrigada, aguardo' });
  assert.strictEqual(app.sent.length, antes, 'o bot não atropela o atendimento humano');

  await app.handleIncoming({ phone, body: 'menu' });
  assert.ok(app.sent.length > antes);
});

test('depois de três mensagens sem entender, chama gente de verdade', async () => {
  const app = makeApp();
  const phone = '5511900010000';
  await app.conversa(phone, ['oi', 'xyzabc', 'plft', 'wqwq']);

  assert.match(app.ultima(), /secretária/i);
  assert.strictEqual(app.store.findContactByPhone(phone).stage, 'atendimento humano');
});

test('"sair" encerra os lembretes e o bot respeita', async () => {
  const app = makeApp();
  const phone = '5511900011111';
  await app.conversa(phone, ['oi', 'não quero mais receber mensagens']);

  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.optOut, true);
  assert.strictEqual(app.store.state.reminders.filter((r) => r.status === 'pending').length, 0);
  assert.match(app.ultima(), /não vou mais enviar lembretes/i);
});

test('responde dúvidas frequentes sem precisar de menu', async () => {
  const app = makeApp();
  const phone = '5511900012222';
  await app.conversa(phone, ['oi']);

  await app.handleIncoming({ phone, body: 'vocês atendem unimed?' });
  assert.match(app.ultima(), /Unimed/);

  await app.handleIncoming({ phone, body: 'quanto custa particular?' });
  assert.match(app.textoEnviado(), /R\$ 400/);

  await app.handleIncoming({ phone, body: 'preciso de jejum?' });
  assert.match(app.ultima(), /jejum/i);

  await app.handleIncoming({ phone, body: 'o que preciso levar?' });
  assert.match(app.ultima(), /carteirinha/i);
});

test('urgência e fila humana não recebem follow-up de marketing', async () => {
  const app = makeApp();
  const urgente = '5511900013333';
  await app.conversa(urgente, ['oi', 'estou com falta de ar']);
  assert.strictEqual(
    app.store.state.reminders.filter((r) => r.status === 'pending' && r.kind === 'followup').length,
    0,
  );

  const fila = '5511900014444';
  await app.conversa(fila, ['oi', 'quero falar com a recepção']);
  const doFila = app.store.findContactByPhone(fila);
  assert.strictEqual(
    app.store.state.reminders.filter((r) => r.contactId === doFila.id && r.status === 'pending').length,
    0,
  );
});

test('dúvida depois da consulta vai para a fila da recepção, não para o vazio', async () => {
  const app = makeApp();
  const phone = '5511900015555';
  await app.conversa(phone, AGENDAR);

  // A recepção registra o comparecimento.
  const consulta = app.store.state.bookings[0];
  consulta.attendance = 'compareceu';
  consulta.startsAt = new Date(Date.now() - 86400000).toISOString();

  await app.handleIncoming({ phone, body: 'fiquei com dúvida sobre o remédio que a doutora passou' });

  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.stage, 'atendimento humano');
  assert.match(app.ultima(), /passei para a equipe/i);
  assert.doesNotMatch(app.ultima(), /marque|agendar/i, 'não empurra consulta para quem acabou de ir');
  assert.ok(app.store.state.events.some((e) => e.type === 'handoff' && /dúvida após a consulta/.test(e.text)));
});

test('quem ainda não foi atendido recebe a orientação padrão', async () => {
  const app = makeApp();
  const phone = '5511900016666';
  await app.conversa(phone, ['oi', 'posso tomar dipirona antes?']);
  assert.match(app.ultima(), /pergunta para o médico avaliar/i);
  assert.strictEqual(app.store.findContactByPhone(phone).stage, 'ativo');
});

test('preço vem com o pacote inteiro e termina em dois horários concretos', async () => {
  const app = makeApp();
  const phone = '5511900017777';
  await app.conversa(phone, ['oi', 'quanto custa a consulta?']);

  const resposta = app.sent.slice(-2).map((m) => m.text).join('\n');
  assert.match(resposta, /R\$ 400,00/, 'diz o valor');
  assert.match(resposta, /40 minutos/, 'diz a duração');
  assert.match(resposta, /retorno em ate 30 dias/i, 'diz que o retorno está incluso');
  assert.match(resposta, /Pix/, 'diz as formas de pagamento');
  assert.match(resposta, /\*1\.\*.+\n\*2\.\*/, 'oferece dois horários específicos');
  assert.doesNotMatch(resposta, /temos vaga essa semana/i);

  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.state.step, 'oferta');
  assert.strictEqual(paciente.state.data.opcoes.length, 2);
});

test('aceitar um dos horários oferecidos leva direto ao cadastro', async () => {
  const app = makeApp();
  const phone = '5511900018888';
  await app.conversa(phone, ['oi', 'qual o valor?', 'pode ser o segundo', 'Joana Prado Lima', '10/10/1980', 'sim']);

  const consulta = app.store.state.bookings[0];
  assert.ok(consulta, 'consulta criada a partir da conversa de preço');
  assert.strictEqual(consulta.serviceId, 'primeira-consulta');
  assert.strictEqual(app.store.findContactByPhone(phone).name, 'Joana Prado Lima');
});

test('recusar os dois horários volta para a escolha normal de dia', async () => {
  const app = makeApp();
  const phone = '5511900019999';
  await app.conversa(phone, ['oi', 'quanto custa?', 'nenhum desses, prefiro outro dia']);
  assert.match(app.ultima(), /convênio ou particular/i, 'segue o agendamento normal');

  await app.handleIncoming({ phone, body: 'particular' });
  assert.match(app.ultima(), /prefere|primeiros dias/i);
  assert.ok(app.store.findContactByPhone(phone).state.step.startsWith('agendar_'));
});

test('"sim" depois do lembrete de véspera confirma presença, não abre novo agendamento', async () => {
  const app = makeApp();
  const phone = '5511900020000';
  await app.conversa(phone, AGENDAR);
  app.sent.length = 0;

  await app.handleIncoming({ phone, body: 'sim' });
  assert.strictEqual(app.store.state.bookings[0].confirmation, 'confirmado');
  assert.match(app.ultima(), /Presença confirmada/);
  assert.strictEqual(app.store.state.bookings.length, 1, 'não criou consulta nova');
});

test('"não" avisa a recepção de que a vaga vai sobrar', async () => {
  const app = makeApp();
  const phone = '5511900021111';
  await app.conversa(phone, AGENDAR);

  await app.handleIncoming({ phone, body: 'não' });
  assert.strictEqual(app.store.state.bookings[0].confirmation, 'recusado');
  assert.match(app.ultima(), /Obrigada por avisar/);
  assert.match(app.ultima(), /outra data|cancelar/i);
  assert.ok(app.store.state.events.some((e) => /avisou que não vem/.test(e.text)));
});

test('convênio suspenso tem resposta própria, diferente de "não atendemos"', async () => {
  const app = makeApp();
  const phone = '5511900022222';
  // Amil está cadastrada, porém com credenciamento suspenso.
  await app.conversa(phone, ['oi', 'quero marcar', 'retorno', 'amil']);

  assert.match(app.ultima(), /credenciamento está suspenso/i);
  assert.doesNotMatch(app.ultima(), /nunca|não atendemos amil/i);

  await app.handleIncoming({ phone, body: 'pode ser particular' });
  assert.strictEqual(app.store.findContactByPhone(phone).state.data.insurance, 'Particular');
});

test('convênio suspenso não aparece na lista oferecida', async () => {
  const app = makeApp();
  const phone = '5511900023333';
  await app.conversa(phone, ['oi', 'quero marcar', 'retorno']);

  assert.match(app.ultima(), /Unimed/);
  assert.doesNotMatch(app.ultima(), /Amil/);
});

test('consultório só particular não pergunta convênio', async () => {
  const app = makeApp();
  app.store.clinic.acceptsInsurance = false;
  const phone = '5511900024444';

  await app.conversa(phone, ['oi', 'quero marcar uma consulta', 'primeira consulta']);
  assert.doesNotMatch(app.ultima(), /convênio ou particular/i);
  assert.match(app.ultima(), /prefere|primeiros dias/i, 'já vai para profissional ou dia');
  assert.strictEqual(app.store.findContactByPhone(phone).state.data.insurance, 'Particular');
});

test('no modo particular a pergunta de convênio é respondida direto', async () => {
  const app = makeApp();
  app.store.clinic.acceptsInsurance = false;
  const phone = '5511900025555';

  await app.conversa(phone, ['oi', 'vocês atendem unimed?']);
  assert.match(app.ultima(), /apenas em regime particular/i);
  assert.match(app.ultima(), /R\$ 400/);
});

test('áudio não cai no vazio: responde e chama a recepção', async () => {
  const app = makeApp();
  const phone = '5511900026666';
  await app.conversa(phone, ['oi']);
  app.sent.length = 0;

  await app.handleIncoming({ phone, body: '', mediaType: 'audio' });

  assert.match(app.ultima(), /só consigo ler mensagens escritas/i);
  assert.match(app.ultima(), /recepção/i);
  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.stage, 'atendimento humano');
  assert.ok(app.store.state.events.some((e) => e.type === 'midia' && /audio/.test(e.text)));

  // A mensagem fica no histórico marcada como mídia, sem guardar o conteúdo.
  const registro = app.store.messagesOf(paciente.id).slice(-2)[0];
  assert.strictEqual(registro.meta.mediaType, 'audio');
  assert.strictEqual(registro.body, '[audio]');
});

test('foto avisa para não mandar exame por mensagem', async () => {
  const app = makeApp();
  const phone = '5511900027777';
  await app.conversa(phone, ['oi']);
  await app.handleIncoming({ phone, body: '', mediaType: 'imagem' });

  assert.match(app.ultima(), /encaminhei para a recepção/i);
  assert.match(app.ultima(), /evite mandar exames/i);
});

test('figurinha não ocupa a recepção', async () => {
  const app = makeApp();
  const phone = '5511900028888';
  await app.conversa(phone, ['oi']);
  await app.handleIncoming({ phone, body: '', mediaType: 'figurinha' });

  assert.match(app.ultima(), /Recebi!/);
  assert.notStrictEqual(app.store.findContactByPhone(phone).stage, 'atendimento humano');
});
