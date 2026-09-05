'use strict';

const { formatDateLong } = require('./agenda');

const DAY_MS = 24 * 60 * 60 * 1000;

function plural(days) {
  return days === 1 ? '1 dia' : `${days} dias`;
}

class Reminders {
  /**
   * @param {import('../db/store').Store} store
   * @param {object} config
   * @param {(phone: string, text: string) => Promise<any>} send
   */
  constructor(store, config, send) {
    this.store = store;
    this.config = config;
    this.send = send;
    this.timer = null;
  }

  /**
   * Lembretes de follow-up: 1, 7 e 15 dias depois do contato, para quem ainda nao agendou.
   * Sempre reagenda a partir do contato mais recente.
   */
  scheduleFollowUps(contact, from = new Date()) {
    this.store.cancelReminders((r) => r.contactId === contact.id && r.kind === 'followup');
    const created = [];
    for (const days of this.config.followUpOffsets) {
      created.push(this.store.addReminder({
        contactId: contact.id,
        kind: 'followup',
        offsetDays: days,
        dueAt: new Date(from.getTime() + days * DAY_MS).toISOString(),
        text: null,
      }));
    }
    return created;
  }

  /** Lembretes do agendamento: 15, 7 e 1 dia antes do horario marcado. */
  scheduleBookingReminders(booking, now = new Date()) {
    const startsAt = new Date(booking.startsAt).getTime();
    const created = [];
    for (const days of this.config.bookingOffsets) {
      const dueAt = startsAt - days * DAY_MS;
      if (dueAt <= now.getTime()) continue; // janela ja passou
      created.push(this.store.addReminder({
        contactId: booking.contactId,
        bookingId: booking.id,
        kind: 'booking',
        offsetDays: days,
        dueAt: new Date(dueAt).toISOString(),
        text: null,
      }));
    }
    return created;
  }

  buildText(reminder) {
    if (reminder.text) return reminder.text;
    const contact = this.store.getContact(reminder.contactId);
    const nome = contact && contact.name ? contact.name.split(' ')[0] : 'tudo bem';

    if (reminder.kind === 'booking') {
      const booking = this.store.getBooking(reminder.bookingId);
      if (!booking) return null;
      const quando = `${formatDateLong(booking.date)} as ${booking.start}`;
      if (reminder.offsetDays === 1) {
        return `Ola ${nome}! Passando para lembrar do seu atendimento amanha, ${quando}.\n`
          + 'Responda CONFIRMAR para manter ou CANCELAR se precisar remarcar.';
      }
      return `Ola ${nome}! Faltam ${plural(reminder.offsetDays)} para o seu atendimento em ${quando}.\n`
        + 'Se precisar remarcar, e so responder CANCELAR.';
    }

    const mensagens = {
      1: `Ola ${nome}! Ontem voce falou com a ${this.config.businessName}. Posso te ajudar a escolher um horario? Responda AGENDAR para ver as opcoes.`,
      7: `Ola ${nome}! Faz uma semana que conversamos. Ainda da tempo de agendar: responda AGENDAR e eu mostro os horarios livres.`,
      15: `Ola ${nome}! Ultimo lembrete por aqui: se quiser marcar um horario com a ${this.config.businessName}, responda AGENDAR. Se preferir nao receber mais mensagens, responda SAIR.`,
    };
    return mensagens[reminder.offsetDays]
      || `Ola ${nome}! Lembrete de ${plural(reminder.offsetDays)} da ${this.config.businessName}.`;
  }

  /** Envia os lembretes vencidos. Retorna quantos foram enviados. */
  async tick(now = new Date()) {
    const due = this.store.state.reminders.filter(
      (r) => r.status === 'pending' && new Date(r.dueAt).getTime() <= now.getTime(),
    );
    let sent = 0;
    for (const reminder of due) {
      const contact = this.store.getContact(reminder.contactId);
      if (!contact || contact.optOut) {
        reminder.status = 'cancelado';
        continue;
      }
      if (reminder.kind === 'booking') {
        const booking = this.store.getBooking(reminder.bookingId);
        if (!booking || booking.status !== 'confirmado') {
          reminder.status = 'cancelado';
          continue;
        }
      }
      const text = this.buildText(reminder);
      if (!text) {
        reminder.status = 'cancelado';
        continue;
      }
      try {
        await this.send(contact.phone, text);
        reminder.status = 'enviado';
        reminder.sentAt = new Date().toISOString();
        sent += 1;
        this.store.logEvent(
          'lembrete',
          `Lembrete de ${plural(reminder.offsetDays)} enviado para ${contact.name || contact.phone}`,
        );
      } catch (err) {
        reminder.status = 'erro';
        reminder.error = err.message;
        this.store.logEvent('erro', `Falha ao enviar lembrete: ${err.message}`);
      }
    }
    if (due.length) this.store.commit('reminder', null);
    return sent;
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
