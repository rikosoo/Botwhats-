'use strict';

/**
 * LGPD na prática: exportar, apagar e não guardar para sempre.
 *
 * O consultório é o controlador desses dados. O paciente pode pedir uma cópia
 * do que existe sobre ele e pedir a exclusão — e isso precisa ser um botão, não
 * uma tarefa de banco de dados.
 *
 * Uma decisão importante na exclusão: os dados pessoais somem, mas as consultas
 * ficam **anonimizadas**. Apagar a consulta junto mudaria a taxa de falta
 * retroativamente, e o consultório passaria a confiar num número errado. O que
 * fica é data, profissional, duração e se compareceu — nada que identifique.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

/** Cópia de tudo o que o consultório guarda sobre uma pessoa. */
function exportarPaciente(store, contactId) {
  const contato = store.getContact(contactId);
  if (!contato) return null;

  return {
    geradoEm: new Date().toISOString(),
    consultorio: store.clinic.name,
    paciente: {
      nome: contato.name,
      telefone: contato.phone,
      nascimento: contato.birthDate,
      convenio: contato.insurance,
      cadastradoEm: contato.createdAt,
      situacao: contato.stage,
      recebeLembretes: !contato.optOut,
      anotacoes: contato.notes,
    },
    conversas: store.messagesOf(contactId).map((m) => ({
      quando: m.at,
      de: m.direction === 'in' ? 'paciente' : 'consultório',
      texto: m.body,
      tipo: m.meta && m.meta.mediaType ? m.meta.mediaType : 'texto',
    })),
    consultas: store.bookingsOf(contactId).map((b) => ({
      data: b.date,
      hora: b.start,
      profissional: b.professionalName,
      atendimento: b.serviceName,
      convenio: b.insurance,
      situacao: b.status,
      confirmacao: b.confirmation,
      comparecimento: b.attendance,
    })),
    lembretes: store.state.reminders
      .filter((r) => r.contactId === contactId)
      .map((r) => ({ tipo: r.kind, quando: r.dueAt, situacao: r.status })),
    listaDeEspera: store.state.waitlist
      .filter((e) => e.contactId === contactId)
      .map((e) => ({ entrouEm: e.createdAt, situacao: e.status })),
  };
}

/**
 * Apaga os dados pessoais do paciente. Devolve o resumo do que saiu.
 * As consultas permanecem, sem vínculo com pessoa alguma.
 */
function apagarPaciente(store, contactId) {
  const contato = store.getContact(contactId);
  if (!contato) return null;

  const resumo = {
    nome: contato.name || contato.phone,
    mensagens: store.messagesOf(contactId).length,
    lembretes: store.state.reminders.filter((r) => r.contactId === contactId).length,
    consultasAnonimizadas: 0,
    espera: store.state.waitlist.filter((e) => e.contactId === contactId).length,
  };

  for (const booking of store.state.bookings) {
    if (booking.contactId !== contactId) continue;
    booking.contactId = null;
    booking.anonimizado = true;
    delete booking.note;
    resumo.consultasAnonimizadas += 1;
  }

  store.state.messages = store.state.messages.filter((m) => m.contactId !== contactId);
  store.state.reminders = store.state.reminders.filter((r) => r.contactId !== contactId);
  store.state.waitlist = store.state.waitlist.filter((e) => e.contactId !== contactId);
  for (const campanha of store.state.campaigns) {
    if (Array.isArray(campanha.contactIds)) {
      campanha.contactIds = campanha.contactIds.filter((id) => id !== contactId);
    }
  }

  // A linha do tempo também cita nome e telefone: sem limpar aqui, o dado
  // continuaria visível no painel depois da exclusão.
  const nome = contato.name;
  const telefone = contato.phone;
  store.state.events = store.state.events.filter(
    (e) => !(e.text.includes(telefone) || (nome && e.text.includes(nome))),
  );

  store.state.contacts = store.state.contacts.filter((c) => c.id !== contactId);
  store.logEvent('privacidade', `Dados de um paciente foram apagados a pedido (${resumo.mensagens} mensagem(ns))`);
  store.commit('contact', null);
  return resumo;
}

/**
 * Retenção: conversa antiga não precisa ficar guardada para sempre.
 * Apaga só mensagens; cadastro e histórico de consultas continuam.
 */
function limparMensagensAntigas(store, dias) {
  if (!dias || dias <= 0) return 0;
  const limite = Date.now() - dias * DIA_MS;
  const antes = store.state.messages.length;
  store.state.messages = store.state.messages.filter(
    (m) => new Date(m.at).getTime() >= limite,
  );
  const removidas = antes - store.state.messages.length;
  if (removidas) {
    store.logEvent('privacidade', `${removidas} mensagem(ns) com mais de ${dias} dias foram apagadas`);
    store.commit('message', null);
  }
  return removidas;
}

/** Roda a limpeza de tempos em tempos. */
class Retencao {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.timer = null;
  }

  executar() {
    return limparMensagensAntigas(this.store, this.config.messageRetentionDays);
  }

  start() {
    if (this.timer) return;
    this.executar();
    this.timer = setInterval(() => this.executar(), 12 * 3600000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { exportarPaciente, apagarPaciente, limparMensagensAntigas, Retencao };
