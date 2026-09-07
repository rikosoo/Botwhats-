'use strict';

const M = require('./messages');
const { findService } = require('../clinic');

const DAY_MS = 24 * 60 * 60 * 1000;

class Reminders {
  /**
   * @param {import('../db/store').Store} store
   * @param {object} config
   * @param {(phone: string, text: string) => Promise<any>} send
   */
  constructor(store, config, send, agenda = null) {
    this.store = store;
    this.config = config;
    this.send = send;
    this.agenda = agenda;
    this.timer = null;
  }

  /** A agenda está cheia de verdade nos próximos dias? */
  agendaCheia() {
    if (!this.agenda) return false;
    const limite = this.regra('scarcityThreshold', this.config.scarcityThreshold || 80);
    return this.agenda.ocupacao(7).percentual >= limite;
  }

  get clinic() {
    return this.store.clinic;
  }

  /** Regra do painel quando existir; senão, a do .env. */
  regra(nome, padrao) {
    const doPainel = this.clinic.reminders ? this.clinic.reminders[nome] : undefined;
    return doPainel === undefined || doPainel === null ? padrao : doPainel;
  }

  /**
   * Este lembrete vale para este paciente?
   *
   * A régua é do consultório, mas o paciente é caso a caso: tem quem peça
   * "me avisa só na véspera", tem o que já ligou confirmando. Desmarcar um
   * lembrete na ficha dele não muda a regra geral nem mexe em mais ninguém.
   * A lista guarda o que foi desligado — assim, quem nunca foi tocado tem
   * tudo ligado, que é o padrão.
   */
  permitido(contato, kind, offsetDays = null) {
    if (!contato) return false;
    const desligados = contato.lembretesDesligados;
    if (!Array.isArray(desligados) || !desligados.length) return true;
    return !desligados.includes(kind)
      && !(offsetDays !== null && desligados.includes(`${kind}:${offsetDays}`));
  }

  /**
   * Follow-up de quem procurou o consultório e não marcou: 1, 7 e 15 dias
   * depois do contato. Reagenda a partir da conversa mais recente.
   */
  scheduleFollowUps(contact, from = new Date()) {
    this.store.cancelReminders((r) => r.contactId === contact.id && r.kind === 'followup');
    return this.regra('followUp', this.config.followUpOffsets)
      .filter((days) => this.permitido(contact, 'followup', days))
      .map((days) => this.store.addReminder({
        contactId: contact.id,
        kind: 'followup',
        offsetDays: days,
        dueAt: new Date(from.getTime() + days * DAY_MS).toISOString(),
      }));
  }

  /**
   * Lembretes da consulta: 15, 7 e 1 dia antes (o de 1 dia pede confirmação),
   * mais um toque no meio da espera quando a consulta foi marcada com folga.
   */
  scheduleBookingReminders(booking, now = new Date()) {
    const startsAt = new Date(booking.startsAt).getTime();
    const criados = [];
    const contato = this.store.getContact(booking.contactId);
    for (const days of this.regra('booking', this.config.bookingOffsets)) {
      const dueAt = startsAt - days * DAY_MS;
      if (dueAt <= now.getTime()) continue; // a janela já passou
      if (!this.permitido(contato, 'booking', days)) continue;
      criados.push(this.store.addReminder({
        contactId: booking.contactId,
        bookingId: booking.id,
        kind: 'booking',
        offsetDays: days,
        dueAt: new Date(dueAt).toISOString(),
      }));
    }

    const espera = this.esperaNoMeio(booking, criados, now);
    if (espera) criados.push(espera);
    return criados;
  }

  /**
   * Consulta marcada com folga é a que mais some da agenda do paciente: ele
   * marca e passa dias sem notícia. Este toque cai no meio do caminho entre a
   * marcação e a consulta — desde que não esbarre em outro lembrete já previsto.
   */
  esperaNoMeio(booking, jaCriados, now = new Date()) {
    if (!this.permitido(this.store.getContact(booking.contactId), 'espera')) return null;
    const inicio = new Date(booking.createdAt || now).getTime();
    const startsAt = new Date(booking.startsAt).getTime();

    // O que este toque cobre é o silêncio entre marcar e o primeiro lembrete —
    // não a espera inteira. Com a régua de 7 e 3 dias, quem marca para daqui a
    // dez dias já tem notícia cedo e não precisa de mais uma mensagem.
    const primeiro = jaCriados.length
      ? Math.min(...jaCriados.map((r) => new Date(r.dueAt).getTime()))
      : startsAt;
    const silencio = primeiro - inicio;
    if (silencio < (this.config.waitTouchMinDays || 10) * DAY_MS) return null;

    const meio = inicio + silencio / 2;
    if (meio <= now.getTime() + 12 * 3600000) return null;

    return this.store.addReminder({
      contactId: booking.contactId,
      bookingId: booking.id,
      kind: 'espera',
      offsetDays: Math.max(1, Math.round((startsAt - meio) / DAY_MS)),
      dueAt: new Date(meio).toISOString(),
    });
  }

  /**
   * Check-in no dia seguinte à consulta, criado quando a recepção marca
   * comparecimento. Se o momento já passou, não força uma mensagem fora de hora.
   */
  scheduleCheckIn(booking, now = new Date()) {
    const dueAt = new Date(booking.startsAt).getTime() + DAY_MS;
    if (dueAt <= now.getTime()) return null;
    if (!this.permitido(this.store.getContact(booking.contactId), 'pos_consulta')) return null;
    return this.store.addReminder({
      contactId: booking.contactId,
      bookingId: booking.id,
      kind: 'pos_consulta',
      offsetDays: 1,
      dueAt: new Date(dueAt).toISOString(),
    });
  }

  /** Retorno sugerido depois da consulta (usa returnDays do tipo de atendimento). */
  scheduleReturnReminder(booking, now = new Date()) {
    const service = findService(this.clinic, booking.serviceId);
    const dias = service && service.returnDays ? service.returnDays : 0;
    if (!dias) return null;
    if (!this.permitido(this.store.getContact(booking.contactId), 'retorno')) return null;
    return this.store.addReminder({
      contactId: booking.contactId,
      bookingId: booking.id,
      kind: 'retorno',
      offsetDays: dias,
      dueAt: new Date(new Date(booking.startsAt).getTime() + dias * DAY_MS).toISOString(),
    });
  }

  /** Falta: mensagem de reaproximação no dia seguinte. */
  scheduleNoShowReminder(booking, now = new Date()) {
    if (!this.permitido(this.store.getContact(booking.contactId), 'falta')) return null;
    return this.store.addReminder({
      contactId: booking.contactId,
      bookingId: booking.id,
      kind: 'falta',
      offsetDays: 1,
      dueAt: new Date(now.getTime() + DAY_MS).toISOString(),
    });
  }

  textoDe(reminder) {
    const contato = this.store.getContact(reminder.contactId);
    if (!contato) return null;
    if (reminder.text) return reminder.text; // disparo com texto próprio da recepção

    if (reminder.kind === 'booking' || reminder.kind === 'espera') {
      const consulta = this.store.getBooking(reminder.bookingId);
      if (!consulta) return null;
      const service = findService(this.clinic, consulta.serviceId);
      return reminder.kind === 'espera'
        ? M.lembreteEspera(this.clinic, contato, consulta, service)
        : M.lembreteConsulta(this.clinic, contato, consulta, reminder.offsetDays, service);
    }
    if (reminder.kind === 'pos_consulta') return M.checkInPosConsulta(this.clinic, contato);
    if (reminder.kind === 'retorno') return M.lembreteRetorno(this.clinic, contato, reminder.offsetDays);
    if (reminder.kind === 'campanha') return null; // sem texto salvo, não inventa mensagem
    if (reminder.kind === 'falta') return M.lembreteFalta(this.clinic, contato);
    return M.lembreteFollowUp(this.clinic, contato, reminder.offsetDays, this.agendaCheia());
  }

  /** Um lembrete só sai se ainda fizer sentido para o paciente. */
  aindaVale(reminder) {
    const contato = this.store.getContact(reminder.contactId);
    if (!contato || contato.optOut) return false;
    // Desmarcar na ficha vale também para o que já estava agendado — senão o
    // lembrete que a recepção acabou de desligar sairia mesmo assim.
    if (reminder.kind !== 'campanha' && !this.permitido(contato, reminder.kind, reminder.offsetDays)) {
      return false;
    }
    if (reminder.kind === 'followup' && this.store.state.bookings.some(
      (b) => b.contactId === contato.id && b.status === 'confirmado' && new Date(b.startsAt) >= new Date(),
    )) return false; // já marcou nesse meio tempo
    if (reminder.kind === 'campanha') return true; // já passou pelas regras do disparo
    if (['booking', 'espera', 'falta', 'pos_consulta'].includes(reminder.kind)) {
      const consulta = this.store.getBooking(reminder.bookingId);
      if (!consulta) return false;
      if (['booking', 'espera'].includes(reminder.kind) && consulta.status !== 'confirmado') return false;
      // O check-in só faz sentido para quem realmente esteve na consulta.
      if (reminder.kind === 'pos_consulta' && consulta.attendance !== 'compareceu') return false;
    }
    return true;
  }

  /** Envia os lembretes vencidos. Devolve quantos saíram. */
  async tick(now = new Date()) {
    const vencidos = this.store.state.reminders.filter(
      (r) => r.status === 'pending' && new Date(r.dueAt).getTime() <= now.getTime(),
    );
    let enviados = 0;

    for (const reminder of vencidos) {
      if (!this.aindaVale(reminder)) {
        reminder.status = 'cancelado';
        continue;
      }
      const texto = this.textoDe(reminder);
      if (!texto) {
        reminder.status = 'cancelado';
        continue;
      }
      const contato = this.store.getContact(reminder.contactId);
      try {
        await this.send(contato.phone, texto);
        reminder.status = 'enviado';
        reminder.sentAt = new Date().toISOString();
        enviados += 1;

        // O lembrete de véspera abre a janela de confirmação de presença.
        if (reminder.kind === 'booking' && reminder.offsetDays === 1) {
          const consulta = this.store.getBooking(reminder.bookingId);
          if (consulta && consulta.confirmation === 'aguardando') {
            consulta.confirmation = 'pedido';
            this.store.commit('booking', consulta);
          }
        }
        this.store.logEvent('lembrete', `${this.rotulo(reminder)} enviado para ${contato.name || contato.phone}`);
      } catch (err) {
        reminder.status = 'erro';
        reminder.error = err.message;
        this.store.logEvent('erro', `Falha ao enviar lembrete: ${err.message}`);
      }
    }
    if (vencidos.length) this.store.commit('reminder', null);
    return enviados;
  }

  rotulo(reminder) {
    const dias = reminder.offsetDays === 1 ? '1 dia' : `${reminder.offsetDays} dias`;
    if (reminder.kind === 'booking') return `Lembrete de consulta (${dias} antes)`;
    if (reminder.kind === 'espera') return 'Toque no meio da espera';
    if (reminder.kind === 'pos_consulta') return 'Check-in do dia seguinte';
    if (reminder.kind === 'retorno') return `Lembrete de retorno (${dias})`;
    if (reminder.kind === 'falta') return 'Mensagem de falta';
    if (reminder.kind === 'campanha') return 'Disparo da recepção';
    return `Follow-up de ${dias}`;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[lembretes]', err));
    }, this.config.schedulerIntervalMs);
    this.tick().catch((err) => console.error('[lembretes]', err));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Reminders, DAY_MS };
