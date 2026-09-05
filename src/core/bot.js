'use strict';

const { formatDateLong, formatDateBr, timeKey } = require('./agenda');

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function saudacaoDoDia(timezone, now = new Date()) {
  const hora = Number(timeKey(now, timezone).slice(0, 2));
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const MENU = [
  '*1* - Agendar um horario',
  '*2* - Ver meus agendamentos',
  '*3* - Ver horarios disponiveis',
  '*4* - Falar com um atendente',
  '*0* - Encerrar o atendimento',
].join('\n');

class Bot {
  /**
   * @param {import('../db/store').Store} store
   * @param {import('./agenda').Agenda} agenda
   * @param {import('./reminders').Reminders} reminders
   * @param {object} config
   */
  constructor(store, agenda, reminders, config) {
    this.store = store;
    this.agenda = agenda;
    this.reminders = reminders;
    this.config = config;
    this.outbox = [];
  }

  /** Ponto de entrada: recebe uma mensagem e devolve as respostas do bot. */
  async handleIncoming({ phone, name, body }) {
    const contact = this.store.upsertContact(phone, name);
    const primeiraMensagem = this.store.messagesOf(contact.id).length === 0;
    this.store.addMessage(contact.id, 'in', body);

    const replies = await this.route(contact, body, primeiraMensagem);

    // Enquanto o lead nao agendar, o relogio de 1/7/15 dias reinicia a cada contato.
    if (!this.store.bookingsOf(contact.id).some((b) => b.status === 'confirmado') && !contact.optOut) {
      this.reminders.scheduleFollowUps(contact);
    }
    this.store.commit('contact', contact);
    return replies;
  }

  async route(contact, body, primeiraMensagem) {
    const texto = normalize(body);
    const step = contact.state.step || 'inicio';

    if (['sair', 'parar', 'stop', 'descadastrar'].includes(texto)) {
      contact.optOut = true;
      contact.stage = 'opt-out';
      contact.state = { step: 'inicio', data: {} };
      this.store.cancelReminders((r) => r.contactId === contact.id);
      this.store.logEvent('opt-out', `${contact.name || contact.phone} pediu para nao receber mais mensagens`);
      return ['Tudo bem, nao vou mais enviar lembretes. Se mudar de ideia, e so mandar uma mensagem por aqui. 👋'];
    }

    if (contact.optOut && texto) {
      contact.optOut = false;
      contact.stage = 'ativo';
    }

    if (['menu', 'inicio', 'voltar'].includes(texto)) {
      contact.state = { step: 'menu', data: {} };
      return [`Sem problemas! O que voce prefere?\n\n${MENU}`];
    }

    if (['agendar', 'agenda', 'marcar'].includes(texto)) {
      return this.iniciarAgendamento(contact);
    }

    if (texto === 'cancelar') {
      return this.cancelarAgendamento(contact);
    }

    if (texto === 'confirmar' && step !== 'confirmar') {
      const proximo = this.proximoAgendamento(contact);
      if (proximo) {
        return [`Presenca confirmada para ${formatDateLong(proximo.date)} as ${proximo.start}. Ate la! ✅`];
      }
    }

    if (primeiraMensagem || step === 'inicio') {
      return this.saudar(contact);
    }

    switch (step) {
      case 'menu':
        return this.tratarMenu(contact, texto);
      case 'escolher_dia':
        return this.tratarDia(contact, texto);
      case 'escolher_horario':
        return this.tratarHorario(contact, texto);
      case 'pedir_nome':
        return this.tratarNome(contact, body);
      case 'confirmar':
        return this.tratarConfirmacao(contact, texto);
      case 'atendente':
        return []; // conversa transferida: o bot fica em silencio
      default:
        return this.saudar(contact);
    }
  }

  saudar(contact) {
    contact.state = { step: 'menu', data: {} };
    if (contact.stage === 'novo') contact.stage = 'ativo';
    const saudacao = saudacaoDoDia(this.config.timezone);
    const nome = contact.name ? `, ${contact.name.split(' ')[0]}` : '';
    this.store.logEvent('saudacao', `Saudacao enviada para ${contact.name || contact.phone}`);
    return [
      `${saudacao}${nome}! 👋 Eu sou o assistente virtual da *${this.config.businessName}*.`,
      `Posso te ajudar com:\n\n${MENU}\n\n_Digite o numero da opcao desejada._`,
    ];
  }

  tratarMenu(contact, texto) {
    if (texto === '1') return this.iniciarAgendamento(contact);
    if (texto === '2') return this.meusAgendamentos(contact);
    if (texto === '3') return this.mostrarDisponibilidade(contact);
    if (texto === '4') {
      contact.state = { step: 'atendente', data: {} };
      contact.stage = 'atendimento humano';
      this.store.logEvent('handoff', `${contact.name || contact.phone} pediu atendimento humano`);
      return ['Certo! Ja avisei a nossa equipe e em breve alguem assume esta conversa. 🙂\n\nSe quiser voltar ao menu automatico, digite *MENU*.'];
    }
    if (texto === '0') {
      contact.state = { step: 'inicio', data: {} };
      return ['Atendimento encerrado. Quando precisar, e so chamar. 😊'];
    }
    return [`Nao entendi essa opcao. Escolha um numero:\n\n${MENU}`];
  }

  iniciarAgendamento(contact) {
    const dias = this.agenda.nextAvailableDays(5);
    if (!dias.length) {
      contact.state = { step: 'menu', data: {} };
      return ['No momento nao tenho horarios livres nos proximos dias. 😕 Nossa equipe entra em contato assim que abrir uma vaga.'];
    }
    contact.state = { step: 'escolher_dia', data: { dias: dias.map((d) => d.date) } };
    const linhas = dias.map((d, i) => `*${i + 1}* - ${formatDateLong(d.date)} (${d.slots.length} horarios)`);
    return [`Otimo! Escolha o melhor dia para voce:\n\n${linhas.join('\n')}\n\n_Digite o numero do dia ou *MENU* para voltar._`];
  }

  tratarDia(contact, texto) {
    const dias = contact.state.data.dias || [];
    const escolhido = dias[Number(texto) - 1] || (dias.includes(texto) ? texto : null);
    if (!escolhido) {
      const linhas = dias.map((d, i) => `*${i + 1}* - ${formatDateLong(d)}`);
      return [`Nao encontrei esse dia. Escolha uma das opcoes:\n\n${linhas.join('\n')}`];
    }
    const slots = this.agenda.slotsFor(escolhido);
    if (!slots.length) return this.iniciarAgendamento(contact);

    contact.state = { step: 'escolher_horario', data: { date: escolhido, slots: slots.map((s) => s.start) } };
    const linhas = slots.map((s, i) => `*${i + 1}* - ${s.start} as ${s.end}`);
    return [`Horarios livres em ${formatDateLong(escolhido)}:\n\n${linhas.join('\n')}\n\n_Digite o numero do horario ou *VOLTAR*._`];
  }

  tratarHorario(contact, texto) {
    const { date, slots = [] } = contact.state.data;
    const escolhido = slots[Number(texto) - 1] || (slots.includes(texto) ? texto : null);
    if (!escolhido) {
      const linhas = slots.map((s, i) => `*${i + 1}* - ${s}`);
      return [`Nao identifiquei esse horario. Opcoes para ${formatDateBr(date)}:\n\n${linhas.join('\n')}`];
    }
    if (!contact.name) {
      contact.state = { step: 'pedir_nome', data: { date, start: escolhido } };
      return ['Quase la! Como voce se chama? (nome completo)'];
    }
    contact.state = { step: 'confirmar', data: { date, start: escolhido } };
    return [`Confirmando: *${formatDateLong(date)} as ${escolhido}* em nome de *${contact.name}*.\n\nResponda *SIM* para confirmar ou *VOLTAR* para escolher outro horario.`];
  }

  tratarNome(contact, body) {
    const nome = String(body || '').trim();
    if (nome.length < 2) return ['Pode me dizer seu nome, por favor?'];
    contact.name = nome;
    const { date, start } = contact.state.data;
    contact.state = { step: 'confirmar', data: { date, start } };
    return [`Obrigado, ${nome.split(' ')[0]}! Confirmando: *${formatDateLong(date)} as ${start}*.\n\nResponda *SIM* para confirmar ou *VOLTAR* para escolher outro horario.`];
  }

  tratarConfirmacao(contact, texto) {
    if (!['sim', 's', 'confirmar', 'ok', 'isso', 'confirmo'].includes(texto)) {
      if (['nao', 'n'].includes(texto)) return this.iniciarAgendamento(contact);
      return ['Responda *SIM* para confirmar ou *VOLTAR* para escolher outro horario.'];
    }
    const { date, start } = contact.state.data;
    let booking;
    try {
      booking = this.agenda.book(contact.id, date, start);
    } catch {
      return this.iniciarAgendamento(contact).map((m, i) => (i === 0
        ? `Poxa, esse horario acabou de ser preenchido. 😕\n\n${m}`
        : m));
    }

    contact.stage = 'agendado';
    contact.state = { step: 'menu', data: {} };
    this.store.cancelReminders((r) => r.contactId === contact.id && r.kind === 'followup');
    const criados = this.reminders.scheduleBookingReminders(booking);
    this.store.logEvent(
      'agendamento',
      `${contact.name || contact.phone} agendou ${formatDateBr(date)} as ${start}`,
    );

    const aviso = criados.length
      ? `Vou te lembrar ${criados.map((r) => `${r.offsetDays}d`).join(', ')} antes.`
      : 'Ate la!';
    return [
      `Agendamento confirmado! ✅\n\n📅 ${formatDateLong(date)}\n🕒 ${booking.start} as ${booking.end}\n👤 ${contact.name}\n\n${aviso}`,
      'Se precisar remarcar, responda *CANCELAR* a qualquer momento. Para outras opcoes, digite *MENU*.',
    ];
  }

  proximoAgendamento(contact) {
    const agora = Date.now();
    return this.store
      .bookingsOf(contact.id)
      .filter((b) => b.status === 'confirmado' && new Date(b.startsAt).getTime() >= agora)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0] || null;
  }

  meusAgendamentos(contact) {
    const proximos = this.store
      .bookingsOf(contact.id)
      .filter((b) => b.status === 'confirmado')
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    if (!proximos.length) {
      contact.state = { step: 'menu', data: {} };
      return ['Voce ainda nao tem horarios marcados. Digite *1* para agendar. 🙂'];
    }
    const linhas = proximos.map((b) => `📅 ${formatDateLong(b.date)} as ${b.start}`);
    return [`Seus agendamentos:\n\n${linhas.join('\n')}\n\nPara desmarcar, responda *CANCELAR*.`];
  }

  mostrarDisponibilidade(contact) {
    const dias = this.agenda.nextAvailableDays(5);
    contact.state = { step: 'menu', data: {} };
    if (!dias.length) return ['Nao ha horarios livres nos proximos dias.'];
    const blocos = dias.map(
      (d) => `*${formatDateLong(d.date)}*\n${d.slots.map((s) => s.start).join(' · ')}`,
    );
    return [`Estes sao os horarios disponiveis:\n\n${blocos.join('\n\n')}\n\nDigite *AGENDAR* para reservar um deles.`];
  }

  cancelarAgendamento(contact) {
    const proximo = this.proximoAgendamento(contact);
    if (!proximo) {
      contact.state = { step: 'menu', data: {} };
      return ['Nao encontrei nenhum horario marcado no seu nome. Digite *MENU* para ver as opcoes.'];
    }
    this.agenda.cancel(proximo.id);
    contact.stage = 'ativo';
    contact.state = { step: 'menu', data: {} };
    this.reminders.scheduleFollowUps(contact);
    this.store.logEvent(
      'cancelamento',
      `${contact.name || contact.phone} cancelou ${formatDateBr(proximo.date)} as ${proximo.start}`,
    );
    return [`Agendamento de ${formatDateLong(proximo.date)} as ${proximo.start} cancelado. 🗑️\n\nQuer escolher outro horario? Digite *AGENDAR*.`];
  }
}

module.exports = { Bot, normalize, saudacaoDoDia, MENU };
